import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import { createServer } from "vite";
import { installPaseoGateway } from "../../server/paseo-gateway.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { paseoBoundaryHtml } from "../ui/paseo-boundary-fixture.mjs";

test("Actual request-origin bootstrap passes the strict production iframe bridge on HTTP aliases and a TLS reverse proxy", { timeout: 90000 }, async () => {
  const directory = path.resolve(".cache/paseo-origin-browser", randomUUID());
  const workId = randomUUID(), errors = [], scopes = new Set();
  let app, vite, proxy, browser;
  await fs.mkdir(directory, { recursive: true });
  try {
    // These keys belong only to this test's loopback TLS proxy, never deployment.
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem"),
      "-subj", "/CN=localhost", "-days", "1"], { stdio: "pipe" });
    const boundary = paseoBoundaryHtml({}).replace(
      "const config={},pair=", "const config=globalThis.__PASEO_FRAME_EMBED__,pair=",
    ).replace("<html>", "<html><head></head>");
    assert(boundary.includes("const config=globalThis.__PASEO_FRAME_EMBED__"));
    await fs.writeFile(path.join(directory, "index.html"), boundary);
    vite = await createServer({
      configFile: false, root: process.cwd(), cacheDir: path.join(directory, "vite"),
      logLevel: "error", appType: "custom",
      server: { middlewareMode: true, hmr: false, allowedHosts: true },
    });
    app = Fastify({ trustProxy: true });
    await installPaseoGateway({
      app, uiRoot: directory,
      manager: { ensure: async () => ({ serverId: "owned-native-server", workspaceId: "owned-workspace" }) },
      workService: { works: { get: async id => { assert.equal(id, workId); return { id, title: "Origin boundary", project: "fixture" }; } },
        status: async () => ({ native: { state: "ready" } }) },
      store: {}, authenticate: async () => { throw Error("This test must not open native sockets"); },
    });
    app.get("/__parent", async (_req, reply) => reply.type("text/html").send([
      "<!doctype html><html><body><iframe id='native'></iframe><script type='module'>",
      "import {paseoBridge} from '/studio/paseo-bridge.js';",
      "const response=await fetch('/api/paseo/works/" + workId + "/session');",
      "if(!response.ok)throw Error('Session bootstrap failed');",
      "const value=await response.json(),iframe=document.getElementById('native');",
      "window.session=value;window.connections=[];",
      "window.owner=paseoBridge({iframe,bootstrap:value.bootstrap,getContext:()=>({time:3}),",
      "freeze:()=>{throw Error('No model turn belongs to this test');},onConnection:state=>window.connections.push(state)});",
      "iframe.src=value.uiUrl;</script></body></html>",
    ].join("")));
    app.get("/*", (req, reply) => {
      reply.hijack();
      vite.middlewares(req.raw, reply.raw, error => {
        reply.raw.statusCode = error ? 500 : 404;
        reply.raw.end(error ? "Owned module transform failed" : "Not found");
      });
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = app.server.address().port;
    proxy = https.createServer({
      key: await fs.readFile(path.join(directory, "key.pem")),
      cert: await fs.readFile(path.join(directory, "cert.pem")),
    }, (req, res) => {
      const upstream = http.request("http://127.0.0.1:" + port + req.url, {
        method: req.method,
        headers: { ...req.headers, "x-forwarded-host": req.headers.host, "x-forwarded-proto": "https" },
      }, incoming => { res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res); });
      upstream.on("error", () => { res.writeHead(502); res.end("Owned reverse proxy interrupted"); });
      req.on("aborted", () => upstream.destroy()); req.pipe(upstream);
    });
    await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
    browser = await launchBrowser();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    for (const origin of [
      "http://127.0.0.1:" + port, "http://localhost:" + port,
      "https://localhost:" + proxy.address().port, "https://127.0.0.1:" + proxy.address().port,
    ]) {
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(origin + "/__parent");
        const iframe = page.locator("#native"), element = await iframe.elementHandle();
        assert(element);
        const frame = await element.contentFrame();
        await element.dispose();
        await frame.waitForFunction(() => window.__FRAME_REVIEW_PASEO__?.ready);
        const session = await page.evaluate(() => window.session);
        assert.equal(session.bootstrap.parentOrigin, origin);
        assert.equal(session.bootstrap.workId, workId);
        assert.match(session.bootstrap.nonce, /^[A-Za-z0-9_-]{24,128}$/);
        assert.deepEqual(await frame.evaluate(() => window.__PASEO_FRAME_EMBED__), session.bootstrap);
        assert.deepEqual(await frame.evaluate(() => window.__FRAME_REVIEW_PASEO__.context()), { time: 3 });
        assert.equal(new URL(frame.url()).origin, origin);
        assert.equal(new URL(frame.url()).searchParams.get("frameNonce"), session.bootstrap.nonce);
        scopes.add(session.bootstrap.userScope);
        await iframe.evaluate((node, config) => {
          node.src = config.basePath + "h/owned-native-server/workspace/owned-workspace?frameNonce=" + config.nonce;
        }, session.bootstrap);
        await page.waitForFunction(() => window.connections.filter(state => state === "ready").length === 2);
        const nextElement = await iframe.elementHandle(), reloaded = await nextElement.contentFrame();
        await nextElement.dispose();
        await reloaded.waitForFunction(() => window.__FRAME_REVIEW_PASEO__?.ready);
        assert.deepEqual(await reloaded.evaluate(() => window.__PASEO_FRAME_EMBED__), session.bootstrap);
        assert.deepEqual(await reloaded.evaluate(() => window.__FRAME_REVIEW_PASEO__.context()), { time: 3 });
        await page.evaluate(() => window.owner.dispose());
      } finally { await page.close(); }
    }
    assert.equal(scopes.size, 4, "Each actual HTTP/HTTPS alias must keep an independent storage scope");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    await app?.close();
    await vite?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
