import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { expect } from "@playwright/test";
import { launchBrowser } from "../../scripts/browser.mjs";

test(
  "Codex account UI: automatic sync, retry, model parameters and default, account setup and responsive login",
  { timeout: 60000 },
  async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const report = path.join(root, ".cache/codex-account-models");
    fs.mkdirSync(report, { recursive: true });
    const entry = "virtual:codex-account.jsx";
    const server = await createServer({
      configFile: false,
      root,
      cacheDir: path.join(report, "vite"),
      optimizeDeps: {
        include: ["react", "react-dom/client", "react/jsx-runtime"],
      },
      server: {
        host: "127.0.0.1",
        port: Number(process.env.FRAME_TEST_PORT || 55198),
        strictPort: true,
        fs: {
          allow: [root, path.resolve(root, "../frame-studio/node_modules")],
        },
        watch: { ignored: ["**/.cache/**"] },
      },
      plugins: [
        react(),
        {
          name: "codex-account-fixture",
          resolveId: (id) => (id === entry ? "\0" + entry : undefined),
          load: (id) =>
            id === "\0" + entry
              ? `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {ProviderSettings} from '/studio/model-settings.jsx';
        import {LoginFlow} from '/studio/accounts.jsx';
        import '/studio/workbench.css'; import '/studio/ai-workbench.css';
        function Fixture(){ const [notice,setNotice]=React.useState('');
          return React.createElement('main', {style:{maxWidth:1120,margin:'0 auto',padding:20}},
            React.createElement(ProviderSettings, {notify:setNotice, LoginDialog:LoginFlow}),
            React.createElement('output', {'aria-label':'操作反馈'}, notice)); }
        createRoot(document.getElementById('root')).render(React.createElement(Fixture));
      `
              : undefined,
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (req.url !== "/__codex_account") return next();
              try {
                res.setHeader("Content-Type", "text/html");
                res.end(
                  await vite.transformIndexHtml(
                    req.url,
                    '<div id="root"></div><script type="module" src="/@id/virtual:codex-account.jsx"></script>',
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
    let browser;
    try {
      await server.listen();
      browser = await launchBrowser();
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const native = {
        id: "native-one",
        name: "Native One",
        enabled: true,
        metadata: {
          name: "Native One",
          description: "For creative coding tasks.",
          contextWindow: 300000,
          reasoning: true,
          reasoningEfforts: ["low", "medium", "adaptive"],
          defaultReasoningEffort: "adaptive",
          inputModalities: ["text", "image"],
          sources: {
            contextWindow: "api",
            reasoningEfforts: "api",
            defaultReasoningEffort: "api",
          },
          fetchedAt: new Date().toISOString(),
        },
      };
      const providers = [
        {
          id: "12345678-1234-4123-8123-000000000001",
          name: "我的 Codex",
          tool: "codex",
          mode: "official",
          configured: true,
          state: "ready",
          auth_generation: 1,
          model: "",
          models: [],
          revision: "fixture",
        },
      ];
      let syncReply,
        authReply,
        broken = false,
        syncCalls = 0;
      await page.routeWebSocket("**/api/ws", (socket) =>
        socket.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === "unsubscribe") return;
          const reply = (result) =>
            socket.send(
              JSON.stringify({
                type: message.type === "subscribe" ? "update" : "result",
                id: message.id,
                result,
              }),
            );
          switch (message.name) {
            case "connections_list":
              return reply(providers);
            case "connections_sync_models":
              syncCalls++;
              if (broken)
                return socket.send(
                  JSON.stringify({
                    type: "result",
                    id: message.id,
                    status: 502,
                    error: "模型目录暂不可用，请重试",
                  }),
                );
              const finish = () => {
                const provider = providers.find(
                  (entry) => entry.id === message.args.id,
                );
                provider.models = [native];
                provider.modelCatalog = {
                  fetchedAt: new Date().toISOString(),
                  defaultModel: native.id,
                  warnings: [],
                };
                reply({ ok: true, count: 1, warnings: [] });
              };
              if (syncCalls === 1) syncReply = finish;
              else finish();
              return;
            case "connections_save": {
              let provider = providers.find(
                (entry) => entry.id === message.args.id,
              );
              if (provider) Object.assign(provider, message.args);
              else {
                provider = {
                  ...message.args,
                  id: "12345678-1234-4123-8123-000000000002",
                  configured: false,
                  state: "unconfigured",
                  auth_generation: 0,
                };
                providers.push(provider);
              }
              return reply(provider);
            }
            case "auth_begin":
              return reply({
                id: "12345678-1234-4123-8123-000000000003",
                state: "pending",
                info: {},
              });
            case "auth_state":
              authReply = reply;
              return reply({
                state: "pending",
                info: {
                  url: "https://auth.openai.com/fixture",
                  code: "ABCD-EFGHI",
                  message: "打开官方页面完成授权。",
                },
              });
            default:
              throw Error("Unexpected operation: " + message.name);
          }
        }),
      );
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/__codex_account`,
      );
      const status = page.getByRole("region", { name: "Codex 模型同步状态" });
      await expect(status).toContainText("正在同步模型与参数");
      syncReply();
      await expect(status).toContainText("模型目录已更新");
      assert.equal(syncCalls, 1);
      await expect(
        page.getByRole("button", { name: /我的 Codex.*1 个模型/ }),
      ).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: "测试模型 Native One", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "编辑模型参数 Native One", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "模型参数", exact: true }),
      ).toContainText("adaptive");
      await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
      await page
        .getByRole("button", { name: "设为默认模型 Native One", exact: true })
        .click();
      await expect(
        page.getByLabel("提供商默认模型", { exact: true }),
      ).toHaveValue(native.id);
      broken = true;
      await page.getByRole("button", { name: "同步模型", exact: true }).click();
      await expect(status).toContainText("模型目录暂不可用");
      broken = false;
      await page.getByRole("button", { name: "重试同步", exact: true }).click();
      await expect(status).toContainText("模型目录已更新");
      await page.screenshot({
        path: path.join(report, "frontend-desktop.png"),
        fullPage: true,
      });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          "settings overflow at " + width,
        );
      }
      await page.screenshot({
        path: path.join(report, "frontend-mobile.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "添加提供商", exact: true })
        .click();
      const form = page.getByRole("dialog", {
        name: "添加提供商",
        exact: true,
      });
      await form.getByRole("button", { name: /ChatGPT 账号/ }).click();
      await expect(form.getByLabel("认证方式", { exact: true })).toHaveValue(
        "official",
      );
      await expect(form.getByLabel("API 密钥", { exact: true })).toHaveCount(0);
      await form.getByLabel("提供商名称", { exact: true }).fill("新的 ChatGPT");
      await form
        .getByRole("button", { name: "保存并登录", exact: true })
        .click();
      const login = page.getByRole("dialog", {
        name: "连接 ChatGPT / Codex",
        exact: true,
      });
      await expect(login).toContainText("ABCD-EFGHI");
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        "login overflow",
      );
      await page.screenshot({
        path: path.join(report, "login-mobile.png"),
        fullPage: true,
      });
      authReply({
        state: "pending",
        info: {
          stage: "models",
          message: "账号已登录，正在自动获取模型与参数…",
        },
      });
      await expect(
        login
          .getByRole("list", { name: "账号连接进度" })
          .locator('[aria-current="step"]'),
      ).toContainText("同步模型");
      Object.assign(providers[1], {
        configured: true,
        state: "ready",
        models: [native],
        modelCatalog: {
          fetchedAt: new Date().toISOString(),
          defaultModel: native.id,
          warnings: [],
        },
      });
      authReply({
        state: "succeeded",
        info: { catalogSynced: true, message: "已自动同步 1 个模型及参数。" },
      });
      await expect(login).toContainText("已自动同步 1 个模型及参数");
      await login
        .getByRole("button", { name: "查看模型", exact: true })
        .click();
      await expect(status).toContainText("模型目录已更新");
      assert.deepEqual(errors, []);
      await page.close();
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
