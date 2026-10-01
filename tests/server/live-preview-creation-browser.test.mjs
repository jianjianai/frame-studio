import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { launchBrowser } from "../../scripts/browser.mjs";
import {
  paseoBoundaryBootstrap,
  paseoBoundaryHtml,
} from "../ui/paseo-boundary-fixture.mjs";

const workId = "e68a0b4b-0a63-463e-861b-7f3403220255";
const taskId = "485dc032-fdb9-43e2-b8ec-e383d5bcb424";
const sessionWork = "b79b5738-b9ab-46ca-953b-168e1bfc9c60";
const sessionTask = "c46d6bcd-bca7-40fb-b454-b25b078e55e7";
const component = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Creation } from '/studio/creation.jsx';
import '/studio/workbench.css';
import '/studio/workspace.css';
localStorage.setItem('frame.work-tool','""');
createRoot(document.getElementById('root')).render(<Creation id="${workId}" notify={()=>{}}/>);
`;
const player = `<!doctype html><html><body><div id="frame">Last good frame</div><script>
window.instance=crypto.randomUUID();
window.state={time:0,duration:60,fps:30,playing:false,buffering:false,rate:1,loop:false,volume:0.7,muted:false,subtitles:true,selection:{}};
window.emitState=(patch)=>{Object.assign(window.state,patch);parent.postMessage({type:'frame-player-state',...window.state},'*');};
window.emitRevision=(state,hash,error)=>parent.postMessage({type:'frame-live-preview',state,sourceRevision:hash,...(error?{error}: {})},'*');
addEventListener('message',({data})=>{
 if(data.type==='frame-live-retry'){window.retryCount=(window.retryCount||0)+1;return;}
 if(data.type!=='frame-player-command')return;
 if(data.command==='configure-work')window.context=data.context;
 if(data.command==='configure-view')window.preferences=data.preferences;
 if(data.command==='restore-session'){window.restored=data.state;window.emitState(data.state);}
});
parent.postMessage({type:'frame-player-ready'},'*');
parent.postMessage({type:'frame-preview-loading',message:''},'*');
window.emitRevision('ready','a'.repeat(64));
</script></body></html>`;

test(
  "Creation uses live preview without build, preserves iframe through revisions and restores state when joining AI draft",
  { timeout: 60000 },
  async () => {
    const virtualFile = path.resolve("tests/ui/live-creation-fixture.jsx");
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      cacheDir: path.resolve(".cache/tests/live-creation-" + process.pid),
      logLevel: "error",
      appType: "custom",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        react(),
        {
          name: "live-creation-fixture",
          resolveId(id) {
            if (["/live-creation.jsx", virtualFile].includes(id))
              return virtualFile;
          },
          load(id) {
            if (id === virtualFile) return component;
          },
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url === "/__creation") {
                res.setHeader("Content-Type", "text/html");
                void vite
                  .transformIndexHtml(
                    req.url,
                    '<!doctype html><html><body><div id="root"></div><script type="module" src="/live-creation.jsx"></script></body></html>',
                  )
                  .then((html) => res.end(html), next);
              } else if (req.url?.startsWith("/__live-player")) {
                res.setHeader("Content-Type", "text/html");
                res.end(player);
              } else next();
            });
          },
        },
      ],
    });
    let browser;
    try {
      await server.listen();
      browser = await launchBrowser();
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.error("fixture-pageerror", error.message);
      });
      page.on("console", (message) => {
        if (message.type() === "error")
          console.error("fixture-console", message.text());
      });
      await page.addInitScript(
        ({ workId, taskId, sessionWork, sessionTask }) => {
          const Native = WebSocket;
          window.fixtureCalls = [];
          window.fixtureTasks = [];
          window.fixtureSockets = [];
          const resultFor = (name, args) => {
            if (name === "works_open")
              return {
                id: workId,
                repo: "e51a1304-4e56-43a4-9645-22b12c59ad27",
                project: "live-test",
                title: "Live creation",
              };
            if (name === "works_tasks") return window.fixtureTasks;
            if (name === "works_preview_status")
              return {
                runtimeFingerprint: "fixture",
                sourceRevision: "a".repeat(64),
                previewRevision: null,
                indexedAt: null,
                indexingRequired: false,
                stale: true,
                latest: null,
              };
            if (name === "works_sync_status")
              return { remote: false, dirty: 0, ahead: 0, behind: 0 };
            if (name === "works_live_preview")
              return {
                url: "/__live-player?source=" + (args.task ? "task" : "work"),
                sessionId: args.task ? sessionTask : sessionWork,
                sourceRevision: "a".repeat(64),
                source: args.task ? "task" : "work",
                state: "ready",
                revision: 1,
                expires: new Date(Date.now() + 3600000).toISOString(),
              };
            return [];
          };
          window.WebSocket = class extends EventTarget {
            static CONNECTING = 0;
            static OPEN = 1;
            static CLOSING = 2;
            static CLOSED = 3;
            constructor(url, ...rest) {
              super();
              if (!String(url).includes("/api/ws"))
                return new Native(url, ...rest);
              this.readyState = 0;
              this.subs = new Map();
              window.fixtureSockets.push(this);
              queueMicrotask(() => {
                this.readyState = 1;
                const e = new Event("open");
                this.dispatchEvent(e);
                this.onopen?.(e);
              });
            }
            send(value) {
              const call = JSON.parse(value);
              if (call.type === "unsubscribe") {
                this.subs.delete(call.id);
                return;
              }
              if (call.type === "subscribe") this.subs.set(call.id, call);
              window.fixtureCalls.push(call);
              const message = {
                type: call.type === "subscribe" ? "update" : "result",
                id: call.id,
                result: resultFor(call.name, call.args),
              };
              setTimeout(
                () => this.onmessage?.({ data: JSON.stringify(message) }),
                5,
              );
            }
            close() {
              this.readyState = 3;
              const event = new Event("close");
              this.dispatchEvent(event);
              this.onclose?.({ code: 1000 });
            }
            pushTasks() {
              for (const call of this.subs.values())
                if (call.name === "works_tasks")
                  this.onmessage?.({
                    data: JSON.stringify({
                      type: "update",
                      id: call.id,
                      result: window.fixtureTasks,
                    }),
                  });
            }
          };
          window.joinDraft = () => {
            window.fixtureTasks = [
              {
                id: taskId,
                kind: "agent",
                state: "running",
                work_id: workId,
                chat: "other-chat",
                created_at: new Date().toISOString(),
              },
            ];
            for (const ws of window.fixtureSockets) ws.pushTasks();
          };
          window.leaveDraft = () => {
            window.fixtureTasks = [];
            for (const ws of window.fixtureSockets) ws.pushTasks();
          };
        },
        { workId, taskId, sessionWork, sessionTask },
      );
      const origin = "http://127.0.0.1:" + server.httpServer.address().port;
      const paseo = paseoBoundaryBootstrap({ workId, origin });
      await page.route("**/api/paseo/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/session"))
          return route.fulfill({
            json: {
              bootstrap: paseo,
              uiUrl: paseo.basePath + "?frameNonce=" + paseo.nonce,
            },
          });
        if (url.pathname.endsWith("/status"))
          return route.fulfill({
            json: {
              version: 1,
              workId,
              native: {
                state: "ready",
                activeAgents: [],
                activeTerminals: 0,
                pendingPermissions: 0,
                scheduled: 0,
                incomplete: false,
              },
              candidate: null,
            },
          });
        return route.fulfill({
          status: 404,
          json: { error: "Unexpected fixture request" },
        });
      });
      await page.route("**/paseo/**", (route) => {
        if (!new URL(route.request().url()).pathname.startsWith(paseo.basePath))
          return route.fallback();
        return route.fulfill({
          contentType: "text/html",
          body: paseoBoundaryHtml(paseo),
        });
      });
      await page.goto(origin + "/__creation");
      await expect(page.locator('iframe[title="作品播放器"]'))
        .toBeVisible()
        .catch(async (error) => {
          console.error(
            "initial-fixture-diagnostic",
            await page.locator("body").innerText(),
            await page.evaluate(() => window.fixtureCalls),
          );
          throw error;
        });
      const currentFrame = () =>
        page
          .locator('iframe[title="作品播放器"]')
          .elementHandle()
          .then((el) => el.contentFrame());
      let frame = await currentFrame();
      await frame.waitForFunction(() => window.context?.previewMode === "live");
      const instance = await frame.evaluate(() => window.instance);
      await frame.evaluate(() => {
        window.emitState({
          time: 17,
          rate: 1.5,
          loop: true,
          muted: true,
          selection: { start: 12, end: 22 },
        });
        window.emitRevision("updating", "b".repeat(64));
      });
      await frame.evaluate(() => window.emitRevision("ready", "b".repeat(64)));
      assert.equal(
        await (await currentFrame()).evaluate(() => window.instance),
        instance,
        "saved revisions leave the persistent iframe intact",
      );
      await frame.evaluate(() =>
        window.emitRevision("error", "c".repeat(64), "Fixture syntax error"),
      );
      await expect(page.locator(".live-preview-note")).toContainText(
        "Fixture syntax error",
      );
      await page
        .getByRole("button", { name: "重新连接实时预览", exact: true })
        .click();
      await frame.waitForFunction(() => window.retryCount === 1);
      assert.equal(
        await (await currentFrame()).evaluate(() => window.instance),
        instance,
        "explicit retry reaches the live shell without remounting it",
      );
      assert.equal(
        await frame.evaluate(
          () => document.getElementById("frame").textContent,
        ),
        "Last good frame",
      );
      await frame.evaluate(() => window.emitRevision("ready", "d".repeat(64)));
      await expect(page.locator(".live-preview-note")).toHaveCount(0);
      await page
        .getByRole("button", { name: "打开 AI 对话", exact: true })
        .click();
      const nativeElement = page.locator('iframe[title^="Paseo ·"]');
      await expect(nativeElement).toBeVisible();
      const native = await (await nativeElement.elementHandle()).contentFrame();
      await native.waitForFunction(() => window.__FRAME_REVIEW_PASEO__?.ready);
      const reference = await native.evaluate(() =>
        window.__FRAME_REVIEW_PASEO__.context(),
      );
      assert.equal(reference.liveSessionId, sessionWork);
      assert.equal(reference.sourceRevision, "d".repeat(64));
      assert.equal(reference.sourceCommit, undefined);
      await page.evaluate(() => window.joinDraft());
      await expect(page.locator('iframe[title="作品播放器"]')).toHaveAttribute(
        "src",
        /source=task/,
      );
      frame = await currentFrame();
      await frame.waitForFunction(() => window.restored?.time === 17);
      assert.deepEqual(
        await frame.evaluate(() => ({
          time: window.restored.time,
          rate: window.restored.rate,
          loop: window.restored.loop,
          muted: window.restored.muted,
          selection: window.restored.selection,
        })),
        {
          time: 17,
          rate: 1.5,
          loop: true,
          muted: true,
          selection: { start: 12, end: 22 },
        },
      );
      await frame.waitForFunction(
        () => window.context?.previewSource === "task",
      );
      await page.evaluate(() => window.leaveDraft());
      await expect(page.locator('iframe[title="作品播放器"]')).toHaveAttribute(
        "src",
        /source=work/,
      );
      frame = await currentFrame();
      await frame.waitForFunction(() => window.restored?.time === 17);
      const calls = await page.evaluate(() => window.fixtureCalls);
      assert.equal(
        calls.filter(
          (call) => call.type === "call" && call.name === "works_task",
        ).length,
        0,
        "no automatic full build is submitted",
      );
      assert(
        calls.some(
          (call) =>
            call.name === "works_live_preview" && call.args.task === taskId,
        ),
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
