import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { createApp } from "../../server/app.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { expect } from "@playwright/test";

test(
  "TTS browser: genuine controls, direction mapping, cancel, model-specific restrictions and responsive layout",
  { timeout: 45000 },
  async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-expression-ui-")),
      requests = [];
    const service = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      requests.push(input);
      if (input.input === "cancel-me") return;
      const b = Buffer.alloc(244);
      b.write("RIFF");
      b.writeUInt32LE(236, 4);
      b.write("WAVEfmt ", 8);
      b.writeUInt32LE(16, 16);
      b.writeUInt16LE(1, 20);
      b.writeUInt16LE(1, 22);
      b.writeUInt32LE(24000, 24);
      b.writeUInt32LE(48000, 28);
      b.writeUInt16LE(2, 32);
      b.writeUInt16LE(16, 34);
      b.write("data", 36);
      b.writeUInt32LE(200, 40);
      res.setHeader("content-type", "audio/wav");
      res.end(b);
    });
    await new Promise((r) => service.listen(0, "127.0.0.1", r));
    let app, browser;
    try {
      const db = await sqliteDatabase(path.join(data, "db.sqlite"));
      const origin = "http://127.0.0.1:57823";
      const f = await createApp({
        db,
        data,
        masterKey: "66".repeat(32),
        origin,
        localMode: true,
        scheduler: false,
      });
      app = f.app;
      for (const [name, provider, model, voice] of [
        ["中文旁白", "openai", "gpt-4o-mini-tts", "cedar"],
        ["兼容基础", "compatible", "manual", "v"],
        ["Eleven v4", "elevenlabs", "eleven_v4", "v"],
      ])
        await f.actions.call("engines_save", {
          name,
          provider,
          model,
          voice,
          url: `http://127.0.0.1:${service.address().port}/v1`,
        });
      await app.listen({ host: "127.0.0.1", port: 57823 });
      browser = await launchBrowser();
      const page = await browser.newPage({
          viewport: { width: 1100, height: 900 },
        }),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(origin + "/#/settings");
      await page.getByRole("button", { name: /语音引擎/ }).click();
      await page.getByRole("button", { name: /自定义引擎 ·/ }).click();
      const card = (name) =>
        page
          .locator(".speech-card")
          .filter({ has: page.getByRole("heading", { name, exact: true }) });
      await card("中文旁白")
        .getByRole("button", { name: "试听", exact: true })
        .click();
      let dialog = page.getByRole("dialog");
      await dialog.locator("summary").filter({ hasText: "旁白表达" }).click();
      await dialog
        .getByRole("button", { name: "电影旁白", exact: true })
        .click();
      assert(
        (
          await dialog
            .getByRole("textbox", { name: "语气与表达指令" })
            .inputValue()
        ).includes("沉稳、克制"),
      );
      await dialog
        .getByRole("button", { name: "生成试听", exact: true })
        .click();
      await dialog.getByText("试听已就绪").waitFor();
      assert(requests.at(-1).instructions.includes("电影旁白"));
      assert(!requests.at(-1).input.includes("沉稳、克制"));
      await dialog.getByRole("textbox", { name: "试听文字" }).fill("cancel-me");
      await dialog
        .getByRole("button", { name: "生成试听", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "取消合成", exact: true })
        .click();
      await dialog
        .getByText(/语音合成已取消/)
        .first()
        .waitFor();
      await page.reload();
      await page.getByRole("button", { name: /语音引擎/ }).click();
      await page.getByRole("button", { name: /自定义引擎 ·/ }).click();
      await card("兼容基础")
        .getByRole("button", { name: "试听", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      assert.equal(
        await dialog.getByRole("textbox", { name: "语气与表达指令" }).count(),
        0,
      );
      await page.reload();
      await page.getByRole("button", { name: /语音引擎/ }).click();
      await page.getByRole("button", { name: /自定义引擎 ·/ }).click();
      await card("Eleven v4")
        .getByRole("button", { name: "试听", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      assert.equal(
        await dialog.getByRole("slider", { name: "语速" }).isDisabled(),
        true,
      );
      await dialog.locator("summary").filter({ hasText: "旁白表达" }).click();
      assert.equal(await dialog.getByLabel("风格强度").count(), 0);
      await page.setViewportSize({ width: 390, height: 844 });
      assert(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
        "mobile dialog must not overflow horizontally",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await app?.close();
      service.closeAllConnections();
      await new Promise((r) => service.close(r));
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);

test(
  "TTS browser: engine discovery ignores old results/errors/pages and credentials stay with their target",
  { timeout: 60000 },
  async () => {
    const root = path.resolve(import.meta.dirname, "../.."),
      cache = path.join(root, ".cache/tts-ui-audit");
    fs.mkdirSync(cache, { recursive: true });
    const engines = ["A", "B"].map((name, index) => ({
      id: "12345678-1234-4123-8123-00000000000" + (index + 1),
      name: "引擎 " + name,
      enabled: true,
      builtin: false,
      kind: "external",
      provider: "compatible",
      config: {
        provider: "compatible",
        url: "https://provider-" + name.toLowerCase() + ".invalid/v1",
        model: "manual-" + name,
        voice: "voice-" + name,
        configured: true,
      },
    }));
    const entry = "virtual:tts-discovery-audit.jsx";
    const server = await createServer({
      configFile: false,
      root,
      cacheDir: path.join(cache, "vite"),
      logLevel: "warn",
      optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime"] },
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: true,
        watch: { ignored: ["**/.cache/**"] },
      },
      plugins: [
        react(),
        {
          name: "tts-discovery-audit",
          resolveId: (id) => (id === entry ? "\0" + entry : undefined),
          load: (id) =>
            id === "\0" + entry
              ? [
                  "import React from 'react';",
                  "import {createRoot} from 'react-dom/client';",
                  "import {SpeechControls, SpeechSettings} from '/studio/speech.jsx';",
                  "import '/studio/workbench.css';",
                  "const engines = " + JSON.stringify(engines) + ";",
                  "function Fixture(){",
                  " const [index,setIndex]=React.useState(0), [voice,setVoice]=React.useState('voice-A');",
                  " const [speed,setSpeed]=React.useState(1), [options,setOptions]=React.useState({});",
                  " return React.createElement('main', null, React.createElement('section', {'aria-label':'目录测试'},",
                  "  React.createElement('label', null, '测试引擎', React.createElement('select', {'aria-label':'测试引擎', value:index, onChange:e=>{setIndex(Number(e.target.value));setVoice('voice-'+engines[Number(e.target.value)].name.slice(-1));}},",
                  "   engines.map((e,i)=>React.createElement('option', {key:e.id,value:i}, e.name)))),",
                  "  React.createElement(SpeechControls, {engine:engines[index], voice, setVoice, speed, setSpeed, options, setOptions})),",
                  "  React.createElement(SpeechSettings, {notify:()=>{}}));",
                  "}",
                  "createRoot(document.getElementById('root')).render(React.createElement(Fixture));",
                ].join("\n")
              : undefined,
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (req.url !== "/__tts_audit") return next();
              try {
                res.setHeader("Content-Type", "text/html");
                res.end(
                  await vite.transformIndexHtml(
                    req.url,
                    '<div id="root"></div><script type="module" src="/@id/virtual:tts-discovery-audit.jsx"></script>',
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
    const pending = [],
      saves = [],
      errors = [];
    try {
      await server.listen();
      browser = await launchBrowser();
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.routeWebSocket("**/api/ws", (socket) =>
        socket.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === "unsubscribe") return;
          const reply = (result) =>
            socket.send(JSON.stringify({
              type: message.type === "subscribe" ? "update" : "result",
              id: message.id,
              result,
            }));
          if (message.name === "engines_list") return reply(engines);
          if (message.name === "models_list") return reply([]);
          if (message.name === "engines_discover") {
            pending.push({
              ...message.args,
              reply,
              reject: () => socket.send(JSON.stringify({
                type: "result", id: message.id, status: 502, error: "旧引擎目录错误",
              })),
            });
            return;
          }
          if (message.name === "engines_save") {
            saves.push({ args: message.args, reply });
            return;
          }
          throw Error("Unexpected operation: " + message.name);
        }),
      );
      await page.goto("http://127.0.0.1:" + server.httpServer.address().port + "/__tts_audit");
      const controls = page.getByRole("region", { name: "目录测试" }),
        selector = controls.getByLabel("测试引擎"),
        discover = () => controls.getByRole("button", { name: "发现音色与模型", exact: true }),
        catalog = (name, nextCursor = null, extra = []) => ({
          source: "live",
          voices: [{ id: "voice-" + name, name: "目录音色 " + name }, ...extra],
          models: [{ id: "model-" + name, name: "目录模型 " + name }],
          nextCursor,
        }),
        settle = () => page.evaluate(() => new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await discover().click();
      await expect.poll(() => pending.length).toBe(1);
      const oldA = pending[0];
      await selector.selectOption("1");
      await expect(discover()).toBeEnabled();
      await discover().click();
      await expect.poll(() => pending.length).toBe(2);
      pending[1].reply(catalog("B", "page-2"));
      await expect(controls.getByText("服务模型目录 · 1 个")).toBeVisible();
      oldA.reply(catalog("A"));
      await settle();
      await expect(controls.locator("datalist option")).toHaveAttribute("value", "voice-B");
      await expect(controls.getByRole("button", { name: "更多音色", exact: true })).toBeVisible();

      await controls.getByRole("button", { name: "更多音色", exact: true }).click();
      await expect.poll(() => pending.length).toBe(3);
      assert.equal(pending[2].cursor, "page-2");
      const oldPage = pending[2];
      await selector.selectOption("0");
      await expect(discover()).toBeEnabled();
      await discover().click();
      await expect.poll(() => pending.length).toBe(4);
      pending[3].reply(catalog("A", "a-page-2"));
      await expect(controls.locator("datalist option")).toHaveAttribute("value", "voice-A");
      oldPage.reply(catalog("B-more"));
      await settle();
      await expect(controls.locator("datalist option")).toHaveAttribute("value", "voice-A");

      await controls.getByRole("button", { name: "更多音色", exact: true }).click();
      await expect.poll(() => pending.length).toBe(5);
      pending[4].reply({
        ...catalog("A", null, [{ id: "voice-A2", name: "目录音色 A2" }]),
        models: [],
      });
      await expect(controls.locator("datalist option")).toHaveCount(2);
      await expect(controls.getByText("服务模型目录 · 1 个")).toBeVisible();

      await discover().click();
      await expect.poll(() => pending.length).toBe(6);
      const staleError = pending[5];
      await selector.selectOption("1");
      await discover().click();
      await expect.poll(() => pending.length).toBe(7);
      staleError.reject();
      await settle();
      await expect(controls.getByRole("button", { name: "读取音色…", exact: true })).toBeDisabled();
      await expect(controls.getByText("旧引擎目录错误")).toHaveCount(0);
      pending[6].reply(catalog("B"));
      await expect(discover()).toBeEnabled();
      await expect(controls.locator("datalist option")).toHaveAttribute("value", "voice-B");

      await page.getByRole("button", { name: "添加自定义引擎", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "添加自定义引擎", exact: true });
      await editor.getByRole("button", { name: /连接语音 API/ }).click();
      await editor.getByLabel("引擎名称").fill("新的目录引擎");
      await editor.getByLabel("提供商").selectOption("openai");
      await editor.getByLabel("API 密钥").fill("fake-key-for-openai");
      await editor.getByLabel("提供商").selectOption("minimax");
      await expect(editor.getByLabel("API 密钥")).toHaveValue("");
      await expect(editor.getByText(/已清除未保存的密钥/)).toBeVisible();
      await editor.getByLabel("API 密钥").fill("fake-key-for-minimax");
      await editor.getByLabel("服务地址").fill("https://alternate.invalid/v1");
      await expect(editor.getByLabel("API 密钥")).toHaveValue("");
      await editor.getByRole("button", { name: "添加自定义引擎", exact: true }).click();
      await expect.poll(() => saves.length).toBe(1);
      assert.equal(saves[0].args.apiKey, "");
      assert.equal(saves[0].args.provider, "minimax");
      for (const label of ["提供商", "引擎名称", "服务地址", "模型名称", "API 密钥"])
        await expect(editor.getByLabel(label)).toBeDisabled();
      saves[0].reply({ id: engines[0].id });
      await expect(editor).toHaveCount(0);

      const card = page.locator(".speech-card").filter({
        has: page.getByRole("heading", { name: "引擎 A", exact: true }),
      });
      await card.getByRole("button", { name: "配置", exact: true }).click();
      const existing = page.getByRole("dialog", { name: "配置自定义引擎", exact: true });
      await expect(existing.getByLabel("API 密钥")).toHaveValue("");
      await existing.getByRole("button", { name: "保存配置", exact: true }).click();
      await expect.poll(() => saves.length).toBe(2);
      assert(!Object.hasOwn(saves[1].args, "apiKey"), "unchanged target must preserve saved credentials");
      saves[1].reply({ id: engines[0].id });
      await expect(existing).toHaveCount(0);
      assert.deepEqual(errors, []);
      await page.close();
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
