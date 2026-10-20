import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { createHash } from "node:crypto";
import * as wire from "../server/recorder/wire.mjs";
import { CertStore } from "../server/recorder/ca.mjs";
import { LrsClient } from "../server/recorder/lrs.mjs";
import { RecorderProxy } from "../server/recorder/proxy.mjs";
import { isAiCall } from "../server/recorder/index.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frame-recorder-"));
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const selfSigned = (name) => {
  const key = path.join(tmp, name + ".key");
  const cert = path.join(tmp, name + ".crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=" + name], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
};

async function until(predicate, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("wire", () => {
  it("encodes a frame as type || 16-byte id || payload", () => {
    const id = wire.newRecordId();
    const frame = wire.encode(wire.BEGIN, id, Buffer.from("hi"));
    expect(frame.length).toBe(17 + 2);
    expect(frame[0]).toBe(wire.BEGIN);
    expect(frame.subarray(1, 17).equals(id)).toBe(true);
    expect(frame.subarray(17).toString()).toBe("hi");
  });

  it("strips credential headers and fingerprints the raw Authorization value", () => {
    const headers = [["Authorization", "Bearer sk-abc"], ["Content-Type", "application/json"], ["X-Api-Key", "k"]];
    expect(wire.stripCredentials(headers)).toEqual([["Content-Type", "application/json"]]);
    expect(wire.userFingerprint(headers)).toBe("user_" + createHash("sha256").update("Bearer sk-abc").digest("hex"));
    expect(wire.userFingerprint([["Content-Type", "x"]])).toBe("");
  });

  it("lays out a WS_MESSAGE payload as direction, opcode, ns timestamp, data", () => {
    const payload = wire.wsPayload(wire.UPSTREAM_TO_CLIENT, wire.OP_TEXT, Buffer.from("hey"));
    expect([payload[0], payload[1]]).toEqual([2, 1]);
    const at = payload.readBigInt64BE(2);
    expect(Number(at / 1000000n)).toBeGreaterThan(Date.now() - 5000);
    expect(payload.subarray(10).toString()).toBe("hey");
  });
});

describe("AI call paths", () => {
  it("matches AI API paths on any host prefix", () => {
    for (const p of ["/v1/messages", "/anthropic/v1/messages", "/v1/messages/count_tokens", "/v1/chat/completions", "/api/paas/v4/chat/completions", "/v1/responses", "/backend-api/codex/responses", "/v1/responses/compact", "/v1/embeddings", "/v1beta/models/gemini-2.5-pro:streamGenerateContent"])
      expect(isAiCall("POST", p, false), p).toBe(true);
  });
  it("skips other paths and non-POST requests", () => {
    for (const [m, p] of [["GET", "/v1/models"], ["POST", "/api/oauth/token"], ["GET", "/v1/messages"], ["POST", "/repos/a/b/issues"], ["POST", "/v2/messages"]])
      expect(isAiCall(m, p, false), m + " " + p).toBe(false);
  });
  it("records WebSocket upgrades on AI paths", () => {
    expect(isAiCall("GET", "/backend-api/codex/responses", true)).toBe(true);
    expect(isAiCall("GET", "/v1/realtime", true)).toBe(true);
    expect(isAiCall("GET", "/socket", true)).toBe(false);
  });
});

/** A minimal lrs.v4 station (docs/protocol.md §5) that checks the END counts and ACKs. */
function mockStation() {
  const records = new Map();
  const server = http.createServer();
  const wss = new WebSocketServer({ server, handleProtocols: (p) => p.has("lrs.v4") && "lrs.v4" });
  const got = {};
  wss.on("connection", (ws, req) => {
    got.authorization = req.headers["authorization"];
    ws.send(wire.encode(wire.WELCOME, Buffer.alloc(16), Buffer.from(JSON.stringify({ server_version: "4.0.0", max_message_bytes: 1048593, max_record_bytes: 268435456, idle_timeout_seconds: 600 }))));
    ws.on("message", (data) => {
      const frame = wire.decode(Buffer.from(data));
      const key = frame.id.toString("hex");
      let rec = records.get(key);
      if (!rec) records.set(key, (rec = { reqBytes: 0, respBytes: 0, ws: [], frames: [] }));
      rec.frames.push(frame.type);
      if (frame.type === wire.BEGIN) rec.begin = JSON.parse(frame.payload.toString());
      else if (frame.type === wire.REQUEST_BODY) rec.reqBytes += frame.payload.length;
      else if (frame.type === wire.RESPONSE_HEAD) rec.head = JSON.parse(frame.payload.toString());
      else if (frame.type === wire.RESPONSE_BODY) rec.respBytes += frame.payload.length;
      else if (frame.type === wire.WS_MESSAGE) rec.ws.push({ dir: frame.payload[0], op: frame.payload[1], data: Buffer.from(frame.payload.subarray(10)) });
      else if (frame.type === wire.END) {
        rec.end = JSON.parse(frame.payload.toString());
        const ok = rec.end.request_bytes === rec.reqBytes && rec.end.response_bytes === rec.respBytes && rec.end.ws_messages === rec.ws.length;
        ws.send(wire.encode(ok ? wire.ACK : wire.REJECT, frame.id, Buffer.from(JSON.stringify(ok ? { status: "stored" } : { code: "count_mismatch", retry: false }))));
      }
    });
  });
  return { server, records, got };
}

/** CONNECT through the proxy and open TLS to `name`, trusting `ca`. */
function connectVia(proxyPort, name, ca) {
  return new Promise((resolve, reject) => {
    const conn = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: `${name}:443` });
    conn.on("connect", (_res, socket) => {
      const t = tls.connect({ socket, servername: name, ca }, () => resolve(t));
      t.on("error", reject);
    });
    conn.on("error", reject);
    conn.end();
  });
}

function rawRequest(socket, text, body = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => (buf = Buffer.concat([buf, d])));
    socket.on("end", () => resolve(buf.toString()));
    socket.on("error", reject);
    socket.write(text);
    socket.write(body);
  });
}

describe("recorder end to end", () => {
  let station, lrs, store, proxy, proxyPort, upstream, upstreamSeen, ca;
  beforeAll(async () => {
    station = mockStation();
    const stationPort = await listen(station.server);
    lrs = new LrsClient({ url: `ws://127.0.0.1:${stationPort}/api/record`, key: "collect-key", connections: 2 });
    lrs.start();
    await until(() => lrs.statsView().connected === 2);

    // One fake upstream for every host: HTTP answers and a WebSocket endpoint.
    upstreamSeen = [];
    upstream = https.createServer(selfSigned("upstream.test"), (req, res) => {
      let body = Buffer.alloc(0);
      req.on("data", (d) => (body = Buffer.concat([body, d])));
      req.on("end", () => {
        upstreamSeen.push({ method: req.method, url: req.url, host: req.headers.host, authorization: req.headers.authorization, body: body.toString() });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: a\n");
        res.end("event: b\n");
      });
    });
    const upstreamWs = new WebSocketServer({ server: upstream, handleProtocols: (p) => p.has("proto-a") && "proto-a" });
    upstreamWs.on("connection", (ws, req) => {
      upstreamSeen.push({ ws: true, url: req.url, authorization: req.headers.authorization, extensions: req.headers["sec-websocket-extensions"] });
      ws.on("message", (data) => ws.send("pong:" + data));
    });
    const upstreamPort = await listen(upstream);

    store = new CertStore(path.join(tmp, "ca"));
    store.ensure();
    ca = fs.readFileSync(store.caCertPath());
    proxy = new RecorderProxy({
      certStore: store,
      lrs,
      shouldRecord: isAiCall,
      resolveUpstream: () => ({ host: "127.0.0.1", port: upstreamPort, tls: { rejectUnauthorized: false } }),
    });
    proxyPort = await proxy.listen();
  });
  afterAll(() => {
    lrs.stop();
    proxy.close();
    upstream.close();
    station.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const recordFor = (p) => [...station.records.values()].find((r) => r.begin?.path === p);

  it("records an AI path on any host and forwards it unchanged", async () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const socket = await connectVia(proxyPort, "relay.example.org", ca);
    const response = await rawRequest(
      socket,
      `POST /api/v1/chat/completions?x=1 HTTP/1.1\r\nHost: relay.example.org\r\nAuthorization: Bearer sk-secret\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
      body,
    );
    expect(response).toContain("200");
    expect(response).toContain("event: a");
    expect(response).toContain("event: b");
    // The upstream got the request as the agent sent it, credential included.
    expect(upstreamSeen.find((s) => s.url === "/api/v1/chat/completions?x=1")).toMatchObject({ host: "relay.example.org", authorization: "Bearer sk-secret", body: body.toString() });

    expect(await until(() => recordFor("/api/v1/chat/completions")?.end)).toBe(true);
    const rec = recordFor("/api/v1/chat/completions");
    expect(rec.frames).toEqual([wire.BEGIN, wire.REQUEST_BODY, wire.RESPONSE_HEAD, wire.RESPONSE_BODY, wire.END]);
    expect(rec.begin).toMatchObject({ method: "POST", host: "relay.example.org", query: "x=1" });
    expect(rec.begin.user_fingerprint).toBe("user_" + createHash("sha256").update("Bearer sk-secret").digest("hex"));
    expect(rec.begin.headers.some(([n]) => n.toLowerCase() === "authorization")).toBe(false);
    expect(rec.reqBytes).toBe(body.length);
    expect(rec.respBytes).toBe(Buffer.byteLength("event: a\nevent: b\n"));
    expect(rec.end.outcome).toBe("complete");
    expect(station.got.authorization).toBe("Bearer collect-key");
    expect(await until(() => lrs.statsView().acked >= 1)).toBe(true);
  });

  it("forwards other paths on the same host without recording them", async () => {
    const before = station.records.size;
    const socket = await connectVia(proxyPort, "api.anthropic.com", ca);
    const response = await rawRequest(socket, `GET /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: close\r\n\r\n`);
    expect(response).toContain("200");
    expect(upstreamSeen.some((s) => s.url === "/v1/models")).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(station.records.size).toBe(before);
  });

  it("records a WebSocket AI call message by message", async () => {
    const socket = await connectVia(proxyPort, "chatgpt.com", ca);
    const ws = new WebSocket("wss://chatgpt.com/backend-api/codex/responses", ["proto-a"], {
      createConnection: () => socket,
      headers: { Authorization: "Bearer chatgpt-token" },
    });
    const reply = await new Promise((resolve, reject) => {
      ws.on("open", () => ws.send("ping-1"));
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
    });
    expect(ws.protocol).toBe("proto-a");
    expect(reply).toBe("pong:ping-1");
    ws.close(1000, "done");
    // The upstream saw the agent's credential and no compression negotiated.
    expect(upstreamSeen.find((s) => s.ws)).toMatchObject({ url: "/backend-api/codex/responses", authorization: "Bearer chatgpt-token", extensions: undefined });

    expect(await until(() => recordFor("/backend-api/codex/responses")?.end)).toBe(true);
    const rec = recordFor("/backend-api/codex/responses");
    expect(rec.begin.method).toBe("GET");
    expect(rec.head.status).toBe(101);
    const messages = rec.ws.filter((m) => m.op !== wire.OP_CLOSE).map((m) => [m.dir, m.data.toString()]);
    expect(messages).toEqual([
      [wire.CLIENT_TO_UPSTREAM, "ping-1"],
      [wire.UPSTREAM_TO_CLIENT, "pong:ping-1"],
    ]);
    expect(rec.ws.some((m) => m.op === wire.OP_CLOSE && m.data.readUInt16BE(0) === 1000)).toBe(true);
    expect(rec.end).toMatchObject({ outcome: "complete", ws_messages: rec.ws.length });
  });

  it("tunnels a host after its client rejects the certificate", async () => {
    // openssl s_client does not trust our CA and aborts the handshake with an alert.
    await new Promise((resolve) =>
      execFile(
        "openssl",
        ["s_client", "-proxy", `127.0.0.1:${proxyPort}`, "-connect", "untrusted.example.org:443", "-servername", "untrusted.example.org", "-verify_return_error"],
        { timeout: 5000 },
        () => resolve(),
      ).stdin.end(),
    );
    expect(await until(() => proxy.passthrough.has("untrusted.example.org"))).toBe(true);
  });

  it("tunnels loopback hosts untouched", async () => {
    const target = https.createServer(selfSigned("loop"), (_req, res) => res.end("ok"));
    const targetPort = await listen(target);
    const got = await new Promise((resolve, reject) => {
      const conn = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: `127.0.0.1:${targetPort}` });
      conn.on("connect", (_res, socket) => {
        const t = tls.connect({ socket, rejectUnauthorized: false }, () => t.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
        let buf = "";
        t.on("data", (d) => (buf += d));
        t.on("end", () => resolve({ buf, issuer: t.getPeerCertificate().issuer?.CN }));
        t.on("error", reject);
      });
      conn.on("error", reject);
      conn.end();
    });
    expect(got.buf).toContain("ok");
    expect(got.issuer).toBe("loop"); // the target's own certificate, not ours
    target.close();
  });
});
