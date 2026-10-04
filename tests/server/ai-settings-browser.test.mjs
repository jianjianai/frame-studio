import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { expect } from "@playwright/test";
import { launchBrowser } from "../../scripts/browser.mjs";

test(
  "AI settings open the shared native provider page without creating a work or starting a model",
  { timeout: 60000 },
  async () => {
    const cacheDir = path.resolve(".cache/tests/ai-settings-" + randomUUID());
    let failing = true,
      requests = 0,
      browser;
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      cacheDir,
      logLevel: "error",
      appType: "custom",
      server: { host: "127.0.0.1", port: 0, watch: null },
      plugins: [
        react(),
        {
          name: "native-ai-settings-fixture",
          resolveId: (id) =>
            id === "virtual:ai-settings-fixture.jsx" ? "\0" + id : undefined,
          load: (id) =>
            id === "\0virtual:ai-settings-fixture.jsx"
              ? `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {AiSettings} from '/studio/ai-settings.jsx';
      createRoot(document.getElementById('app')).render(React.createElement(AiSettings));
    `
              : undefined,
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (req.url === "/__settings") {
                res.setHeader("Content-Type", "text/html");
                try {
                  res.end(
                    await vite.transformIndexHtml(
                      req.url,
                      '<!doctype html><div id="app"></div><script type="module" src="/@id/virtual:ai-settings-fixture.jsx"></script>',
                    ),
                  );
                } catch (error) {
                  next(error);
                }
              } else if (req.url === "/api/ai/session") {
                requests++;
                res.setHeader("Content-Type", "application/json");
                res.statusCode = failing ? 503 : 200;
                res.end(
                  JSON.stringify(
                    failing
                      ? { error: "AI 工作台暂时不可用" }
                      : {
                          uiUrl: "/ai/",
                          standaloneUrl: "/ai/",
                          nativeSettingsUrl: "/ai/settings/providers",
                          bootstrap: null,
                          runtime: { version: "0.0.45" },
                        },
                  ),
                );
              } else next();
            });
          },
        },
      ],
    });
    try {
      await server.listen();
      browser = await launchBrowser();
      const page = await browser.newPage(),
        errors = [],
        calls = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/"))
          calls.push({
            path: new URL(request.url()).pathname,
            method: request.method(),
          });
      });
      const origin = "http://127.0.0.1:" + server.httpServer.address().port;
      await page.goto(origin + "/__settings");
      await expect(page.getByRole("alert")).toContainText(
        "AI 工作台暂时不可用",
      );
      await expect(page.getByRole("link")).toHaveCount(0);
      failing = false;
      await page.getByRole("button", { name: "重新连接" }).click();
      const providers = page.getByRole("link", { name: "打开提供商与模型" });
      await expect(providers).toHaveAttribute(
        "href",
        origin + "/ai/settings/providers?frameStandalone=1",
      );
      await expect(providers).toHaveAttribute("target", "_blank");
      await expect(
        page.getByRole("link", { name: "打开完整工作台" }),
      ).toHaveAttribute("href", origin + "/ai/?frameStandalone=1");
      await expect(page.getByText("当前版本：0.0.45")).toBeVisible();
      await expect(page.locator("input")).toHaveCount(0);
      assert.equal(requests, 2);
      assert.deepEqual(calls, [
        { path: "/api/ai/session", method: "GET" },
        { path: "/api/ai/session", method: "GET" },
      ]);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  },
);

test(
  "GitHub device login retains its narrow-screen dialog, live authorization updates and independent lifecycle",
  { timeout: 60000 },
  async () => {
    const cacheDir = path.resolve(
      ".cache/tests/github-settings-" + randomUUID(),
    );
    let browser, publish;
    const calls = [],
      flow = {
        id: randomUUID(),
        state: "pending",
        info: {
          message: "输入设备验证码后授权 FRAME 访问 GitHub。",
          code: "ABCD-EFGH",
          url: "https://github.com/login/device",
        },
      };
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      cacheDir,
      logLevel: "error",
      appType: "custom",
      server: { host: "127.0.0.1", port: 0, watch: null },
      plugins: [
        react(),
        {
          name: "github-settings-fixture",
          resolveId: (id) =>
            id === "virtual:github-settings-fixture.jsx"
              ? "\0" + id
              : undefined,
          load: (id) =>
            id === "\0virtual:github-settings-fixture.jsx"
              ? `
                import React from 'react'; import {createRoot} from 'react-dom/client';
                import {GitHubLoginFlow} from '/studio/accounts.jsx';
                import '/studio/workbench.css';
                const root=createRoot(document.getElementById('app'));
                const render=()=>root.render(React.createElement(GitHubLoginFlow,{
                  notify:()=>{}, onSuccess:()=>window.successes=(window.successes||0)+1,
                  onClose:()=>root.render(React.createElement('p',{},'授权窗口已关闭'))}));
                window.openLogin=render; render();
              `
              : undefined,
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (req.url !== "/__github") return next();
              res.setHeader("Content-Type", "text/html");
              try {
                res.end(
                  await vite.transformIndexHtml(
                    req.url,
                    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/@id/virtual:github-settings-fixture.jsx"></script></body></html>',
                  ),
                );
              } catch (error) {
                next(error);
              }
            });
          },
        },
      ],
    });
    try {
      await server.listen();
      browser = await launchBrowser();
      const context = await browser.newContext({
          viewport: { width: 320, height: 844 },
        }),
        page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await context.routeWebSocket("**/api/ws", (socket) => {
        socket.onMessage((text) => {
          const call = JSON.parse(String(text));
          calls.push(call);
          if (call.type === "unsubscribe") return;
          if (call.name === "auth_begin") {
            assert.deepEqual(call.args, { kind: "github" });
            socket.send(
              JSON.stringify({ type: "result", id: call.id, result: flow }),
            );
          } else if (call.name === "auth_state") {
            publish = (next) =>
              socket.send(
                JSON.stringify({ type: "update", id: call.id, result: next }),
              );
            publish(flow);
          } else throw Error("Unexpected authorization call: " + call.name);
        });
      });
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: async (text) => {
              window.copiedDeviceCode = text;
            },
          },
        });
      });
      await page.goto(
        "http://127.0.0.1:" + server.httpServer.address().port + "/__github",
      );
      const dialog = page.getByRole("dialog", { name: "连接 GitHub" });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("code")).toHaveText("ABCD-EFGH");
      await expect(
        dialog.getByRole("link", { name: "前往 GitHub 授权" }),
      ).toHaveAttribute("href", "https://github.com/login/device");
      assert(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      );
      await dialog.getByRole("button", { name: "复制设备码" }).click();
      assert.equal(
        await page.evaluate(() => window.copiedDeviceCode),
        "ABCD-EFGH",
      );
      await expect.poll(() => typeof publish).toBe("function");
      publish({
        ...flow,
        state: "succeeded",
        info: { message: "GitHub 授权完成。" },
      });
      await expect(
        dialog.getByRole("heading", { name: "GitHub 已连接" }),
      ).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.successes)).toBe(1);
      publish({
        ...flow,
        state: "succeeded",
        info: { message: "GitHub 授权完成。" },
      });
      await expect(dialog.getByRole("status")).toContainText(
        "GitHub 授权完成。",
      );
      assert.equal(await page.evaluate(() => window.successes), 1);
      await dialog.getByRole("button", { name: "完成", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.evaluate(() => window.openLogin());
      await expect(dialog.locator("code")).toHaveText("ABCD-EFGH");
      await dialog
        .getByRole("button", { name: "关闭弹窗", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      assert(!calls.some((call) => call.name === "auth_cancel"));
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  },
);
