import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import * as wire from "../server/recorder/wire.mjs";

// A station that accepts lrs.v4 and sends WELCOME, so the client reports connected.
function station() {
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    handleProtocols: (p) => (p.has ? p.has("lrs.v4") : [...p].includes("lrs.v4")) && "lrs.v4",
  });
  wss.on("connection", (ws) =>
    ws.send(wire.encode(wire.WELCOME, Buffer.alloc(16), Buffer.from(JSON.stringify({ server_version: "4.0.0", max_message_bytes: 1048593, max_record_bytes: 1, idle_timeout_seconds: 600 }))), { binary: true }),
  );
  return server;
}

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("recorder settings + lifecycle over HTTP", () => {
  let app, call, st, stPort;
  beforeAll(async () => {
    st = station();
    stPort = await new Promise((r) => st.listen(0, "127.0.0.1", () => r(st.address().port)));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-rec-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    const base = await app.listen();
    call = (route, init = {}) =>
      fetch(base + route, {
        method: init.method || "GET",
        headers: init.body ? { "Content-Type": "application/json" } : {},
        body: init.body ? JSON.stringify(init.body) : undefined,
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  });
  afterAll(() => {
    app.close();
    st.close();
  });

  it("is off by default and injects nothing", async () => {
    const res = await call("/api/recorder");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.running).toBe(false);
    expect(app.services.recorder.agentEnv()).toEqual({});
  });

  it("enables, connects to the station and injects proxy + CA env", async () => {
    const res = await call("/api/recorder", {
      method: "PATCH",
      body: { enabled: true, url: `ws://127.0.0.1:${stPort}/api/record`, key: "collect-key", connections: 2 },
    });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.hasKey).toBe(true);
    // openssl may be missing in some environments; only assert the live pool when it is available.
    if (!res.body.available) return;
    expect(res.body.running).toBe(true);
    expect(res.body.proxyPort).toBeGreaterThan(0);
    expect(await until(async () => (await call("/api/recorder")).body.stats?.connected === 2)).toBe(true);

    const env = app.services.recorder.agentEnv();
    expect(env.HTTPS_PROXY).toBe(`http://127.0.0.1:${res.body.proxyPort}`);
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(fs.existsSync(env.NODE_EXTRA_CA_CERTS)).toBe(true);
    expect(fs.existsSync(env.SSL_CERT_FILE)).toBe(true);
  });

  it("stops when disabled", async () => {
    const res = await call("/api/recorder", { method: "PATCH", body: { enabled: false } });
    expect(res.body.running).toBe(false);
    expect(app.services.recorder.agentEnv()).toEqual({});
  });
});
