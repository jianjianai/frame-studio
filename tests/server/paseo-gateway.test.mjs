import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { gzipSync, brotliCompressSync } from "node:zlib";
import Fastify from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { installPaseoGateway } from "../../server/paseo-gateway.mjs";

async function fixture(t) {
  const directory = path.resolve(".cache/paseo-gateway-tests", randomUUID());
  await fs.mkdir(path.join(directory, "_expo"), { recursive: true });
  const source = "globalThis.nativePaseo=true;";
  await fs.writeFile(path.join(directory, "index.html"), "<html><head></head><body>Official UI</body></html>");
  await fs.writeFile(path.join(directory, "_expo/app.js"), source);
  await fs.writeFile(path.join(directory, "_expo/app.js.gz"), gzipSync(source));
  await fs.writeFile(path.join(directory, "_expo/app.js.br"), brotliCompressSync(source));
  const workId = randomUUID(), messageId = randomUUID(), nativeRequests = [];
  const native = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    nativeRequests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(201, { "content-type": "application/octet-stream",
      "set-cookie": "native-cookie=private", location: "/api/result?version=1" });
    res.end(Buffer.concat(chunks));
  });
  const nativeWss = new WebSocketServer({ server: native, path: "/ws" });
  nativeWss.on("connection", (socket, req) => {
    assert.equal(req.headers.authorization, "Bearer work-only-private");
    assert.equal(req.headers.cookie, undefined);
    socket.on("message", (bytes, binary) => socket.send(bytes, { binary }));
  });
  await new Promise(resolve => native.listen(0, "127.0.0.1", resolve));
  const endpoint = "http://127.0.0.1:" + native.address().port;
  let closing = false;
  const binding = { state: "ready", endpoint };
  const manager = {
    ensure: async () => ({ workspaceId: "/owned-draft", serverId: "native-server" }),
    control: async () => ({ capability: "work-only-private" }),
    authorize: async (id, value) => id === workId && value === "work-only-private",
    beginClose: () => { closing = true; },
  };
  const workService = { works: { get: async id => {
    assert.equal(id, workId); return { id, title: "</script><unsafe>", project: "fixture" };
  } }, status: async () => ({ native: { state: "ready" } }) };
  const store = { getWork: async () => binding,
    getMessage: async key => key.messageId === messageId && key.agentId === "owned-agent"
      ? { execution: { nativeSelection: { provider: "frame-profile", model: "frozen-model" }, apiKey: "never-public" } } : null };
  const app = Fastify();
  await installPaseoGateway({ app, manager, workService, store, uiRoot: directory,
    authenticate: async req => {
      if (req.headers.authorization !== "Bearer frame-browser-session") throw Object.assign(Error("Unauthorized"), { statusCode: 401 });
    }, origin: "http://127.0.0.1:3000", data: directory });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    for (const socket of nativeWss.clients) socket.terminate();
    await new Promise(resolve => nativeWss.close(resolve));
    await new Promise(resolve => native.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { app, workId, messageId, source, nativeRequests, base: "http://127.0.0.1:" + app.server.address().port,
    closing: () => closing };
}
test("Official UI bootstrap, precompressed resources and work-scoped frozen selection preserve exact identities", async t => {
  const f = await fixture(t);
  const nonce = "n".repeat(32);
  const html = await f.app.inject("/paseo/" + f.workId + "/?frameNonce=" + nonce);
  assert.equal(html.statusCode, 200);
  assert.match(html.body, /globalThis\.__PASEO_FRAME_EMBED__/);
  assert.match(html.body, /\\u003c\/script>/);
  assert.match(html.body, new RegExp(nonce));
  assert.doesNotMatch(html.body, /work-only-private|never-public/);
  const original = await f.app.inject({ url: "/paseo/_expo/app.js", headers: { "accept-encoding": "br;q=0.0, gzip;q=0" } });
  assert.equal(original.headers["content-encoding"], undefined);
  assert.equal(original.body, f.source);
  const compressed = await f.app.inject({ url: "/paseo/_expo/app.js", headers: { "accept-encoding": "gzip, br" } });
  assert.equal(compressed.headers["content-encoding"], "br");
  assert.deepEqual(compressed.rawPayload, brotliCompressSync(f.source));
  assert.equal(compressed.headers.vary, "Accept-Encoding");
  const url = "/api/paseo/internal/" + f.workId + "/messages/" + f.messageId + "/selection?agentId=owned-agent";
  assert.equal((await f.app.inject(url)).statusCode, 401);
  const selection = await f.app.inject({ url, headers: { authorization: "Bearer work-only-private" } });
  assert.deepEqual(selection.json(), { version: 1, frozen: true, selection: { provider: "frame-profile", model: "frozen-model" } });
  assert.doesNotMatch(selection.body, /never-public/);
  const absent = await f.app.inject({ url: url.replace(f.messageId, randomUUID()), headers: { authorization: "Bearer work-only-private" } });
  assert.deepEqual(absent.json(), { version: 1, frozen: false });
});
test("Native HTTP and binary WebSocket forwarding preserve payloads and shutdown remains bounded", { timeout: 15000 }, async t => {
  const f = await fixture(t), input = Buffer.from([0, 128, 255, 13, 10, 32]);
  const response = await new Promise((resolve, reject) => {
    const req = http.request(f.base + "/paseo/" + f.workId + "/api/upload?version=1", {
      method: "POST", headers: { authorization: "Bearer frame-browser-session", cookie: "frame=browser-private",
        "content-type": "application/octet-stream", "content-length": input.length },
    }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once("error", reject); req.end(input);
  });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, input);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers.location, "/paseo/" + f.workId + "/api/result?version=1");
  assert.equal(f.nativeRequests[0].headers.authorization, "Bearer work-only-private");
  assert.equal(f.nativeRequests[0].headers.cookie, undefined);
  assert.equal(f.nativeRequests[0].url, "/api/upload?version=1");
  const socket = new WebSocket(f.base.replace("http:", "ws:") + "/paseo/" + f.workId + "/ws", {
    headers: { authorization: "Bearer frame-browser-session", cookie: "frame=browser-private" },
  });
  t.after(() => socket.terminate());
  await once(socket, "open");
  // Match native ws defaults: an official attachment above 16 MiB is not truncated by FRAME.
  const large = Buffer.alloc(17 * 1024 * 1024, 149);
  const echoed = once(socket, "message");
  socket.send(large);
  const [bytes, binary] = await echoed;
  assert.equal(binary, true); assert.deepEqual(bytes, large);
  socket.pause();
  const started = Date.now();
  await f.app.close();
  assert.ok(f.closing());
  assert.ok(Date.now() - started < 5000, "An unresponsive native socket blocked application shutdown");
});
