// A local forward proxy the agents are pointed at (HTTPS_PROXY). It terminates
// TLS for every host with a leaf certificate the agents trust, so each request's
// path is visible; `shouldRecord(method, path, upgrade)` picks the AI calls,
// which are forwarded to the real upstream and teed to the lrs.v4 client. Other
// requests are forwarded the same way without a copy. Loopback, non-TLS streams
// and hosts whose client rejected the certificate are tunnelled untouched.
// Recording is a side copy that never changes or delays what the agent sees.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import * as wire from "./wire.mjs";

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1)$/i;
// The client's TLS alert when it does not trust the presented certificate.
const UNTRUSTED = /ALERT_(UNKNOWN_CA|CERTIFICATE_UNKNOWN|BAD_CERTIFICATE)/;

export class RecorderProxy {
  constructor({ certStore, lrs, shouldRecord, logger, resolveUpstream }) {
    this.certStore = certStore;
    this.lrs = lrs;
    this.shouldRecord = shouldRecord;
    this.logger = logger || (() => {});
    // Where a request actually goes (tests point it elsewhere); default is the
    // host itself with normal certificate verification.
    this.resolveUpstream = resolveUpstream || ((host, port) => ({ host, port }));
    this.passthrough = new Set(); // hosts tunnelled because a client rejected our certificate
    this.upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 256 });
    this.port = 0;
    this.server = http.createServer((req, res) => this.#onPlainRequest(req, res));
    this.server.on("connect", (req, socket, head) => this.#onConnect(req, socket, head));
    this.server.on("clientError", (_err, socket) => socket.destroy());
    // Decrypted agent traffic is replayed into this server.
    this.mitm = http.createServer((req, res) => this.#onRequest(req, res));
    this.mitm.on("upgrade", (req, socket, head) => this.#onUpgrade(req, socket, head));
    this.mitm.on("clientError", (_err, socket) => socket.destroy());
    // Agent side of recorded WebSocket calls; it answers with what the upstream chose.
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: (_offered, req) => req._frameProtocol || false });
    this.wss.on("headers", (headers, req) => headers.push(...(req._frameHeaders || [])));
  }

  listen(host = "127.0.0.1") {
    return new Promise((resolve) => {
      this.server.listen(0, host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    try {
      this.server.close();
    } catch {}
  }

  #onConnect(req, socket, head) {
    const [host, portText] = splitHostPort(req.url);
    const port = Number(portText) || 443;
    socket.on("error", () => socket.destroy());
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // The first bytes tell a TLS ClientHello (0x16) from anything else.
    const decide = (first) => {
      if (first[0] !== 0x16 || LOOPBACK.test(host) || this.passthrough.has(host)) this.#tunnel(host, port, socket, first);
      else this.#intercept(host, port, socket, first);
    };
    if (head?.length) decide(head);
    else
      socket.once("data", (first) => {
        socket.pause();
        decide(first);
      });
  }

  #tunnel(host, port, socket, first) {
    const upstream = net.connect(port, host, () => {
      upstream.write(first);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  }

  #intercept(host, port, socket, first) {
    this.certStore.contextFor(host).then(
      (ctx) => {
        let secure = false;
        const tlsSocket = new tls.TLSSocket(replay(socket, first), {
          isServer: true,
          secureContext: ctx,
          SNICallback: (name, cb) => this.certStore.contextFor(name || host).then((c) => cb(null, c), cb),
          ALPNProtocols: ["http/1.1"], // keep the decrypted side as HTTP/1.1
        });
        tlsSocket.on("secure", () => (secure = true));
        tlsSocket.on("error", (error) => {
          if (!secure && UNTRUSTED.test(error.code || "") && !this.passthrough.has(host)) {
            this.passthrough.add(host);
            this.logger("proxy", `${host} 的客户端不信任拦截证书，之后直连该域名、不记录`);
          }
          tlsSocket.destroy();
        });
        tlsSocket._frameHost = host;
        tlsSocket._framePort = port;
        this.mitm.emit("connection", tlsSocket);
      },
      (error) => {
        this.logger("proxy", `${host} 证书生成失败，直连：${error?.message || error}`);
        this.#tunnel(host, port, socket, first);
      },
    );
  }

  #begin(req, host, path, query) {
    if (!this.shouldRecord(req.method, path, isWebSocket(req))) return null;
    try {
      return this.lrs.begin({
        method: req.method,
        scheme: "https",
        host,
        path,
        query,
        httpVersion: "HTTP/" + req.httpVersion,
        headers: wire.pairHeaders(req.rawHeaders),
        requestEncoding: req.headers["content-encoding"] || "",
      });
    } catch (error) {
      this.logger("proxy", "begin failed: " + (error?.message || error));
      return null;
    }
  }

  #onRequest(req, res) {
    const host = req.socket._frameHost;
    const port = req.socket._framePort || 443;
    if (!host) {
      res.destroy();
      return;
    }
    const [reqPath, query] = splitQuery(req.url);
    const record = this.#begin(req, host, reqPath, query);
    const target = this.resolveUpstream(host, port);
    const upstream = https.request({
      host: target.host,
      port: target.port,
      servername: host,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req.rawHeaders),
      agent: this.upstreamAgent,
      ...target.tls,
    });

    if (record) req.on("data", (chunk) => safe(() => record.requestBody(chunk)));
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);

    upstream.on("response", (up) => {
      if (record) safe(() => record.responseHead(responseMeta(up)));
      res.writeHead(up.statusCode, up.statusMessage, forwardHeaders(up.headers));
      if (record) {
        up.on("data", (chunk) => safe(() => record.responseBody(chunk)));
        up.on("end", () => safe(() => record.end("complete", "")));
        up.on("error", () => safe(() => record.end("interrupted", "upstream_read_error")));
      }
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (record) safe(() => record.end("interrupted", "upstream_error"));
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => {
      if (record && !record.finished) safe(() => record.end("interrupted", "client_closed"));
      upstream.destroy();
    });
  }

  #onUpgrade(req, clientSocket, head) {
    const host = clientSocket._frameHost;
    const port = clientSocket._framePort || 443;
    if (!host) {
      clientSocket.destroy();
      return;
    }
    const [reqPath, query] = splitQuery(req.url);
    const record = isWebSocket(req) ? this.#begin(req, host, reqPath, query) : null;
    if (record) {
      this.#recordWebSocket(req, clientSocket, head, host, port, record);
      return;
    }
    // Not recorded: relay the upgrade byte for byte.
    const target = this.resolveUpstream(host, port);
    const upstream = tls.connect({ host: target.host, port: target.port, servername: host, ...target.tls }, () => {
      upstream.write(rebuildRequest(req));
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  }

  // Both sides of a recorded WebSocket call end here, so each application
  // message can be copied whole (compression is not negotiated on either side).
  #recordWebSocket(req, clientSocket, head, host, port, record) {
    const target = this.resolveUpstream(host, port);
    const offered = (req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const headers = {};
    for (const [name, value] of wire.pairHeaders(req.rawHeaders)) {
      if (WS_HANDSHAKE.has(name.toLowerCase()) || HOP_BY_HOP.has(name.toLowerCase())) continue;
      headers[name] = name in headers ? headers[name] + ", " + value : value;
    }
    let opened = false;
    let upgrade = null;
    const upstream = new WebSocket(`wss://${target.host}:${target.port}${req.url}`, offered, {
      headers,
      perMessageDeflate: false,
      servername: host,
      ...target.tls,
    });
    upstream.on("upgrade", (res) => (upgrade = res));
    upstream.on("unexpected-response", (_request, res) => {
      // The upstream refused the upgrade: pass its answer on as a plain response.
      safe(() => record.responseHead(responseMeta(res)));
      let text = `HTTP/1.1 ${res.statusCode} ${res.statusMessage || ""}\r\n`;
      for (const [name, value] of wire.pairHeaders(res.rawHeaders))
        if (!HOP_BY_HOP.has(name.toLowerCase())) text += `${name}: ${value}\r\n`;
      clientSocket.write(text + "Connection: close\r\n\r\n");
      res.on("data", (chunk) => {
        clientSocket.write(chunk);
        safe(() => record.responseBody(chunk));
      });
      res.on("end", () => {
        safe(() => record.end("complete", ""));
        clientSocket.end();
      });
      res.on("error", () => {
        safe(() => record.end("interrupted", "upstream_read_error"));
        clientSocket.destroy();
      });
    });
    upstream.on("error", () => {
      if (opened) return; // a close follows
      safe(() => record.end("interrupted", "upstream_error"));
      clientSocket.destroy();
    });
    upstream.on("open", () => {
      opened = true;
      req._frameProtocol = upstream.protocol && offered.includes(upstream.protocol) ? upstream.protocol : false;
      req._frameHeaders = [];
      for (const [name, value] of wire.pairHeaders(upgrade?.rawHeaders || []))
        if (!WS_HANDSHAKE.has(name.toLowerCase()) && !HOP_BY_HOP.has(name.toLowerCase())) req._frameHeaders.push(`${name}: ${value}`);
      if (upgrade) safe(() => record.responseHead(responseMeta(upgrade)));
      this.wss.handleUpgrade(req, clientSocket, head, (client) => relay(client, upstream, record));
    });
    clientSocket.on("error", () => upstream.terminate());
  }

  // Absolute-form plain HTTP through the proxy (rare for AI hosts).
  #onPlainRequest(req, res) {
    if (!req.url.startsWith("http://")) {
      res.writeHead(400).end();
      return;
    }
    const url = new URL(req.url);
    const upstream = http.request(
      { host: url.hostname, port: url.port || 80, method: req.method, path: url.pathname + url.search, headers: upstreamHeaders(req.rawHeaders) },
      (up) => {
        res.writeHead(up.statusCode, up.statusMessage, forwardHeaders(up.headers));
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }
}

/** Relay messages both ways between the agent and the upstream, copying each to the record. */
function relay(client, upstream, record) {
  let closed = 0;
  let broken = "";
  const finish = () => {
    if (++closed < 2) return;
    safe(() => record.end(broken ? "interrupted" : "complete", broken));
  };
  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    safe(() => record.wsMessage(wire.CLIENT_TO_UPSTREAM, isBinary ? wire.OP_BINARY : wire.OP_TEXT, data));
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    safe(() => record.wsMessage(wire.UPSTREAM_TO_CLIENT, isBinary ? wire.OP_BINARY : wire.OP_TEXT, data));
  });
  client.on("close", (code, reason) => {
    if (code === 1006) broken ||= "client_closed";
    safe(() => record.wsMessage(wire.CLIENT_TO_UPSTREAM, wire.OP_CLOSE, closePayload(code, reason)));
    closeWith(upstream, code, reason);
    finish();
  });
  upstream.on("close", (code, reason) => {
    if (code === 1006) broken ||= "upstream_read_error";
    safe(() => record.wsMessage(wire.UPSTREAM_TO_CLIENT, wire.OP_CLOSE, closePayload(code, reason)));
    closeWith(client, code, reason);
    finish();
  });
  client.on("error", () => {});
}

/** A stream over `socket` that first gives back the bytes already read from it. */
function replay(socket, first) {
  const stream = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, encoding, callback) {
      socket.write(chunk, encoding, callback);
    },
    final(callback) {
      socket.end();
      callback();
    },
    destroy(error, callback) {
      socket.destroy();
      callback(error);
    },
  });
  stream.push(first);
  socket.on("data", (chunk) => {
    if (!stream.push(chunk)) socket.pause();
  });
  socket.on("end", () => stream.push(null));
  socket.on("close", () => stream.destroy());
  return stream;
}

function safe(fn) {
  try {
    fn();
  } catch {}
}

function isWebSocket(req) {
  return /^websocket$/i.test(req.headers.upgrade || "");
}

function responseMeta(res) {
  return {
    status: res.statusCode,
    reason: res.statusMessage || "",
    http_version: "HTTP/" + res.httpVersion,
    received_at: wire.rfc3339Nano(),
    headers: wire.pairHeaders(res.rawHeaders),
    body_encoding: res.headers["content-encoding"] || "",
  };
}

function closePayload(code, reason) {
  if (!code || code === 1005 || code === 1006) return Buffer.alloc(0);
  const out = Buffer.allocUnsafe(2);
  out.writeUInt16BE(code);
  return Buffer.concat([out, Buffer.from(reason || "")]);
}

function closeWith(ws, code, reason) {
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
  const sendable = (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);
  try {
    if (sendable) ws.close(code, reason);
    else ws.close();
  } catch {
    ws.terminate();
  }
}

function splitHostPort(authority) {
  const i = authority.lastIndexOf(":");
  if (i === -1) return [authority, "443"];
  return [authority.slice(0, i).replace(/^\[|\]$/g, ""), authority.slice(i + 1)];
}

function splitQuery(target) {
  const i = target.indexOf("?");
  if (i === -1) return [target, ""];
  return [target.slice(0, i), target.slice(i + 1)];
}

const HOP_BY_HOP = new Set(["connection", "proxy-connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"]);
// Made anew by each side of a terminated WebSocket handshake.
const WS_HANDSHAKE = new Set(["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol", "sec-websocket-accept"]);

/** Request headers for the upstream call, dropping proxy/hop-by-hop ones. */
function upstreamHeaders(rawHeaders) {
  const out = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out.push([name, rawHeaders[i + 1]]);
  }
  return out;
}

/** Response headers back to the agent; Node manages framing itself. */
function forwardHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

function rebuildRequest(req) {
  let text = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) text += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
  return text + "\r\n";
}
