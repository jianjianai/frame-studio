import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { launchBrowser } from "../../scripts/browser.mjs";
import {
  aiBoundaryBootstrap,
  aiBoundaryHtml,
} from "../ui/ai-boundary-fixture.mjs";

const workId = "e68a0b4b-0a63-463e-861b-7f3403220255";
const component = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Creation} from '/studio/creation.jsx';
import '/studio/workbench.css';
import '/studio/workspace.css';
import '/studio/work-tools.css';
localStorage.setItem('frame.work-tool','""');
createRoot(document.getElementById('root')).render(
  <div className="workbench work-focus"><main className="workspace">
    <Creation id="${workId}" notify={()=>{}}/>
  </main></div>);
`;

// Exercise the production bridge and Creation in an opaque frame. Only the client
// and backend are controlled; the cache implementation has its own browser suite.
const child = `<!doctype html><html><body><p>Preview fixture</p><script type="module">
import {installPreviewMediaBridge} from '/src/ui/preview-media-bridge.ts';
window.instance=crypto.randomUUID();
window.commands=[];window.channel='';
const emptyCache={state:'idle',revision:1,totalBytes:0,downloadedBytes:0,totalFiles:0,completeFiles:0,persistentFiles:0,remaining:[]};
let mode=new URL(location.href).searchParams.get('mediaMode')||'compressed';
let cache={...emptyCache};
let retryResolve;
const client={
 mode:()=>mode,
 cacheState:()=>cache,
 setMode(value){commands.push({action:'mode',mode:value});mode=value;bridge.update();},
 cancelCache(){commands.push({action:'cancel'});cache={...cache,state:'cancelled'};bridge.update();},
 retry(){commands.push({action:'retry'});return new Promise(resolve=>{retryResolve=()=>{cache={...cache,state:'ready',remaining:[],completeFiles:cache.totalFiles,downloadedBytes:cache.totalBytes};bridge.update();resolve();};});},
 async clearCache(){commands.push({action:'clear'});cache={...emptyCache,state:'cancelled'};bridge.update();}
};
let bridge;
setTimeout(()=>{bridge=installPreviewMediaBridge(client,()=>{},()=>{});window.fixtureReady=true;},300);
window.patchCache=patch=>{cache={...cache,...patch};bridge.update();};
window.finishRetry=()=>retryResolve?.();
window.exportBusy=value=>{window.__FRAME_PREVIEW_READERS__=value?1:0;dispatchEvent(new Event('frame-preview-readers'));};
window.mediaState=()=>({mode,cache,exportBusy:false,controlError:'',pendingAction:''});
window.publishAs=(channel,patch)=>parent.postMessage({type:'frame-preview-media-state',channel,state:{...window.mediaState(),...patch}},'*');
window.startPlayer=()=>{
 window.playerStarted=true;
 parent.postMessage({type:'frame-player-ready'},'*');
 parent.postMessage({type:'frame-preview-loading',message:''},'*');
 parent.postMessage({type:'frame-live-preview',state:'ready',sourceRevision:'a'.repeat(64)},'*');
};
addEventListener('message',event=>{
 const {data}=event;
 if(data.type==='frame-preview-media-command'&&window.commandDelay&&!data.fixtureDelayed){event.stopImmediatePropagation();setTimeout(()=>dispatchEvent(new MessageEvent('message',{source:parent,data:{...data,fixtureDelayed:true}})),window.commandDelay);return;}
 if(data.type==='frame-preview-media-subscribe')window.channel=data.channel;
 if(data.type==='frame-player-command'&&data.command==='configure-work')window.context=data.context;
});
</script></body></html>`;

function installBackend({ workId }) {
  const Native = WebSocket;
  window.fixtureCalls = [];
  window.fixtureTasks = [];
  window.fixtureSockets = [];
  window.fixturePreviewGeneration = 0;
  const resultFor = (name, args) => {
    if (name === "works_open")
      return {
        id: workId,
        repo: "e51a1304-4e56-43a4-9645-22b12c59ad27",
        project: "media-test",
        title: "素材模式浏览器回归",
      };
    if (name === "works_tasks") return window.fixtureTasks;
    if (name === "works_preview_status")
      return {
        runtimeFingerprint: "media-fixture",
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
        url:
          "/__media-player?source=work&generation=" +
          window.fixturePreviewGeneration,
        sessionId: window.fixturePreviewGeneration
          ? "c46d6bcd-bca7-40fb-b454-b25b078e55e7"
          : "b79b5738-b9ab-46ca-953b-168e1bfc9c60",
        sourceRevision: "a".repeat(64),
        source: "work",
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
      if (!String(url).includes("/api/ws")) return new Native(url, ...rest);
      this.readyState = 0;
      this.subs = new Map();
      window.fixtureSockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        const event = new Event("open");
        this.dispatchEvent(event);
        this.onopen?.(event);
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
      setTimeout(
        () =>
          this.onmessage?.({
            data: JSON.stringify({
              type: call.type === "subscribe" ? "update" : "result",
              id: call.id,
              result: resultFor(call.name, call.args),
            }),
          }),
        5,
      );
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
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
  window.replacePreviewSession = () => {
    window.fixturePreviewGeneration++;
  };
}

test(
  "material modes use the side dock, retain the live iframe and reject stale bridge state",
  { timeout: 120000 },
  async () => {
    const virtualFile = path.resolve("tests/ui/preview-media-fixture.jsx");
    const cacheDir = path.resolve(".cache/tests/preview-media-" + randomUUID());
    const screenshots = path.join(cacheDir, "screenshots");
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      cacheDir,
      logLevel: "error",
      appType: "custom",
      server: {
        host: "127.0.0.1",
        port: Number(process.env.FRAME_TEST_PORT || 55841),
        strictPort: true,
        cors: true,
        watch: null,
      },
      plugins: [
        react(),
        {
          name: "preview-media-fixture",
          resolveId(id) {
            if (["/preview-media-fixture.jsx", virtualFile].includes(id))
              return virtualFile;
          },
          load(id) {
            if (id === virtualFile) return component;
          },
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url === "/__media-workbench") {
                res.setHeader("Content-Type", "text/html");
                void vite
                  .transformIndexHtml(
                    req.url,
                    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/preview-media-fixture.jsx"></script></body></html>',
                  )
                  .then((html) => res.end(html), next);
              } else if (req.url?.startsWith("/__media-player")) {
                res.setHeader("Content-Type", "text/html");
                res.end(child);
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
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const errors = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.error("media-pageerror", error.message);
      });
      page.on("console", (message) => {
        if (message.type() === "error")
          console.error("media-console", message.text());
      });
      await page.addInitScript(installBackend, { workId });
      const origin = "http://127.0.0.1:" + server.httpServer.address().port;
      const ai = aiBoundaryBootstrap({ workId, origin });
      await page.route("**/api/ai/**", (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/session"))
          return route.fulfill({
            json: {
              bootstrap: ai,
              standaloneUrl: "/ai/",
              uiUrl: ai.embedPath + "?frameNonce=" + ai.nonce,
            },
          });
        if (url.pathname.endsWith("/status"))
          return route.fulfill({
            json: {
              version: 2,
              generation: "0",
              workId,
              native: {
                state: "ready",
                activeThreads: [],
                activeTerminals: 0,
                pendingPermissions: 0,
                scheduled: 0,
                incomplete: false,
              },
              validation: null,
            },
          });
        return route.fulfill({
          status: 404,
          json: { error: "Unexpected fixture request" },
        });
      });
      await page.route("**/ai/**", (route) => {
        if (!new URL(route.request().url()).pathname.startsWith(ai.embedPath))
          return route.fallback();
        return route.fulfill({
          contentType: "text/html",
          body: aiBoundaryHtml(ai),
        });
      });
      await page.goto(origin + "/__media-workbench");
      const iframe = page.locator('iframe[title="作品播放器"]');
      const currentFrame = async () =>
        (await iframe.elementHandle()).contentFrame();
      await expect(iframe)
        .toBeVisible()
        .catch(async (error) => {
          console.error(
            "media-initial",
            await page.locator("body").innerText(),
            await page.evaluate(() => window.fixtureCalls),
          );
          throw error;
        });
      await expect(iframe).toHaveAttribute("src", /mediaControls=external/);
      let frame = await currentFrame();
      await frame.waitForFunction(() => window.fixtureReady && window.channel);
      const originalInstance = await frame.evaluate(() => window.instance);
      assert.equal(await frame.evaluate(() => !!window.playerStarted), false);

      const tool = page.getByRole("button", { name: "素材模式", exact: true });
      const pane = page.locator('[data-dock-pane="preview-media"]');
      const radio = (name) => pane.getByRole("radio", { name, exact: true });
      await tool.click();
      await expect(pane).toBeVisible();
      await expect(page.locator(".work-dock-heading")).toContainText(
        "素材模式",
      );
      await expect(radio("压缩素材")).toBeChecked();
      await expect(radio("原始素材")).toBeEnabled();
      await radio("原始素材").click();
      await expect(radio("原始素材")).toBeChecked();
      await expect
        .poll(() =>
          page.evaluate(() =>
            JSON.parse(localStorage.getItem("frame.preview-media-mode")),
          ),
        )
        .toBe("original");
      assert.deepEqual(await frame.evaluate(() => window.commands), [
        { action: "mode", mode: "original" },
      ]);
      assert.equal(
        await frame.evaluate(() => !!window.playerStarted),
        false,
        "mode controls work before Player readiness",
      );
      await frame.evaluate(() => {
        window.commandDelay = 150;
      });
      await radio("原始素材").focus();
      await page.keyboard.press("ArrowRight");
      await expect(radio("压缩素材")).toBeChecked();
      await expect(radio("压缩素材")).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(radio("完整缓存")).toBeChecked();
      await expect(radio("完整缓存")).toBeFocused();
      await page.keyboard.press("Space");
      await expect(radio("完整缓存")).toBeFocused();
      await frame.evaluate(() => {
        window.commandDelay = 0;
      });
      await radio("原始素材").click();
      await frame.evaluate(() => window.startPlayer());
      await frame.waitForFunction(() => window.context?.previewMode === "live");
      await page
        .getByRole("button", { name: "关闭素材模式", exact: true })
        .click();
      await expect(pane).toBeHidden();
      await tool.click();
      await expect(pane).toBeVisible();
      assert.equal(
        await (await currentFrame()).evaluate(() => window.instance),
        originalInstance,
        "toggling the dock must not reload the iframe",
      );

      // A genuine frame with a stale nonce and an unrelated source with the current
      // nonce must neither change the panel nor persist a forged preference.
      const channel = await frame.evaluate(() => window.channel);
      await frame.evaluate(() =>
        window.publishAs("stale-channel", { mode: "cached" }),
      );
      await page.evaluate(
        (channel) =>
          window.dispatchEvent(
            new MessageEvent("message", {
              source: window,
              data: {
                type: "frame-preview-media-state",
                channel,
                state: { mode: "cached" },
              },
            }),
          ),
        channel,
      );
      await expect(radio("原始素材")).toBeChecked();
      assert.equal(
        await page.evaluate(() =>
          JSON.parse(localStorage.getItem("frame.preview-media-mode")),
        ),
        "original",
      );

      await radio("完整缓存").click();
      await expect(radio("完整缓存")).toBeChecked();
      await frame.evaluate(() =>
        window.patchCache({
          state: "preparing",
          totalFiles: 2,
          completeFiles: 2,
          totalBytes: 4194304,
          downloadedBytes: 4194304,
          persistentFiles: 2,
          remaining: [],
          storage: { quota: 1073741824, usage: 4194304 },
        }),
      );
      await expect(pane).toContainText("素材已缓存，正在准备播放");
      await expect(pane.getByRole("progressbar")).toHaveAttribute(
        "aria-valuetext",
        /2 \/ 2 个文件/,
      );
      await expect(
        pane.getByRole("button", { name: "取消准备", exact: true }),
      ).toBeEnabled();
      await pane.getByRole("button", { name: "取消准备", exact: true }).click();
      await expect(pane).toContainText("素材已缓存，播放准备已取消");
      await pane
        .getByRole("button", { name: "重试准备播放", exact: true })
        .click();
      await expect(pane).toContainText("正在重新准备");
      await expect(radio("原始素材")).toBeDisabled();
      await frame.evaluate(() => window.finishRetry());
      await expect(pane).toContainText("缓存与画面已就绪");
      await expect(radio("原始素材")).toBeEnabled();
      await fs.mkdir(screenshots, { recursive: true });
      await page.screenshot({
        path: path.join(screenshots, "desktop-ready-1440.png"),
      });
      await page.setViewportSize({ width: 1440, height: 500 });
      await tool.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(screenshots, "desktop-1440x500.png"),
      });
      await expect(tool).toBeInViewport();
      await pane
        .getByRole("button", { name: "清理本作品缓存", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        pane.getByRole("button", { name: "清理本作品缓存", exact: true }),
      ).toBeInViewport();
      assert(
        await pane
          .locator(".preview-media-panel")
          .evaluate(
            (element) =>
              element.scrollHeight > element.clientHeight &&
              element.scrollTop > 0,
          ),
        "short-window panel scrolls to its cache controls",
      );
      await page.setViewportSize({ width: 1440, height: 1000 });

      await pane
        .getByRole("button", { name: "清理本作品缓存", exact: true })
        .click();
      await expect(
        pane.getByRole("button", { name: "保留缓存", exact: true }),
      ).toBeFocused();
      assert.equal(
        await frame.evaluate(
          () =>
            window.commands.filter((item) => item.action === "clear").length,
        ),
        0,
        "clear needs an explicit second step",
      );
      await page.keyboard.press("Escape");
      await expect(pane).toBeVisible();
      await expect(
        pane.getByRole("button", { name: "清理本作品缓存", exact: true }),
      ).toBeFocused();
      await expect(
        pane.getByRole("button", { name: "确认清理", exact: true }),
      ).toHaveCount(0);
      await pane
        .getByRole("button", { name: "清理本作品缓存", exact: true })
        .click();
      await pane.getByRole("button", { name: "确认清理", exact: true }).click();
      await expect
        .poll(() =>
          frame.evaluate(
            () =>
              window.commands.filter((item) => item.action === "clear").length,
          ),
        )
        .toBe(1);

      await frame.evaluate(() => {
        window.patchCache({
          state: "error",
          totalFiles: 1,
          remaining: [
            {
              path: "films/test/" + "long-source-file-".repeat(15) + ".wav",
              bytes: 1048576,
              downloadedBytes: 1024,
              state: "error",
              error: "连接中断，请重试。" + "长诊断文本".repeat(30),
            },
          ],
          error: "素材请求失败，请检查网络后重试。",
          warning: "浏览器未授权持久保存。",
        });
      });
      await expect(pane.getByRole("alert").first()).toContainText(
        "素材请求失败",
      );
      await expect(pane.locator("details")).toHaveAttribute("open", "");
      await expect(
        pane.getByRole("button", { name: "继续缓存", exact: true }),
      ).toBeEnabled();
      await frame.evaluate(() => window.exportBusy(true));
      await expect(pane).toContainText("正在导出，完成后可切换模式和管理缓存");
      await expect(radio("压缩素材")).toBeDisabled();
      await expect(
        pane.getByRole("button", { name: "继续缓存", exact: true }),
      ).toBeDisabled();
      await expect(
        pane.getByRole("button", { name: "清理本作品缓存", exact: true }),
      ).toBeDisabled();
      await frame.evaluate(() => window.exportBusy(false));

      await fs.mkdir(screenshots, { recursive: true });
      await page.screenshot({
        path: path.join(screenshots, "desktop-1440.png"),
      });
      const bounds = await page.evaluate(() => {
        const toolbar = document
          .querySelector(".creation-toolbar")
          .getBoundingClientRect();
        const preview = document
          .querySelector(".preview-pane")
          .getBoundingClientRect();
        const dock = document
          .querySelector(".work-dock")
          .getBoundingClientRect();
        return {
          toolbarRight: toolbar.right,
          previewLeft: preview.left,
          previewRight: preview.right,
          dockLeft: dock.left,
        };
      });
      assert(
        bounds.toolbarRight <= bounds.previewLeft + 1,
        "tools stay left of the preview",
      );
      assert(
        bounds.dockLeft >= bounds.previewRight - 1,
        "material settings open on the right",
      );

      // After reconnecting the canonical preview, late state carrying the prior nonce
      // must be ignored even if posted by the new iframe's WindowProxy.
      await page.evaluate(() => window.replacePreviewSession());
      await frame.evaluate(() =>
        parent.postMessage(
          {
            type: "frame-live-preview",
            state: "error",
            error: "Fixture connection lost",
          },
          "*",
        ),
      );
      await page
        .getByRole("button", { name: "重新连接实时预览", exact: true })
        .click();
      await expect(iframe).toHaveAttribute("src", /source=work&generation=1/);
      frame = await currentFrame();
      await frame.waitForFunction(() => window.fixtureReady && window.channel);
      assert.notEqual(
        await frame.evaluate(() => window.instance),
        originalInstance,
      );
      assert.notEqual(await frame.evaluate(() => window.channel), channel);
      await expect(radio("完整缓存")).toBeChecked();
      await frame.evaluate((old) => {
        window.publishAs(old, {
          mode: "original",
          controlError: "stale attachment failure",
        });
        parent.postMessage(
          {
            type: "frame-preview-media-result",
            channel: old,
            requestId: "stale-request",
            error: "stale attachment failure",
          },
          "*",
        );
      }, channel);
      await expect(radio("完整缓存")).toBeChecked();
      await expect(pane).not.toContainText("stale attachment failure");
      await frame.evaluate(() => {
        window.startPlayer();
        window.patchCache({
          state: "error",
          totalFiles: 1,
          remaining: [
            {
              path: "films/test/" + "long-source-file-".repeat(15) + ".wav",
              bytes: 1048576,
              downloadedBytes: 1024,
              state: "error",
              error: "可重试的错误".repeat(40),
            },
          ],
          error: "素材请求失败，请检查网络后重试。",
        });
      });

      await expect(pane.getByRole("alert").first()).toContainText(
        "素材请求失败",
      );
      await expect(pane.locator("summary")).toBeVisible();
      for (const width of [390, 274]) {
        await page.setViewportSize({ width, height: 844 });
        if (await pane.isVisible()) {
          await expect(page.locator("#work-dock")).toHaveAttribute(
            "role",
            "dialog",
          );
          await expect(radio("完整缓存")).toBeFocused();
          await page.keyboard.press("Escape");
        }
        await expect(pane).toBeHidden();
        const menu = page.getByRole("button", {
          name: "作品工具菜单",
          exact: true,
        });
        await menu.click();
        await page
          .getByRole("menuitem", { name: "素材模式", exact: true })
          .click();
        await expect(pane).toBeVisible();
        await expect(page.locator("#work-dock")).toHaveAttribute(
          "role",
          "dialog",
        );
        await expect(radio("完整缓存")).toBeFocused();
        await page.screenshot({
          path: path.join(screenshots, "mobile-" + width + ".png"),
        });
        const overflow = await page.evaluate(() => ({
          document: document.documentElement.scrollWidth - innerWidth,
          pane:
            document.querySelector('[data-dock-pane="preview-media"]')
              .scrollWidth -
            document.querySelector('[data-dock-pane="preview-media"]')
              .clientWidth,
        }));
        assert(
          overflow.document <= 1 && overflow.pane <= 1,
          JSON.stringify({ width, overflow }),
        );
        await page.keyboard.press("Shift+Tab");
        await expect(
          page.getByRole("button", { name: "关闭素材模式", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(pane.locator("summary"))
          .toBeFocused()
          .catch(async (error) => {
            console.error(
              "media-focus",
              width,
              await page.evaluate(() => ({
                active: document.activeElement.outerHTML,
                items: [
                  ...document
                    .querySelector("#work-dock")
                    .querySelectorAll(
                      'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,iframe,[tabindex="0"]',
                    ),
                ]
                  .filter(
                    (el) =>
                      el.getClientRects().length && !el.closest("[inert]"),
                  )
                  .map((el) => el.outerHTML),
              })),
            );
            throw error;
          });
        await page.keyboard.press("Escape");
        await expect(pane).toBeHidden();
        await expect(menu).toBeFocused();
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  },
);
