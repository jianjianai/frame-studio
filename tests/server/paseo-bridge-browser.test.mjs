import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "../../scripts/browser.mjs";
import {
  paseoBoundaryBootstrap,
  paseoBoundaryHtml,
} from "../ui/paseo-boundary-fixture.mjs";
const workId = "cc8c4ec2-a1aa-41ed-8fdc-8a98684f5c4a";
const messageId = "fced05e2-9f68-4a0c-b446-61df118d8541";
test(
  "The production Paseo parent bridge isolates windows and cancels replaced pending ports",
  { timeout: 60000 },
  async () => {
    let bootstrap;
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      cacheDir: path.resolve(".cache/tests/paseo-bridge-" + process.pid),
      logLevel: "error",
      appType: "custom",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "paseo-parent-boundary",
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url === "/__parent") {
                res.setHeader("Content-Type", "text/html");
                res.end(`<!doctype html><html><body><iframe id="native"></iframe><script type="module">
          import {paseoBridge} from '/studio/paseo-bridge.js';
          const config=${JSON.stringify(bootstrap)},iframe=document.getElementById('native');
          window.trace={contextCalls:0,freezeCalls:[],aborted:0,mode:'resolve',releases:[],connections:[]};
          const trace=window.trace;
          window.owner=paseoBridge({iframe,bootstrap:config,getContext:()=>{trace.contextCalls++;return {time:5};},
            freeze:(body,signal)=>{trace.freezeCalls.push(body);return new Promise((resolve,reject)=>{
              const finish=()=>resolve({version:1,workId:config.workId,agentId:body.agentId,messageId:body.messageId,intentHash:'a'.repeat(64),context:body.context,reviewReference:{status:'unversioned'}});
              signal.addEventListener('abort',()=>{trace.aborted++;reject(new DOMException('Cancelled','AbortError'));},{once:true});
              if(trace.mode==='resolve')finish();else trace.releases.push(finish);
            });},onConnection:state=>trace.connections.push(state)});
          iframe.src=config.basePath+'?frameNonce='+config.nonce;
          </script></body></html>`);
                return;
              }
              if (bootstrap && req.url?.startsWith(bootstrap.basePath)) {
                res.setHeader("Content-Type", "text/html");
                res.end(paseoBoundaryHtml(bootstrap));
                return;
              }
              next();
            });
          },
        },
      ],
    });
    let browser;
    try {
      await server.listen();
      const origin = "http://127.0.0.1:" + server.httpServer.address().port;
      bootstrap = paseoBoundaryBootstrap({ workId, origin });
      browser = await launchBrowser();
      const page = await browser.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin + "/__parent");
      let frame = await (
        await page.locator("#native").elementHandle()
      ).contentFrame();
      await frame.waitForFunction(() => window.__FRAME_REVIEW_PASEO__?.ready);
      assert.deepEqual(
        await frame.evaluate(() => window.__FRAME_REVIEW_PASEO__.context()),
        { time: 5 },
      );
      const before = await page.evaluate(() => window.trace.contextCalls);
      // A sibling same-origin iframe has no authority even with the real work ID and nonce.
      await page.evaluate(
        (config) =>
          new Promise((resolve) => {
            const foreign = document.createElement("iframe");
            foreign.id = "foreign";
            foreign.srcdoc =
              "<script>const pair=new MessageChannel();parent.postMessage(" +
              JSON.stringify({
                type: "frame-paseo-connect",
                version: 1,
                workId: config.workId,
                nonce: config.nonce,
              }) +
              "," +
              JSON.stringify(location.origin) +
              ",[pair.port2]);<\/script>";
            foreign.onload = () => setTimeout(resolve, 80);
            document.body.append(foreign);
          }),
        bootstrap,
      );
      await frame.evaluate((config) => {
        const pair = new MessageChannel();
        parent.postMessage(
          {
            type: "frame-paseo-connect",
            version: 1,
            workId: config.workId,
            nonce: "wrong-nonce-123456789012345",
          },
          config.parentOrigin,
          [pair.port2],
        );
      }, bootstrap);
      assert.deepEqual(
        await frame.evaluate(() => window.__FRAME_REVIEW_PASEO__.context()),
        { time: 5 },
      );
      assert.equal(
        await page.evaluate(() => window.trace.contextCalls),
        before + 1,
      );
      const input = {
        agentId: "owned-agent",
        messageId,
        prompt: "Keep this frame",
        profileId: "codex",
        model: "fixture",
        context: { time: 5 },
        attachmentsFingerprint: "a".repeat(64),
      };
      assert.equal(
        (
          await frame.evaluate(
            (input) =>
              window.__FRAME_REVIEW_PASEO__.request("freeze.submit", input),
            input,
          )
        ).messageId,
        messageId,
      );
      await page.evaluate(() => {
        window.trace.mode = "defer";
      });
      await frame.evaluate((input) => {
        window.__pendingFreeze = window.__FRAME_REVIEW_PASEO__
          .request("freeze.submit", input)
          .catch(() => null);
      }, input);
      await page.waitForFunction(() => window.trace.freezeCalls.length === 2);
      await frame.goto(frame.url());
      await frame.waitForFunction(() => window.__FRAME_REVIEW_PASEO__?.ready);
      await page.waitForFunction(() => window.trace.aborted === 1);
      const next = frame.evaluate(
        (input) =>
          window.__FRAME_REVIEW_PASEO__.request("freeze.submit", input),
        input,
      );
      await page.waitForFunction(() => window.trace.freezeCalls.length === 3);
      await page.evaluate(() => {
        window.owner.dispose();
      });
      await assert.rejects(next, /Frame closed/);
      await page.waitForFunction(() => window.trace.aborted === 2);
      const after = await page.evaluate(() => window.trace.contextCalls);
      await page.evaluate(() => {
        window.trace.releases.forEach((release) => release());
      });
      assert.equal(await page.evaluate(() => window.trace.contextCalls), after);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
