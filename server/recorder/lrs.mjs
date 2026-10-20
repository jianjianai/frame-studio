// The lrs.v4 shipping client (log-record-sass docs/protocol.md §6): a small pool
// of WebSocket connections that carry recorded HTTP calls to the log station.
// Capture is best-effort and must never block or fail the agent's request, so
// every method here only copies bytes and enqueues frames — no awaiting, and a
// bounded memory budget drops records instead of pushing back.
import { WebSocket } from "ws";
import * as wire from "./wire.mjs";

const CHUNK = 256 * 1024; // body frame size (well under the default 1 MiB limit)
const RETRY_DELAYS = [1000, 5000, 15000]; // backoff for a retryable REJECT
const MAX_RETRIES = 3;
const MAX_RECORD_AGE = 30 * 60 * 1000; // give up on a record unacked this long
const ACK_TIMEOUT = 60 * 1000; // END sent but no ACK: the connection is stuck
const PING_INTERVAL = 30 * 1000;

class Record {
  constructor(client, id) {
    this.client = client;
    this.id = id;
    this.key = id.toString("hex");
    this.frames = []; // all frames from BEGIN, kept until ACK for resend
    this.sent = 0; // how many of frames are on the wire of the current connection
    this.bytes = 0; // held frame bytes, charged to the budget
    this.conn = null;
    this.settled = false;
    this.replayable = true;
    this.finished = false; // END emitted
    this.bornAt = Date.now();
    this.endedAt = 0;
    this.retries = 0;
    this.reqBytes = 0;
    this.respBytes = 0;
    this.reqPending = [];
    this.reqPendingLen = 0;
    this.respPending = [];
    this.respPendingLen = 0;
  }

  requestBody(buf) {
    if (this.finished || this.settled || !buf?.length) return;
    this.reqPending.push(buf);
    this.reqPendingLen += buf.length;
    if (this.reqPendingLen >= CHUNK) this.#flush("req", false);
  }
  responseHead(meta) {
    if (this.finished || this.settled) return;
    this.#flush("req", true);
    this.#emit(wire.jsonFrame(wire.RESPONSE_HEAD, this.id, meta));
  }
  responseBody(buf) {
    if (this.finished || this.settled || !buf?.length) return;
    this.respPending.push(buf);
    this.respPendingLen += buf.length;
    if (this.respPendingLen >= CHUNK) this.#flush("resp", false);
  }
  end(outcome, reason = "") {
    if (this.finished || this.settled) return;
    this.#flush("req", true);
    this.#flush("resp", true);
    this.finished = true;
    this.endedAt = Date.now();
    this.#emit(
      wire.jsonFrame(wire.END, this.id, {
        outcome,
        reason,
        ended_at: wire.rfc3339Nano(),
        request_bytes: this.reqBytes,
        response_bytes: this.respBytes,
        ws_messages: 0,
      }),
    );
  }
  cancel(reason = "capture_failed") {
    if (this.finished || this.settled) return;
    this.#emit(wire.jsonFrame(wire.CANCEL, this.id, { reason }));
    this.client._settle(this, "canceled");
  }

  #flush(which, force) {
    const pending = which === "req" ? this.reqPending : this.respPending;
    const len = which === "req" ? this.reqPendingLen : this.respPendingLen;
    if (!len) return;
    const type = which === "req" ? wire.REQUEST_BODY : wire.RESPONSE_BODY;
    let data = pending.length === 1 ? pending[0] : Buffer.concat(pending, len);
    let offset = 0;
    while (data.length - offset >= CHUNK || (force && data.length - offset > 0)) {
      const slice = data.subarray(offset, offset + CHUNK);
      offset += slice.length;
      if (which === "req") this.reqBytes += slice.length;
      else this.respBytes += slice.length;
      this.#emit(wire.encode(type, this.id, slice));
    }
    const rest = offset < data.length ? data.subarray(offset) : null;
    if (which === "req") {
      this.reqPending = rest ? [rest] : [];
      this.reqPendingLen = rest ? rest.length : 0;
    } else {
      this.respPending = rest ? [rest] : [];
      this.respPendingLen = rest ? rest.length : 0;
    }
  }

  #emit(frame) {
    if (this.settled) return;
    if (this.client.heldBytes + frame.length > this.client.budgetBytes) {
      // Over budget: drop this record rather than push back on the agent.
      this.client._drop(this, "budget");
      return;
    }
    this.frames.push(frame);
    this.bytes += frame.length;
    this.client.heldBytes += frame.length;
    this.client._write(this);
  }
}

export class LrsClient {
  constructor({ url, key, connections = 4, budgetBytes = 256 * 1024 * 1024, insecure = true, logger } = {}) {
    this.url = url;
    this.key = key;
    this.connections = Math.min(32, Math.max(1, connections | 0 || 4));
    this.budgetBytes = budgetBytes;
    this.insecure = insecure; // trust the station's self-signed certificate
    this.logger = logger || (() => {});
    this.conns = [];
    this.records = new Map(); // id hex -> Record
    this.heldBytes = 0;
    this.closed = false;
    this.stats = {
      acked: 0, duplicate: 0, dropped: 0, failures: 0,
      dropBudget: 0, dropReject: 0, dropDisconnect: 0, dropRetries: 0, dropAge: 0,
      lastError: null, lastErrorAt: 0, lastSuccessAt: 0,
    };
  }

  start() {
    if (!this.url || !this.key || this.conns.length) return;
    this.closed = false;
    for (let i = 0; i < this.connections; i++) this.conns.push(this.#makeConn(i));
    this.sweeper = setInterval(() => this.#sweep(), 15000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  stop() {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const c of this.conns) {
      clearTimeout(c.reconnectTimer);
      clearInterval(c.pingTimer);
      try {
        c.ws?.terminate();
      } catch {}
    }
    this.conns = [];
    this.records.clear();
    this.heldBytes = 0;
  }

  /** Start a record, or null when closed or over budget. */
  begin(meta) {
    if (this.closed || !this.conns.length) return null;
    try {
      const id = wire.newRecordId();
      const record = new Record(this, id);
      const headers = meta.headers || [];
      const begin = {
        method: meta.method,
        scheme: meta.scheme,
        host: meta.host,
        path: meta.path,
        query: meta.query || "",
        http_version: meta.httpVersion || "HTTP/1.1",
        started_at: wire.rfc3339Nano(),
        headers: wire.stripCredentials(headers),
        request_encoding: meta.requestEncoding || "",
        user_fingerprint: wire.userFingerprint(headers),
      };
      if (meta.providerHint) begin.provider_hint = meta.providerHint;
      record.conn = this.#leastLoaded();
      record.conn?.records.add(record);
      this.records.set(record.key, record);
      record.frames.push(wire.jsonFrame(wire.BEGIN, id, begin));
      record.bytes += record.frames[0].length;
      this.heldBytes += record.frames[0].length;
      if (this.heldBytes > this.budgetBytes) {
        this._drop(record, "budget");
        return null;
      }
      this._write(record);
      return record;
    } catch (error) {
      this.#fail(String(error?.message || error));
      return null;
    }
  }

  statsView() {
    return {
      connected: this.conns.filter((c) => c.ready).length,
      connections: this.conns.length,
      active: this.records.size,
      heldBytes: this.heldBytes,
      ...this.stats,
    };
  }

  // ---- internals ----

  #leastLoaded() {
    let best = null;
    for (const c of this.conns) {
      if (best === null || c.records.size < best.records.size || (c.ready && !best.ready)) best = c;
    }
    return best;
  }

  _write(record) {
    const conn = record.conn;
    if (!conn || !conn.ready || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
    while (record.sent < record.frames.length) {
      const frame = record.frames[record.sent];
      record.sent++;
      try {
        conn.ws.send(frame, { binary: true }, (err) => {
          if (err) this.#fail(String(err.message || err));
        });
      } catch (error) {
        this.#fail(String(error?.message || error));
        return;
      }
    }
  }

  _settle(record, how) {
    if (record.settled) return;
    record.settled = true;
    record.conn?.records.delete(record);
    this.records.delete(record.key);
    this.heldBytes -= record.bytes;
    record.bytes = 0;
    record.frames = [];
    if (how === "stored") {
      this.stats.acked++;
      this.stats.lastSuccessAt = Date.now();
    } else if (how === "duplicate") {
      this.stats.duplicate++;
      this.stats.lastSuccessAt = Date.now();
    }
  }

  _drop(record, reason) {
    if (record.settled) return;
    record.settled = true;
    record.conn?.records.delete(record);
    this.records.delete(record.key);
    this.heldBytes -= record.bytes;
    record.bytes = 0;
    record.frames = [];
    this.stats.dropped++;
    if (reason === "budget") this.stats.dropBudget++;
    else if (reason === "reject") this.stats.dropReject++;
    else if (reason === "disconnect") this.stats.dropDisconnect++;
    else if (reason === "retries") this.stats.dropRetries++;
    else if (reason === "age") this.stats.dropAge++;
    this.#fail(reason);
  }

  #fail(message) {
    this.stats.failures++;
    this.stats.lastError = message;
    this.stats.lastErrorAt = Date.now();
    this.logger("lrs", message);
  }

  #makeConn(index) {
    const conn = { index, ws: null, ready: false, records: new Set(), reconnectTimer: null, pingTimer: null };
    this.#connect(conn);
    return conn;
  }

  #connect(conn) {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(this.url, [wire.SUBPROTOCOL], {
        headers: { Authorization: "Bearer " + this.key },
        rejectUnauthorized: !this.insecure, // trust the station's self-signed cert
        perMessageDeflate: false,
        skipUTF8Validation: true,
      });
    } catch (error) {
      this.#fail(String(error?.message || error));
      this.#scheduleReconnect(conn);
      return;
    }
    conn.ws = ws;
    conn.ready = false;
    ws.on("message", (data, isBinary) => {
      if (isBinary) this.#onFrame(conn, Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    ws.on("close", () => this.#onClose(conn));
    ws.on("error", (error) => {
      this.#fail(String(error?.message || error));
    });
    clearInterval(conn.pingTimer);
    conn.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        try {
          ws.ping();
        } catch {}
    }, PING_INTERVAL);
    if (conn.pingTimer.unref) conn.pingTimer.unref();
  }

  #onFrame(conn, msg) {
    const frame = wire.decode(msg);
    if (!frame) return;
    if (frame.type === wire.WELCOME) {
      conn.ready = true;
      for (const record of conn.records) this._write(record);
      return;
    }
    const key = frame.id.toString("hex");
    const record = this.records.get(key);
    if (!record) return;
    let meta = {};
    try {
      meta = JSON.parse(Buffer.from(frame.payload).toString("utf8") || "{}");
    } catch {}
    if (frame.type === wire.ACK) {
      this._settle(record, meta.status === "duplicate" ? "duplicate" : "stored");
    } else if (frame.type === wire.REJECT) {
      this.#onReject(record, meta);
    }
  }

  #onReject(record, meta) {
    if (meta.retry && record.replayable && record.retries < MAX_RETRIES) {
      const delay = RETRY_DELAYS[Math.min(record.retries, RETRY_DELAYS.length - 1)];
      record.retries++;
      record.sent = 0; // resend from BEGIN
      const timer = setTimeout(() => {
        if (!record.settled) this._write(record);
      }, delay);
      if (timer.unref) timer.unref();
    } else {
      this._drop(record, "reject");
    }
  }

  #onClose(conn) {
    conn.ready = false;
    clearInterval(conn.pingTimer);
    // Reassign this connection's unsettled records: resend from BEGIN elsewhere
    // if still fully held, otherwise give up on them.
    const others = this.conns.filter((c) => c !== conn);
    for (const record of [...conn.records]) {
      if (record.settled) continue;
      conn.records.delete(record);
      if (!record.replayable || record.bytes === 0) {
        this._drop(record, "disconnect");
        continue;
      }
      const target = others.length ? others.reduce((a, b) => (a.records.size <= b.records.size ? a : b)) : conn;
      record.conn = target;
      record.sent = 0;
      target.records.add(record);
      if (target.ready) this._write(record);
    }
    this.#scheduleReconnect(conn);
  }

  #scheduleReconnect(conn) {
    if (this.closed) return;
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = setTimeout(() => this.#connect(conn), 1000 + Math.floor(Math.random() * 2000));
    if (conn.reconnectTimer.unref) conn.reconnectTimer.unref();
  }

  #sweep() {
    const now = Date.now();
    for (const record of [...this.records.values()]) {
      if (record.settled) continue;
      if (now - record.bornAt > MAX_RECORD_AGE) {
        this._drop(record, "age");
      } else if (record.finished && record.endedAt && now - record.endedAt > ACK_TIMEOUT && record.conn?.ready) {
        // END sent long ago with no ACK: treat the connection as stuck.
        try {
          record.conn.ws?.terminate();
        } catch {}
      }
    }
  }
}
