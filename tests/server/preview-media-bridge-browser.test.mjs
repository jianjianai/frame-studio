import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { launchBrowser } from "../../scripts/browser.mjs";

const cacheState = {
  state: "downloading",
  revision: 1,
  totalBytes: 4096,
  downloadedBytes: 1024,
  totalFiles: 4,
  completeFiles: 1,
  persistentFiles: 1,
  remaining: [
    {
      path: "films/test-film/source.mp4",
      bytes: 3072,
      downloadedBytes: 0,
      state: "queued",
    },
  ],
};
const bridgeFixture = `
import { installPreviewMediaBridge } from "/src/ui/preview-media-bridge.ts";
let mode = "cached", cache = ${JSON.stringify(cacheState)}, releaseClear;
const calls = [], errors = [];
const client = {
  mode: () => mode,
  cacheState: () => structuredClone(cache),
  setMode(value) { calls.push(["mode", value]); mode = value; },
  cancelCache() { calls.push(["cancel"]); cache.state = "cancelled"; },
  retry() { calls.push(["retry"]); cache.state = "downloading"; return Promise.resolve(); },
  clearCache() {
    calls.push(["clear"]);
    return window.holdClear ? new Promise(resolve => { releaseClear = resolve; }) : Promise.resolve();
  },
};
const bridge = installPreviewMediaBridge(client, () => {}, error => errors.push(error));
window.bridgeFixture = {
  calls, errors, state: () => ({mode, cache}),
  progress(value) { cache.downloadedBytes = value; bridge.update(); },
  readers(value) {
    window.__FRAME_PREVIEW_READERS__ = value;
    window.dispatchEvent(new Event("frame-preview-readers"));
  },
  releaseClear() { releaseClear?.(); },
  dispose() { bridge.dispose(); },
};
`;
const fakeLiveClient = `
export function createLivePreviewClient(config, callbacks) {
  let mode = new URLSearchParams(location.search).get("mediaMode") || "cached";
  let cache = ${JSON.stringify(cacheState)};
  // Real clients emit during construction, before the shell assigns client.current.
  callbacks.onCache(cache);
  callbacks.onStatus({state:"updating",sessionId:config.sessionId,mediaMode:mode});
  window.fixtureClientCalls = [];
  window.fixtureClientReady = true;
  return {
    mode: () => mode,
    cacheState: () => structuredClone(cache),
    applied: () => undefined,
    dispose() {},
    waitCached: () => Promise.resolve(),
    setMode(value) {
      window.fixtureClientCalls.push(["mode", value]);
      mode = value;
      callbacks.onStatus({state:"updating",sessionId:config.sessionId,mediaMode:mode});
    },
    cancelCache() {
      window.fixtureClientCalls.push(["cancel"]);
      cache = {...cache,state:"cancelled"};
      callbacks.onCache(cache);
    },
    retry: () => Promise.resolve(),
    clearCache: () => Promise.resolve(),
  };
}
`;
const parentHtml = (src) => `<!doctype html><html><body>
<script>
window.mediaMessages = [];
addEventListener("message", event => {
  if (event.source === document.getElementById("preview")?.contentWindow &&
      ["frame-preview-media-state", "frame-preview-media-result"].includes(event.data?.type))
    window.mediaMessages.push(event.data);
});
</script>
<iframe id="preview" title="Fixture preview" sandbox="allow-scripts" src="${src}"></iframe>
<iframe id="foreign" title="Foreign frame" sandbox="allow-scripts" srcdoc="<p>Unrelated frame</p>"></iframe>
</body></html>`;

test(
  "preview media bridge: real sandbox handshake, command acknowledgements, export locking, async cache actions and shell placement",
  { timeout: 90000 },
  async (t) => {
    const cacheDir = path.resolve(
      ".cache/tests/preview-media-bridge-" + process.pid,
    );
    const virtualBridge = path.resolve(
      "tests/ui/preview-media-bridge-fixture.ts",
    );
    const virtualClient = "\0preview-media-fixture-client";
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      cacheDir,
      logLevel: "error",
      appType: "custom",
      optimizeDeps: {
        noDiscovery: true,
        include: [
          "react",
          "react-dom",
          "react-dom/client",
          "react/jsx-runtime",
          "lucide-react",
          "zod",
          "mediabunny",
          "es-module-lexer/minimal/js",
        ],
      },
      server: {
        hmr: false,
        host: "127.0.0.1",
        port: Number(process.env.FRAME_TEST_PORT || 55845),
        strictPort: true,
        cors: true,
      },
      plugins: [
        {
          name: "preview-media-bridge-fixture",
          enforce: "pre",
          resolveId(id, importer) {
            if (id === "/preview-media-fixture.ts" || id === virtualBridge)
              return virtualBridge;
            if (
              id === "./engine/live-preview-client" &&
              importer?.endsWith("/src/live-preview.tsx")
            )
              return virtualClient;
          },
          load(id) {
            if (id === virtualBridge) return bridgeFixture;
            if (id === virtualClient) return fakeLiveClient;
          },
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              const url = new URL(req.url, "http://fixture.invalid");
              let html;
              if (url.pathname === "/__media-parent")
                html = parentHtml("/__media-frame");
              else if (url.pathname === "/__shell-parent")
                html = parentHtml(
                  "/__live-shell?mediaMode=cached&mediaControls=external",
                );
              else if (url.pathname === "/__media-frame")
                html =
                  '<!doctype html><html><body><script type="module" src="/preview-media-fixture.ts"></script></body></html>';
              else if (url.pathname === "/__live-shell")
                html =
                  '<!doctype html><html><body><div id="root"></div><script>window.__FRAME_LIVE_PREVIEW__={sessionId:"fixture-live-shell",manifestUrl:"unused",eventsUrl:"unused",mediaMode:"cached"};</script><script type="module" src="/src/live-preview.tsx"></script></body></html>';
              if (html === undefined) return next();
              res.setHeader("Content-Type", "text/html");
              res.setHeader("Access-Control-Allow-Origin", "*");
              void vite
                .transformIndexHtml(req.url, html)
                .then((value) => res.end(value), next);
            });
          },
        },
        react(),
      ],
    });
    let browser;
    try {
      await server.listen();
      browser = await launchBrowser();
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const origin = "http://127.0.0.1:" + server.httpServer.address().port;
      await page.goto(origin + "/__media-parent");
      const frame = await (
        await page.locator("#preview").elementHandle()
      ).contentFrame();
      await frame.waitForFunction(() => window.bridgeFixture);
      const send = (data) =>
        page.evaluate(
          (value) =>
            document
              .getElementById("preview")
              .contentWindow.postMessage(value, "*"),
          data,
        );
      const subscribe = (channel = "media-test") =>
        send({ type: "frame-preview-media-subscribe", channel });
      const command = (action, requestId, extra = {}) =>
        send({
          type: "frame-preview-media-command",
          channel: "media-test",
          action,
          requestId,
          ...extra,
        });
      const messages = () => page.evaluate(() => window.mediaMessages);
      const latest = () =>
        page.evaluate(
          () =>
            window.mediaMessages.findLast(
              (value) => value.type === "frame-preview-media-state",
            )?.state,
        );
      const result = async (requestId) => {
        await expect
          .poll(() =>
            page.evaluate(
              (id) =>
                window.mediaMessages.find(
                  (value) =>
                    value.type === "frame-preview-media-result" &&
                    value.requestId === id,
                ),
              requestId,
            ),
          )
          .toBeTruthy();
        return page.evaluate(
          (id) =>
            window.mediaMessages.find(
              (value) =>
                value.type === "frame-preview-media-result" &&
                value.requestId === id,
            ),
          requestId,
        );
      };
      await t.test(
        "opaque frame accepts its parent and ignores self, foreign windows and mismatched channels",
        async () => {
          assert.equal(await frame.evaluate(() => location.origin), origin);
          // The sandbox has an opaque security origin even though location retains its URL.
          assert.equal(
            await frame.evaluate(() => {
              try {
                void parent.document;
                return false;
              } catch {
                return true;
              }
            }),
            true,
          );
          await subscribe();
          await expect.poll(async () => (await latest())?.mode).toBe("cached");
          const first = await latest();
          assert.equal(first.cache.downloadedBytes, 1024);
          assert.equal(first.pendingAction, "");
          const foreign = await (
            await page.locator("#foreign").elementHandle()
          ).contentFrame();
          const forged = {
            type: "frame-preview-media-command",
            channel: "media-test",
            requestId: "forged",
            action: "mode",
            mode: "original",
          };
          await frame.evaluate((data) => window.postMessage(data, "*"), forged);
          await foreign.evaluate(
            (data) => parent.frames[0].postMessage(data, "*"),
            forged,
          );
          await foreign.evaluate(() =>
            parent.frames[0].postMessage(
              {
                type: "frame-preview-media-subscribe",
                channel: "foreign-channel",
              },
              "*",
            ),
          );
          await command("mode", "wrong-channel", {
            channel: "wrong",
            mode: "original",
          });
          await command("unknown", "wrong-action");
          await page.waitForTimeout(180);
          assert.deepEqual(
            await frame.evaluate(() => window.bridgeFixture.calls),
            [],
          );
          assert.equal(
            (await messages()).filter(
              (value) => value.type === "frame-preview-media-result",
            ).length,
            0,
          );
          await command("mode", "mode-1", { mode: "original" });
          assert.equal((await result("mode-1")).error, undefined);
          assert.equal((await result("mode-1")).channel, "media-test");
          assert.deepEqual(
            await frame.evaluate(() => window.bridgeFixture.calls),
            [["mode", "original"]],
          );
          assert.equal((await latest()).mode, "original");
        },
      );
      await t.test(
        "every cache command is rejected while an export owns the frozen source",
        async () => {
          const before = await frame.evaluate(
            () => window.bridgeFixture.calls.length,
          );
          await frame.evaluate(() => window.bridgeFixture.readers(1));
          await expect
            .poll(async () => (await latest())?.exportBusy)
            .toBe(true);
          for (const action of ["mode", "cancel", "retry", "clear"]) {
            await command(action, "locked-" + action, { mode: "cached" });
            assert.match((await result("locked-" + action)).error, /导出/);
          }
          assert.equal(
            await frame.evaluate(() => window.bridgeFixture.calls.length),
            before,
          );
          await frame.evaluate(() => window.bridgeFixture.readers(0));
          await expect
            .poll(async () => (await latest())?.exportBusy)
            .toBe(false);
        },
      );
      await t.test(
        "an asynchronous clear retains its pending state when concurrent commands are refused",
        async () => {
          await frame.evaluate(() => {
            window.holdClear = true;
          });
          await command("clear", "clear-pending");
          await expect
            .poll(async () => (await latest())?.pendingAction)
            .toBe("clear");
          await command("retry", "retry-during-clear");
          assert.match(
            (await result("retry-during-clear")).error,
            /上一项操作/,
          );
          assert.equal(
            (await latest()).pendingAction,
            "clear",
            "refused commands must not release another command's lock",
          );
          await command("cancel", "cancel-during-clear");
          assert.match(
            (await result("cancel-during-clear")).error,
            /上一项操作/,
          );
          assert.equal((await latest()).pendingAction, "clear");
          assert.equal(
            (await messages()).some(
              (value) => value.requestId === "clear-pending",
            ),
            false,
          );
          const calls = await frame.evaluate(() => window.bridgeFixture.calls);
          assert.equal(calls.filter((value) => value[0] === "clear").length, 1);
          assert.equal(
            calls.some((value) => ["retry", "cancel"].includes(value[0])),
            false,
          );
          await frame.evaluate(() => window.bridgeFixture.releaseClear());
          assert.equal((await result("clear-pending")).error, undefined);
          assert.equal((await latest()).pendingAction, "");
          await command("retry", "retry-after-clear");
          assert.equal((await result("retry-after-clear")).error, undefined);
          await command("cancel", "cancel-after-clear");
          assert.equal((await result("cancel-after-clear")).error, undefined);
        },
      );
      await t.test(
        "progress bursts are throttled and disposal silences both pending actions and listeners",
        async () => {
          await page.waitForTimeout(150);
          const before = (await messages()).length;
          await frame.evaluate(() => {
            for (let value = 1025; value <= 1124; value++)
              window.bridgeFixture.progress(value);
          });
          await expect
            .poll(async () => (await latest())?.cache.downloadedBytes)
            .toBe(1124);
          assert.equal(
            (await messages()).length - before,
            1,
            "a synchronous burst produces one up-to-date snapshot",
          );
          await command("clear", "clear-disposed");
          await expect
            .poll(async () => (await latest())?.pendingAction)
            .toBe("clear");
          await frame.evaluate(() => window.bridgeFixture.dispose());
          const afterDispose = (await messages()).length;
          const callCount = await frame.evaluate(
            () => window.bridgeFixture.calls.length,
          );
          await frame.evaluate(() => {
            window.bridgeFixture.releaseClear();
            window.bridgeFixture.progress(2048);
            window.bridgeFixture.readers(1);
          });
          await subscribe("after-dispose");
          await command("retry", "disposed-retry");
          await page.waitForTimeout(180);
          assert.equal((await messages()).length, afterDispose);
          assert.equal(
            await frame.evaluate(() => window.bridgeFixture.calls.length),
            callCount,
          );
        },
      );
      await t.test(
        "the actual live shell provides controls before Player exists and only hides embedded external controls",
        async () => {
          await page.goto(origin + "/__shell-parent", {
            waitUntil: "domcontentloaded",
          });
          const shell = await (
            await page.locator("#preview").elementHandle()
          ).contentFrame();
          await shell
            .waitForFunction(
              () =>
                window.fixtureClientReady && window.__FRAME_PREVIEW_CONTROL__,
              null,
              { timeout: 30000 },
            )
            .catch(async (error) => {
              console.error("live-shell fixture diagnostic", {
                errors,
                html: await shell.locator("body").innerHTML(),
              });
              throw error;
            });
          assert.equal(await shell.locator(".work-player").count(), 0);
          await subscribe("shell-test");
          await expect
            .poll(async () => (await latest())?.cache.state)
            .toBe("downloading");
          assert.equal((await latest()).mode, "cached");
          await expect(shell.locator(".preview-media-controls")).toHaveCount(0);
          await command("cancel", "shell-cancel", { channel: "shell-test" });
          assert.equal((await result("shell-cancel")).error, undefined);
          await expect
            .poll(async () => (await latest())?.cache.state)
            .toBe("cancelled");
          assert.deepEqual(
            await shell.evaluate(() => window.fixtureClientCalls),
            [["cancel"]],
          );
          const standalone = await browser.newPage();
          standalone.on("pageerror", (error) => errors.push(error.message));
          try {
            await standalone.goto(
              origin + "/__live-shell?mediaMode=cached&mediaControls=external",
              { waitUntil: "domcontentloaded" },
            );
            await expect(
              standalone.getByRole("region", { name: "预览素材模式" }),
            ).toBeVisible();
            await expect(
              standalone.locator(".preview-media-controls select"),
            ).toHaveValue("cached");
          } finally {
            await standalone.close();
          }
        },
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  },
);
