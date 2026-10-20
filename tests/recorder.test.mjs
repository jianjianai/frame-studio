import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WebSocketServer } from "ws";
import { createHash } from "node:crypto";
import * as wire from "../server/recorder/wire.mjs";
import { CertStore } from "../server/recorder/ca.mjs";
import { LrsClient } from "../server/recorder/lrs.mjs";
import { RecorderProxy } from "../server/recorder/proxy.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frame-recorder-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

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
  });

  it("gives an empty fingerprint when there is no credential", () => {
    expect(wire.userFingerprint([["Content-Type", "x"]])).toBe("");
  });
});

/** A minimal lrs.v4 server (docs/protocol.md §5) that verifies counts and ACKs. */
function mockStation() {
  const records = new Map();
  const httpServer = http.createServer();
  const wss = new WebSocketServer({
    server: httpServer,
    handleProtocols: (protocols) => (protocols.has ? protocols.has("lrs.v4") : [...protocols].includes("lrs.v4")) && "lrs.v4",
  });
  const got = {};
  wss.on("connection", (ws, req) => {
    got.authorization = req.headers["authorization"];
    ws.send(wire.encode(wire.WELCOME, Buffer.alloc(16), Buffer.from(JSON.stringify({ server_version: "4.0.0", max_message_bytes: 1048593, max_record_bytes: 268435456, idle_timeout_seconds: 600 }))), { binary: true });
    ws.on("message", (data) => {
      const frame = wire.decode(Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (!frame) return;
      const key = frame.id.toString("hex");
      let rec = records.get(key);
      if (!rec) records.set(key, (rec = { reqBytes: 0, respBytes: 0, frames: [] }));
      rec.frames.push(frame.type);
      if (frame.type === wire.BEGIN) rec.begin = JSON.parse(frame.payload.toString());
      else if (frame.type === wire.REQUEST_BODY) rec.reqBytes += frame.payload.length;
      else if (frame.type === wire.RESPONSE_HEAD) rec.head = JSON.parse(frame.payload.toString());
      else if (frame.type === wire.RESPONSE_BODY) rec.respBytes += frame.payload.length;
      else if (frame.type === wire.END) {
        rec.end = JSON.parse(frame.payload.toString());
        const ok = rec.end.request_bytes === rec.reqBytes && rec.end.response_bytes === rec.respBytes;
        ws.send(wire.encode(ok ? wire.ACK : wire.REJECT, frame.id, Buffer.from(JSON.stringify(ok ? { status: "stored" } : { code: "count_mismatch", retry: true }))), { binary: true });
      }
    });
  });
  return { httpServer, records, got };
}

async function until(predicate, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("recorder end to end", () => {
  it("MITM-records an agent's upstream call and ships it as lrs.v4", async () => {
    // Station.
    const station = mockStation();
    const stationPort = await listen(station.httpServer);
    const lrs = new LrsClient({ url: `ws://127.0.0.1:${stationPort}/api/record`, key: "collect-key", connections: 2 });
    lrs.start();
    expect(await until(() => lrs.statsView().connected === 2)).toBe(true);

    // Fake upstream (self-signed; the proxy reaches it via resolveUpstream).
    const key = path.join(tmp, "up.key");
    const cert = path.join(tmp, "up.crt");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=upstream.test"]);
    const upstream = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      let body = Buffer.alloc(0);
      req.on("data", (d) => (body = Buffer.concat([body, d])));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write("event: a\n");
        res.end("event: b\n"); // two response-body writes, like a stream
      });
    });
    const upstreamPort = await listen(upstream);

    // Proxy.
    const store = new CertStore(path.join(tmp, "ca"));
    store.ensure();
    const proxy = new RecorderProxy({
      certStore: store,
      lrs,
      shouldRecord: (host) => host === "api.anthropic.com",
      resolveUpstream: () => ({ host: "127.0.0.1", port: upstreamPort, tls: { rejectUnauthorized: false } }),
    });
    const proxyPort = await proxy.listen();

    // An agent making an HTTPS call through the proxy, trusting the proxy's CA.
    const reqBody = Buffer.from(JSON.stringify({ hello: "world" }));
    const response = await new Promise((resolve, reject) => {
      const conn = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: "api.anthropic.com:443" });
      conn.on("connect", (_res, socket) => {
        const t = tls.connect({ socket, servername: "api.anthropic.com", ca: fs.readFileSync(store.caCertPath()) }, () => {
          t.write(
            `POST /v1/messages?beta=true HTTP/1.1\r\nHost: api.anthropic.com\r\nAuthorization: Bearer sk-secret\r\nContent-Type: application/json\r\nContent-Length: ${reqBody.length}\r\nConnection: close\r\n\r\n`,
          );
          t.write(reqBody);
        });
        let buf = Buffer.alloc(0);
        t.on("data", (d) => (buf = Buffer.concat([buf, d])));
        t.on("end", () => resolve(buf.toString()));
        t.on("error", reject);
      });
      conn.on("error", reject);
      conn.end();
    });

    // The proxy forwarded the upstream response unchanged (chunked framing kept).
    expect(response).toContain("200");
    expect(response).toContain("event: a");
    expect(response).toContain("event: b");

    // The station stored exactly one record, with the expected frames and counts.
    expect(await until(() => lrs.statsView().acked === 1)).toBe(true);
    expect(station.got.authorization).toBe("Bearer collect-key");
    const rec = [...station.records.values()][0];
    expect(rec.frames).toEqual([wire.BEGIN, wire.REQUEST_BODY, wire.RESPONSE_HEAD, wire.RESPONSE_BODY, wire.END]);
    expect(rec.begin.method).toBe("POST");
    expect(rec.begin.host).toBe("api.anthropic.com");
    expect(rec.begin.path).toBe("/v1/messages");
    expect(rec.begin.query).toBe("beta=true");
    expect(rec.begin.user_fingerprint).toBe("user_" + createHash("sha256").update("Bearer sk-secret").digest("hex"));
    expect(rec.begin.headers.some(([n]) => n.toLowerCase() === "authorization")).toBe(false);
    expect(rec.begin.headers.some(([n]) => n.toLowerCase() === "content-type")).toBe(true);
    expect(rec.reqBytes).toBe(reqBody.length);
    expect(rec.respBytes).toBe(Buffer.byteLength("event: a\nevent: b\n"));
    expect(rec.head.status).toBe(200);
    expect(rec.end.outcome).toBe("complete");

    lrs.stop();
    proxy.close();
    upstream.close();
    station.httpServer.close();
  });

  it("does not record hosts outside the allowlist (plain tunnel)", async () => {
    // A tunnelled upstream the proxy must not MITM.
    const upstream = https.createServer({}, () => {});
    // Give it a cert so a TLS client could connect; we only check the proxy tunnels bytes.
    const k = path.join(tmp, "t.key");
    const c = path.join(tmp, "t.crt");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", k, "-out", c, "-days", "1", "-subj", "/CN=example.com"]);
    upstream.close();
    const tunnelTarget = https.createServer({ key: fs.readFileSync(k), cert: fs.readFileSync(c) }, (req, res) => res.end("ok"));
    const targetPort = await listen(tunnelTarget);

    const store = new CertStore(path.join(tmp, "ca2"));
    store.ensure();
    const lrs = new LrsClient({ url: "", key: "" }); // no station: begin() returns null
    const proxy = new RecorderProxy({ certStore: store, lrs, shouldRecord: () => false });
    const proxyPort = await proxy.listen();

    const got = await new Promise((resolve, reject) => {
      const conn = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: `127.0.0.1:${targetPort}` });
      conn.on("connect", (_res, socket) => {
        const t = tls.connect({ socket, rejectUnauthorized: false }, () => {
          t.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        });
        let buf = "";
        t.on("data", (d) => (buf += d));
        t.on("end", () => resolve(buf));
        t.on("error", reject);
      });
      conn.on("error", reject);
      conn.end();
    });
    expect(got).toContain("ok");
    proxy.close();
    tunnelTarget.close();
  });
});
