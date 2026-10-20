// A local forward proxy the agents are pointed at (HTTPS_PROXY). For the AI
// hosts we record, it terminates TLS with a leaf certificate the agents trust,
// forwards the call to the real upstream, and tees both sides to the lrs.v4
// client. Every other host is tunnelled through untouched. The proxy sits in
// the request path, so it forwards faithfully; recording is a side copy that
// never changes or delays what the agent sees.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import * as wire from "./wire.mjs";

export class RecorderProxy {
  constructor({ certStore, lrs, shouldRecord, logger, resolveUpstream }) {
    this.certStore = certStore;
    this.lrs = lrs;
    this.shouldRecord = shouldRecord;
    this.logger = logger || (() => {});
    // Where a recorded host's request actually goes (tests point it elsewhere);
    // default is the host itself with normal certificate verification.
    this.resolveUpstream = resolveUpstream || ((host, port) => ({ host, port }));
    this.upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 256 });
    this.port = 0;
    this.server = http.createServer((req, res) => this.#onPlainRequest(req, res));
    this.server.on("connect", (req, socket, head) => this.#onConnect(req, socket, head));
    this.server.on("clientError", (_err, socket) => socket.destroy());
    // Decrypted agent traffic for MITM'd hosts is replayed into this server.
    this.mitm = http.createServer((req, res) => this.#onRequest(req, res));
    this.mitm.on("upgrade", (req, socket, head) => this.#onUpgrade(req, socket, head));
    this.mitm.on("clientError", (_err, socket) => socket.destroy());
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
    if (!this.shouldRecord(host)) {
      this.#tunnel(host, port, socket, head);
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let ctx;
    try {
      ctx = this.certStore.contextFor(host);
    } catch (error) {
      this.logger("proxy", "cert failed for " + host + ": " + (error?.message || error));
      this.#tunnel(host, port, socket, head);
      return;
    }
    const tlsSocket = new tls.TLSSocket(socket, {
      isServer: true,
      SNICallback: (name, cb) => {
        try {
          cb(null, this.certStore.contextFor(name || host));
        } catch (error) {
          cb(error);
        }
      },
      secureContext: ctx,
      ALPNProtocols: ["http/1.1"], // keep the decrypted side as HTTP/1.1
    });
    tlsSocket.on("error", () => tlsSocket.destroy());
    tlsSocket._frameHost = host;
    tlsSocket._framePort = port;
    if (head?.length) tlsSocket.unshift(head);
    this.mitm.emit("connection", tlsSocket);
  }

  #tunnel(host, port, socket, head) {
    const upstream = net.connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  }

  #onRequest(req, res) {
    const host = req.socket._frameHost;
    const port = req.socket._framePort || 443;
    if (!host) {
      res.destroy();
      return;
    }
    const [reqPath, query] = splitQuery(req.url);
    let record = null;
    try {
      record = this.lrs.begin({
        method: req.method,
        scheme: "https",
        host,
        path: reqPath,
        query,
        httpVersion: "HTTP/" + req.httpVersion,
        headers: wire.pairHeaders(req.rawHeaders),
        requestEncoding: req.headers["content-encoding"] || "",
      });
    } catch (error) {
      this.logger("proxy", "begin failed: " + (error?.message || error));
    }

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

    req.on("data", (chunk) => safe(() => record?.requestBody(chunk)));
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);

    upstream.on("response", (up) => {
      safe(() =>
        record?.responseHead({
          status: up.statusCode,
          reason: up.statusMessage || "",
          http_version: "HTTP/" + up.httpVersion,
          received_at: wire.rfc3339Nano(),
          headers: wire.pairHeaders(up.rawHeaders),
          body_encoding: up.headers["content-encoding"] || "",
        }),
      );
      res.writeHead(up.statusCode, up.statusMessage, forwardHeaders(up.headers));
      up.on("data", (chunk) => safe(() => record?.responseBody(chunk)));
      up.pipe(res);
      up.on("end", () => safe(() => record?.end("complete", "")));
      up.on("error", () => safe(() => record?.end("interrupted", "upstream_read_error")));
    });
    upstream.on("error", () => {
      safe(() => record?.end("interrupted", "upstream_error"));
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => {
      if (record && !record.finished) safe(() => record.end("interrupted", "client_closed"));
      upstream.destroy();
    });
  }

  // WebSocket upgrades are forwarded transparently (not recorded).
  #onUpgrade(req, clientSocket, head) {
    const host = clientSocket._frameHost;
    const port = clientSocket._framePort || 443;
    if (!host) {
      clientSocket.destroy();
      return;
    }
    const upstream = tls.connect({ host, port, servername: host }, () => {
      upstream.write(rebuildRequest(req));
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
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

function safe(fn) {
  try {
    fn();
  } catch {}
}

function splitHostPort(authority) {
  const i = authority.lastIndexOf(":");
  if (i === -1) return [authority, "443"];
  return [authority.slice(0, i), authority.slice(i + 1)];
}

function splitQuery(target) {
  const i = target.indexOf("?");
  if (i === -1) return [target, ""];
  return [target.slice(0, i), target.slice(i + 1)];
}

const HOP_BY_HOP = new Set(["connection", "proxy-connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"]);

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
