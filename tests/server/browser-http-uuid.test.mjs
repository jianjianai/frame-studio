import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { browserOptions } from "../../scripts/browser.mjs";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { randomUUID as browserUUID } from "../../src/browser/uuid.mjs";

const uuidV4 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
test("browser UUID helper retains native secure UUID generation", () => {
  const ids = Array.from({ length: 1024 }, browserUUID);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, uuidV4);
});

test(
  "real insecure HTTP hostname supports secure UUIDs, live preview, WebSocket form writes and T3 Code reference IDs",
  {
    skip: !process.env.FRAME_TEST_DATABASE_URL,
    timeout: 120000,
  },
  async (t) => {
    const given = new URL(process.env.FRAME_TEST_DATABASE_URL);
    assert.match(given.pathname, /^\/frame_test/);
    const dbName = "frame_test_http_uuid_" + randomUUID().replaceAll("-", "");
    const adminUrl = new URL(given);
    adminUrl.pathname = "/postgres";
    const ownUrl = new URL(given);
    ownUrl.pathname = "/" + dbName;
    const admin = new Client({ connectionString: adminUrl.href });
    const owned = await fs.mkdtemp(path.join(os.tmpdir(), "frame-http-uuid-"));
    let created = false,
      db,
      platform,
      vite,
      browser;
    const errors = [],
      wireRequests = [];
    t.after(async () => {
      const failures = [],
        cleanup = async (fn) => {
          try {
            await fn();
          } catch (error) {
            failures.push(error);
          }
        };
      await cleanup(() => browser?.close());
      await cleanup(() => vite?.close());
      await cleanup(() => platform?.app.close());
      await cleanup(async () => {
        if (db && !db.pool.ending && !db.pool.ended) await db.pool.end();
      });
      if (created)
        await cleanup(async () => {
          const deadline = Date.now() + 5000;
          for (;;) {
            try {
              await admin.query('DROP DATABASE "' + dbName + '"');
              break;
            } catch (error) {
              // Pool shutdown can finish before PostgreSQL observes every socket close.
              // Wait for our sessions to leave; a persistent leak must still fail this test.
              if (error.code !== "55006" || Date.now() >= deadline) throw error;
              await sleep(50);
            }
          }
        });
      await cleanup(() => admin.end());
      await cleanup(() => fs.rm(owned, { recursive: true, force: true }));
      if (failures.length)
        throw new AggregateError(
          failures,
          "Owned HTTP browser fixture cleanup failed",
        );
    });
    await admin.connect();
    await admin.query('CREATE DATABASE "' + dbName + '"');
    created = true;
    db = await database(ownUrl.href, "owned-http-uuid-password-2026");
    platform = await createApp({
      db,
      data: path.join(owned, "data"),
      masterKey: "85".repeat(32),
      scheduler: false,
    });
    platform.app.log.level = "warn";
    const repo = await platform.actions.call("repositories_add", {
      name: "HTTP compatibility",
    });
    const work = await platform.actions.call("works_create", {
      repo: repo.id,
      title: "HTTP source",
      renderer: "canvas",
      duration: 2,
    });
    const { dir } = await platform.repos.project(repo.id, work.project);
    await db.lock(`${repo.id}:${work.project}`, () =>
      fs.writeFile(
        path.join(dir, "scene.ts"),
        `import type {Scene,SceneOptions} from '../../src/engine/types';
export function createScene({width,height}:SceneOptions):Scene {const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
const context=canvas.getContext('2d')!;return {canvas,render(){context.fillStyle='#dc1414';context.fillRect(0,0,width,height)},dispose(){canvas.width=1;canvas.height=1}}}`,
      ),
    );
    const live = await platform.actions.call("works_live_preview", {
      id: work.id,
    });
    await platform.app.listen({ host: "127.0.0.1", port: 0 });
    const target = "http://127.0.0.1:" + platform.app.server.address().port;
    const native = `<!doctype html><script type="module">
import {randomUUID} from '/src/browser/uuid.mjs';
const config=${JSON.stringify({ workId: work.id, nonce: "http-uuid-boundary-nonce-123456" })},pair=new MessageChannel(),pending=new Map();
window.attachments=[];window.nativeReady=false;
window.nativeRequest=(op,payload={})=>new Promise((resolve,reject)=>{const id=randomUUID();pending.set(id,{resolve,reject});pair.port1.postMessage({type:'request',id,op,payload});});
pair.port1.onmessage=({data})=>{if(data.type==='connected')window.nativeReady=true;
 if(data.type==='event'&&data.event==='context.attach')attachments.push(data.payload.item);
 if(data.type==='response'){const next=pending.get(data.id);pending.delete(data.id);data.ok?next.resolve(data.payload):next.reject(new Error(data.error.message));}};
pair.port1.start();window.submitReference=()=>window.nativeRequest('freeze.submit',{threadId:'http-agent',messageId:randomUUID(),text:'Review this actual HTTP frame',reference:{time:.5},nativeProjectId:'http-project',cwd:'/fixture/http',selection:{instanceId:'http-profile',model:'http-model'}});
parent.postMessage({type:'frame-ai-connect',version:1,...config},location.origin,[pair.port2]);
</script>`;
    vite = await createServer({
      configFile: false,
      root: process.cwd(),
      cacheDir: path.join(owned, "vite"),
      logLevel: "error",
      appType: "custom",
      server: {
        host: "127.0.0.1",
        port: 0,
        watch: null,
        allowedHosts: ["frame.insecure.test"],
        proxy: { "/api": { target, ws: true }, "/preview-live": target },
      },
      plugins: [
        {
          name: "http-uuid-regression",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (req.url === "/__login") {
                res.setHeader("Content-Type", "text/html");
                res.end(
                  "<!doctype html><title>Owned HTTP fixture login</title>",
                );
                return;
              }
              if (req.url?.startsWith(`/ai/works/${work.id}/`)) {
                res.setHeader("Content-Type", "text/html");
                res.end(native);
                return;
              }
              if (req.url !== "/__http") {
                next();
                return;
              }
              res.setHeader("Content-Type", "text/html");
              res.end(`<!doctype html><form id="rename"><input name="title" value="HTTP edited"><button>Save</button></form><output id="saved"></output>
<iframe id="player" src=${JSON.stringify(live.url + (live.url.includes("?") ? "&" : "?") + "debug=1")}></iframe><iframe id="native"></iframe><script type="module">
import {randomUUID} from '/src/browser/uuid.mjs';import {socketCall,subscribe} from '/studio/realtime.ts';import {aiBridge} from '/studio/ai-bridge.js';
window.uuidProof=()=>Array.from({length:4096},()=>randomUUID());window.frozen=[];
document.getElementById('rename').onsubmit=async event=>{event.preventDefault();const title=new FormData(event.target).get('title');
 const result=await socketCall('works_update',{id:${JSON.stringify(work.id)},title});document.getElementById('saved').textContent=result.title;};
const bootstrap={version:1,workId:${JSON.stringify(work.id)},userScope:'http-test-admin',nonce:'http-uuid-boundary-nonce-123456',basePath:'/ai/',embedPath:${JSON.stringify(`/ai/works/${work.id}/`)},parentOrigin:location.origin,environmentId:'http-server',projectId:'http-project',cwd:'/fixture/http',label:'HTTP boundary'};
const iframe=document.getElementById('native');window.bridge=aiBridge({iframe,bootstrap,getContext:()=>({time:.5}),
 freeze:async input=>{window.frozen.push(input);return {version:1,workId:bootstrap.workId,threadId:input.threadId,messageId:input.messageId,intentHash:'a'.repeat(64),context:input.reference,reviewReference:{status:'unversioned'}};}});
iframe.src=bootstrap.embedPath+'?frameNonce='+bootstrap.nonce;
window.unwatch=subscribe('works_sync_status',{id:bootstrap.workId},value=>{window.sync=value;});
</script>`);
            });
          },
        },
      ],
    });
    await vite.listen();
    const port = vite.httpServer.address().port,
      origin = "http://frame.insecure.test:" + port;
    const options = browserOptions();
    browser = await chromium.launch({
      ...options,
      args: [
        ...options.args,
        "--host-resolver-rules=MAP frame.insecure.test 127.0.0.1",
        "--no-proxy-server",
      ],
    });
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (ws) =>
      ws.on("framesent", (event) => {
        try {
          const value = JSON.parse(String(event.payload));
          if (["call", "subscribe"].includes(value.type))
            wireRequests.push(value);
        } catch {}
      }),
    );
    await page.goto(origin + "/__login", { waitUntil: "domcontentloaded" });
    // No injected feature overrides: this genuine ordinary HTTP hostname lacks the secure-context API.
    const environment = await page.evaluate(() => ({
      secure: isSecureContext,
      nativeUUID: typeof crypto.randomUUID,
      randomBytes: typeof crypto.getRandomValues,
    }));
    assert.deepEqual(environment, {
      secure: false,
      nativeUUID: "undefined",
      randomBytes: "function",
    });
    const login = await page.evaluate(async () => {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "owned-http-uuid-password-2026" }),
      });
      return response.status;
    });
    assert.equal(login, 200);
    await page.goto(origin + "/__http", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.uuidProof === "function");
    const ids = await page.evaluate(() => window.uuidProof());
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, uuidV4);
    const player = await (
      await page.locator("#player").elementHandle()
    ).contentFrame();
    await player.waitForFunction(
      () =>
        window.__FRAME_STUDIO__?.ready ||
        window.__FRAME_LIVE_STATUS__?.state === "error",
      null,
      { timeout: 60000 },
    );
    const ready = await player.evaluate(() => ({
      ready: window.__FRAME_STUDIO__?.ready,
      status: window.__FRAME_LIVE_STATUS__,
      text: document.body.innerText,
      secure: isSecureContext,
      nativeUUID: typeof crypto.randomUUID,
    }));
    assert.equal(ready.ready, true, JSON.stringify(ready));
    assert.equal(ready.secure, false);
    assert.equal(ready.nativeUUID, "undefined");
    await player.waitForFunction(() =>
      [...document.querySelectorAll("canvas")].some((canvas) => {
        const context = canvas.getContext("2d");
        if (!context || canvas.width < 20) return false;
        const pixel = context.getImageData(10, 10, 1, 1).data;
        return pixel[0] === 220 && pixel[1] === 20 && pixel[2] === 20;
      }),
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(
      () => document.getElementById("saved").textContent === "HTTP edited",
    );
    assert.equal(
      (await platform.actions.works.get(work.id)).title,
      "HTTP edited",
    );
    assert(
      wireRequests.some(
        (item) => item.type === "call" && item.name === "works_update",
      ),
    );
    const wireIds = wireRequests.map((item) => item.id);
    assert.equal(new Set(wireIds).size, wireIds.length);
    for (const id of wireIds) assert.match(id, uuidV4);
    const frame = await (
      await page.locator("#native").elementHandle()
    ).contentFrame();
    await frame.waitForFunction(() => window.nativeReady);
    await frame.evaluate(() =>
      window.nativeRequest("context.attach", { threadId: "http-agent" }),
    );
    await frame.waitForFunction(() => window.attachments.length === 1);
    const attachment = await frame.evaluate(() => window.attachments[0]);
    assert.match(attachment.id, uuidV4);
    const submitted = await frame.evaluate(() => window.submitReference());
    assert.match(submitted.messageId, uuidV4);
    assert.equal(
      await page.evaluate(() => window.frozen[0].messageId),
      submitted.messageId,
    );
    assert.deepEqual(errors, []);
    // The native helper branch also runs in a genuinely trustworthy loopback browser context.
    await page.goto("http://127.0.0.1:" + port + "/src/browser/uuid.mjs");
    const nativeProof = await page.evaluate(async () => {
      const { randomUUID } = await import("/src/browser/uuid.mjs");
      return {
        secure: isSecureContext,
        nativeUUID: typeof crypto.randomUUID,
        id: randomUUID(),
      };
    });
    assert.equal(nativeProof.secure, true);
    assert.equal(nativeProof.nativeUUID, "function");
    assert.match(nativeProof.id, uuidV4);
    t.diagnostic(
      JSON.stringify({
        httpHostname: "frame.insecure.test",
        secureContext: false,
        generatedUniqueUUIDs: ids.length,
        livePreviewReady: true,
        websocketFormSaved: true,
        referenceAttachmentAndMessage: true,
        nativeSecureBranch: true,
      }),
    );
  },
);
