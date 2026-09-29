import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { treeHash } from "../../server/security.mjs";
import { fixture, repo as platformRoot } from "../mcp/helpers.mjs";
import { executeProject } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { runtimeIdentity } from "../../scripts/runtime-identity.mjs";
import { PREVIEW_VERSION } from "../../server/preview-version.mjs";

const url = process.env.FRAME_TEST_DATABASE_URL;
test(
  "AI workbench: real settings, provider grouping, model switches, drafts, keyboard, results and responsive layout",
  { skip: !url, timeout: 180000 },
  async () => {
    assert.match(new URL(url).pathname, /frame_test/);
    const port = Number(process.env.FRAME_TEST_PORT || 55871),
      origin = `http://127.0.0.1:${port}`;
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-ai-browser-"));
    const f = fixture({ browser: true, renderer: "canvas" });
    const report = path.join(platformRoot, ".cache/ai-workbench/screenshots");
    fs.mkdirSync(report, { recursive: true });
    const db = await database(url, "test-password-at-least-14");
    await db.pool.query(
      "TRUNCATE repos,connections,github_accounts,auth_flows RESTART IDENTITY CASCADE",
    );
    const { app, actions } = await createApp({
      db,
      data,
      masterKey: "33".repeat(32),
      origin,
      scheduler: false,
    });
    const call = (name, args = {}) => actions.call(name, args);
    const provider = http.createServer(async (request, response) => {
      for await (const _ of request) {
        /* Consume the tiny test body. */
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url.endsWith("/models")
            ? { data: [{ id: "model-discovered", display_name: "发现的模型" }] }
            : { output: [{ content: [{ text: "READY" }] }] },
        ),
      );
    });
    let browser, page;
    const errors = [];
    try {
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
      const a = await call("connections_save", {
        name: "OpenAI · 团队",
        tool: "codex",
        mode: "api",
        baseUrl,
        apiKey: "fixture-only-secret",
        publicCatalog: false,
        model: "model-large",
        models: [
          { id: "model-large", name: "主力创作", enabled: true },
          { id: "model-small", name: "快速调整", enabled: true },
          { id: "model-disabled", name: "已停用模型", enabled: false },
        ],
      });
      const b = await call("connections_save", {
        name: "Anthropic · 备用",
        tool: "claude",
        mode: "api",
        baseUrl,
        apiKey: "fixture-only-secret",
        publicCatalog: false,
        model: "claude-primary",
        models: [{ id: "claude-primary", name: "备用创作", enabled: true }],
      });
      const repo = await call("repositories_add", { name: "AI 工作台测试" });
      fs.cpSync(
        f.file(""),
        path.join(data, "repos", repo.id, "projects/test-film"),
        { recursive: true },
      );
      await actions.works.discover(repo.id);
      const work = (await call("works_page", { repo: repo.id })).items[0];
      const oldPreview = process.env.FRAME_WORK_PREVIEW;
      process.env.FRAME_WORK_PREVIEW = "1";
      let built;
      try {
        built = await executeProject(f.root, "test-film", "build");
      } finally {
        if (oldPreview === undefined) delete process.env.FRAME_WORK_PREVIEW;
        else process.env.FRAME_WORK_PREVIEW = oldPreview;
      }
      assert.equal(built.status, "passed", JSON.stringify(built));
      const previewId = randomUUID(),
        relative = "projects/test-film/exports/preview";
      fs.cpSync(built.output, path.join(data, "runs", previewId, relative), {
        recursive: true,
      });
      await db.pool.query(
        "INSERT INTO tasks(id,repo,project,kind,state,input,result,fingerprint,finished) VALUES($1,$2,'test-film','build','succeeded','{}',$3,$4,now())",
        [
          previewId,
          repo.id,
          {
            runtimeFingerprint: (await runtimeIdentity()).fingerprint,
            previewVersion: PREVIEW_VERSION,
            artifacts: [{ name: "index.html", path: relative + "/index.html" }],
          },
          treeHash(path.join(data, "works", work.id, "projects/test-film")),
        ],
      );
      const chat = await call("works_chat_create", {
        id: work.id,
        connection: a.id,
        title: "动画节奏与声音优化",
      });
      const turn = await call("works_chat_send", {
        id: work.id,
        chat: chat.id,
        prompt: "让动画的运动衔接更利落，保留音乐。",
        model: "model-large",
      });
      // This is explicitly a stored review fixture, not a claim that a real AI ran.
      await db.pool.query(
        "UPDATE tasks SET state='succeeded',result=$2,finished=now() WHERE id=$1",
        [turn.id, { previewTask: previewId }],
      );
      await db.event(turn.id, "message", {
        id: "fixture-reply",
        text: "已准备好本轮审片预览。\n\n**修改重点**\n- 保持画面与声音同步。\n- 可以直接查看这轮结果，继续提出调整要求。",
      });
      await app.listen({ host: "127.0.0.1", port });
      browser = await launchBrowser();
      const context = await browser.newContext({
        viewport: { width: 1500, height: 1000 },
      });
      page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      await page
        .getByLabel("登录密码", { exact: true })
        .fill("test-password-at-least-14");
      await page.getByRole("button", { name: "进入工作台" }).click();
      await page.goto(origin + "/#/settings/ai");
      await expect(
        page.getByRole("heading", { name: "提供商与模型" }),
      ).toBeVisible();
      await expect(page.locator(".provider-list-item")).toHaveCount(2);
      await page
        .locator(".provider-list-item")
        .filter({ hasText: a.name })
        .click();
      await page.getByRole("button", { name: "添加模型", exact: true }).click();
      await page.getByLabel("模型 ID", { exact: true }).fill("model-manual");
      await page.getByLabel("显示名称", { exact: true }).fill("手动模型");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "添加模型", exact: true })
        .click();
      await expect(
        page
          .locator(".provider-model-name")
          .filter({ hasText: "model-manual" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "发现模型", exact: true }).click();
      const discovered = page.getByRole("dialog", { name: "从提供商添加模型" });
      await expect(discovered).toBeVisible();
      await discovered.getByRole("checkbox").check();
      await discovered
        .getByRole("button", { name: "添加所选模型（1）", exact: true })
        .click();
      await expect(discovered).toHaveCount(0);
      await page
        .getByRole("button", { name: "测试模型 快速调整", exact: true })
        .click();
      await expect(page.locator(".provider-test.passed")).toContainText(
        "model-small",
      );
      await expect(
        page.getByLabel("提供商默认模型", { exact: true }),
      ).toHaveValue("model-large");
      await page.getByRole("button", { name: "编辑连接", exact: true }).click();
      const form = page.getByRole("dialog", { name: "编辑提供商" });
      await expect(form.getByLabel("API 密钥", { exact: true })).toHaveValue(
        "",
      );
      await form
        .getByLabel("提供商名称", { exact: true })
        .fill("OpenAI · 创作团队");
      await form
        .getByRole("button", { name: "保存提供商", exact: true })
        .click();
      await expect(page.locator(".provider-detail-heading")).toContainText(
        "OpenAI · 创作团队",
      );
      assert.equal(
        JSON.stringify(await call("connections_list")).includes(
          "fixture-only-secret",
        ),
        false,
      );
      await page.screenshot({
        path: path.join(report, "settings-desktop.png"),
      });
      await page.getByLabel("搜索设置", { exact: true }).fill("快捷键");
      await page
        .locator(".settings-search-results")
        .getByRole("button", { name: /创作偏好/ })
        .click();
      await expect(page).toHaveURL(/settings\/general/);
      await page
        .getByLabel("发送快捷键", { exact: true })
        .selectOption("enter");
      await page.getByLabel("聊天文字大小", { exact: true }).selectOption("15");
      await page.reload();
      await expect(page.getByLabel("发送快捷键", { exact: true })).toHaveValue(
        "enter",
      );
      await page.getByRole("button", { name: "选择模型", exact: true }).click();
      await page.getByRole("option", { name: /快速调整/ }).click();
      assert.equal(
        await page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("frame.ai-preferences.v1"))
              .defaultSelection.model,
        ),
        "model-small",
      );
      await page.goto(origin + "/#/work/" + work.id);
      await expect(
        page.getByRole("button", { name: "选择模型", exact: true }),
      ).toContainText("主力创作");
      await expect(page.locator(".chat-selectors")).toHaveCount(0);
      const composer = page.getByLabel("创作要求", { exact: true });
      await composer.fill("保留这个尚未发送的草稿");
      await page.getByRole("button", { name: "选择模型", exact: true }).click();
      await expect(
        page.getByRole("group", { name: "OpenAI · 创作团队", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("group", { name: b.name, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("option", { name: /已停用模型/ }),
      ).toHaveAttribute("aria-disabled", "true");
      await page
        .getByRole("button", {
          name: "收藏 OpenAI · 创作团队 快速调整",
          exact: true,
        })
        .click();
      await page.getByLabel("搜索模型或提供商", { exact: true }).fill("快速");
      await page.getByLabel("搜索模型或提供商", { exact: true }).press("Enter");
      await expect(
        page.getByRole("button", { name: "选择模型", exact: true }),
      ).toContainText("快速调整");
      await expect(composer).toHaveValue("保留这个尚未发送的草稿");
      await page.getByRole("button", { name: "选择模型", exact: true }).click();
      await page
        .getByLabel("搜索模型或提供商", { exact: true })
        .press("Escape");
      await expect(
        page.getByRole("dialog", { name: "模型选择器" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "选择模型", exact: true }),
      ).toBeFocused();
      await page.screenshot({ path: path.join(report, "chat-desktop.png") });
      await page.getByRole("button", { name: "选择模型", exact: true }).click();
      await page.screenshot({
        path: path.join(report, "chat-model-picker.png"),
      });
      await page
        .getByLabel("搜索模型或提供商", { exact: true })
        .press("Escape");
      await page
        .getByRole("button", { name: "展开输入框", exact: true })
        .click();
      await expect(page.locator(".composer-expanded")).toBeVisible();
      await page
        .getByRole("button", { name: "收起输入框", exact: true })
        .click();
      await page
        .locator(".ai-chat")
        .getByRole("button", { name: "关闭 AI 对话", exact: true })
        .click();
      await page
        .getByRole("button", { name: "打开 AI 对话", exact: true })
        .click();
      await expect(composer).toHaveValue("保留这个尚未发送的草稿");
      await page.reload();
      await expect(composer).toHaveValue("保留这个尚未发送的草稿");
      await expect(
        page.getByRole("button", { name: "选择模型", exact: true }),
      ).toContainText("快速调整");
      await composer.press("Shift+Enter");
      await expect(composer).toHaveValue(/\n/);
      assert.equal(
        (await call("works_tasks", { id: work.id })).filter(
          (task) => task.kind === "agent",
        ).length,
        1,
      );
      await composer.evaluate((element) =>
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            isComposing: true,
            bubbles: true,
          }),
        ),
      );
      assert.equal(
        (await call("works_tasks", { id: work.id })).filter(
          (task) => task.kind === "agent",
        ).length,
        1,
        "IME confirmation does not send",
      );
      await composer.fill("第一条实际排队要求");
      await composer.press("Enter");
      await expect(composer).toHaveValue("");
      let task = (await call("works_tasks", { id: work.id })).find(
        (task) => task.input.prompt === "第一条实际排队要求",
      );
      assert.equal(task.input.model, "model-small");
      assert.equal(task.chat, chat.id);
      await expect(
        page.getByRole("button", { name: "排队发送", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "选择模型", exact: true }).click();
      await page.getByRole("option", { name: /备用创作/ }).click();
      await expect(page.locator(".provider-switch-note")).toContainText(
        "新建对话",
      );
      await composer.fill("切换到备用提供商");
      await page.getByRole("button", { name: "排队发送", exact: true }).click();
      await expect(composer).toHaveValue("");
      task = (await call("works_tasks", { id: work.id })).find(
        (task) => task.input.prompt === "切换到备用提供商",
      );
      assert.equal(task.input.connection, b.id);
      assert.equal(task.input.model, "claude-primary");
      assert.notEqual(task.chat, chat.id);
      assert.equal((await call("works_chats", { id: work.id })).length, 2);
      await page.getByRole("button", { name: "对话历史", exact: true }).click();
      await page
        .getByRole("dialog", { name: "选择创作对话" })
        .getByRole("button", { name: "动画节奏与声音优化", exact: true })
        .click();
      await page
        .getByRole("button", { name: "查看本轮预览与修改", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "本轮修改与审片" }).locator("iframe"),
      ).toHaveAttribute("src", /\/preview\//);
      await page
        .getByRole("dialog", { name: "本轮修改与审片" })
        .getByRole("button", { name: "关闭弹窗", exact: true })
        .click();
      for (const width of [1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        if (!(await page.locator(".ai-chat").isVisible()))
          await page
            .getByRole("button", { name: "打开 AI 对话", exact: true })
            .click();
        await page
          .getByRole("button", { name: "选择模型", exact: true })
          .click();
        const box = await page
          .getByRole("dialog", { name: "模型选择器" })
          .boundingBox();
        assert(
          box.x >= -1 && box.x + box.width <= width + 1 && box.y >= 0,
          `model picker fits ${width}: ${JSON.stringify(box)}`,
        );
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        if (width === 390)
          await page.screenshot({ path: path.join(report, "chat-mobile.png") });
        await page
          .getByLabel("搜索模型或提供商", { exact: true })
          .press("Escape");
      }
      await page.goto(origin + "/#/settings/ai");
      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.locator(".provider-workspace")).toBeVisible();
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          `settings overflow at ${width}`,
        );
        if (width === 390)
          await page.screenshot({
            path: path.join(report, "settings-mobile.png"),
          });
      }
      assert.deepEqual(errors, []);
      console.log(
        "AI settings/chat passed: real database + WebSocket + browser; local fake model endpoint; no live AI execution.",
      );
    } catch (error) {
      await page
        ?.screenshot({ path: path.join(report, "failure.png"), fullPage: true })
        .catch(() => {});
      throw error;
    } finally {
      await browser?.close();
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await app.close();
      f.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
