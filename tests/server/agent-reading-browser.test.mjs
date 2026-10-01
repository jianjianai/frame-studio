import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";

const url = process.env.FRAME_TEST_DATABASE_URL;
test(
  "Agent reading and recovery: ordered rich content, long steps, no scroll theft, free answers, two tabs, cancellation, notifications and narrow screens",
  { skip: !url, timeout: 120000 },
  async (t) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-agent-reading-")),
      db = await database(url, "fixture-password-at-least-14");
    await db.pool.query(
      "TRUNCATE repos,connections,github_accounts,auth_flows RESTART IDENTITY CASCADE",
    );
    const origin = `http://127.0.0.1:${Number(process.env.FRAME_TEST_PORT || 55921)}`;
    const { app, actions, tasks } = await createApp({
      db,
      data,
      masterKey: "93".repeat(32),
      origin,
      scheduler: false,
    });
    const call = (name, args = {}) => actions.call(name, args);
    const report = path.resolve(".cache/agent-chat/after");
    fs.mkdirSync(report, { recursive: true });
    let browser, page;
    const errors = [];
    try {
      const repo = await call("repositories_add", { name: "交互状态验收" }),
        work = await call("works_create", {
          repo: repo.id,
          title: "Agent 阅读与恢复验收",
        });
      const connection = await call("connections_save", {
        name: "测试提供商",
        tool: "codex",
        mode: "api",
        model: "fixture-agent",
        apiKey: "fixture-no-live-key",
      });
      const chat = await call("works_chat_create", {
        id: work.id,
        connection: connection.id,
        title: "阅读与问题确认",
      });
      const other = await call("works_chat_create", {
        id: work.id,
        connection: connection.id,
        title: "后台工作",
      });
      const task = await call("works_chat_send", {
        id: work.id,
        chat: chat.id,
        model: "fixture-agent",
        prompt: "检查动作、音乐和字幕，先询问我，再进行修改。",
      });
      await db.pool.query(
        "UPDATE tasks SET state='running',started=now() WHERE id=$1",
        [task.id],
      );
      const emit = (id, kind, extra = {}) =>
        db.event(task.id, "agent-item", {
          type: "agent-item",
          version: 1,
          at: Date.now(),
          id,
          kind,
          phase: "completed",
          ...extra,
        });
      const rich =
        "## 检查结论\n\n**动作已检查**，接下来确认音乐。\n\n| 项目 | 结论 |\n| --- | --- |\n| 节奏 | 缩短停顿 |\n| 字幕 | 保持内容 |\n\n```ts\nconst duration = 24;\n" +
        Array.from({ length: 35 }, (_, n) => `const frame${n} = ${n};`).join(
          "\n",
        ) +
        '\n```\n\n[不安全链接](javascript:alert(1))\n\n<img src=x onerror="window.INJECTED=true">';
      await emit("intro", "message", { text: rich });
      await emit("think", "thinking", {
        title: "思考摘要",
        text: "优先处理动作衔接，再校对音乐节拍。",
        publicSummary: true,
      });
      await emit("plan", "plan", {
        title: "工作计划",
        steps: [
          { id: "1", text: "检查镜头", status: "completed" },
          { id: "2", text: "调整过渡", status: "running" },
        ],
      });
      for (let n = 0; n < 72; n++)
        await emit("read-" + n, "tool", {
          title: "读取文件",
          toolName: "Read",
          input: { path: `production/shot-${n}.md` },
          output: `shot-${n}: ready`,
        });
      await emit("failed-command", "command", {
        phase: "failed",
        command: "pnpm project:check test-film",
        cwd: "/workspace",
        output: "check failed: duration mismatch",
        exitCode: 2,
        durationMs: 1400,
      });
      await emit("later", "message", { text: "问题已定位。请确认调整方向。" });
      browser = await launchBrowser();
      const context = await browser.newContext({
        viewport: { width: 1440, height: 960 },
        permissions: ["clipboard-read", "clipboard-write"],
      });
      await context.addInitScript(() => {
        window.NOTIFICATION_REQUESTS = 0;
        window.Notification = class {
          static permission = "default";
          static requestPermission() {
            window.NOTIFICATION_REQUESTS++;
            return Promise.resolve("denied");
          }
        };
      });
      page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await app.listen({
        host: "127.0.0.1",
        port: Number(process.env.FRAME_TEST_PORT || 55921),
      });
      await page.goto(origin);
      await page
        .getByLabel("登录密码", { exact: true })
        .fill("fixture-password-at-least-14");
      await page.getByRole("button", { name: "进入工作台" }).click();
      await page.evaluate(
        ({ work, chat }) =>
          sessionStorage.setItem(
            "frame.active-chat:" + work,
            JSON.stringify({ id: chat }),
          ),
        { work: work.id, chat: chat.id },
      );
      await page.goto(origin + "/#/work/" + work.id);
      const composer = page.getByRole("textbox", {
        name: "创作要求",
        exact: true,
      });
      await expect(page.locator(".agent-markdown table")).toBeVisible();
      await expect(page.locator(".agent-step")).toHaveCount(60);
      await page.getByRole("button", { name: /显示更早的 .* 个步骤/ }).click();
      await expect(page.locator(".agent-step")).toHaveCount(75);
      await page.locator('[data-agent-item="think"] > button').click();
      await expect(page.locator('[data-agent-item="think"]')).toContainText(
        "优先处理动作衔接",
      );
      await page.locator('[data-agent-item="plan"] > button').click();
      await expect(page.locator(".agent-plan")).toContainText("调整过渡");
      await expect(page.locator(".agent-exit-status")).toContainText(
        "退出码 2",
      );
      await expect(page.locator(".agent-code-block")).toHaveCount(1);
      await page.getByRole("button", { name: "复制代码", exact: true }).click();
      assert(
        (await page.evaluate(() => navigator.clipboard.readText())).startsWith(
          "const duration = 24;",
        ),
      );
      await page
        .getByRole("button", { name: "展开完整代码", exact: true })
        .click();
      await expect(page.locator(".agent-code-block")).toHaveClass(/expanded/);
      assert.equal(
        await page.locator('.agent-markdown a[href^="javascript:"]').count(),
        0,
      );
      assert.equal(await page.locator(".agent-markdown img").count(), 0);
      assert.equal(await page.evaluate(() => window.INJECTED), undefined);
      const order = await page
        .locator("[data-agent-item]")
        .evaluateAll((elements) => elements.map((e) => e.dataset.agentItem));
      assert(
        order.indexOf("intro") < order.indexOf("think") &&
          order.indexOf("think") < order.indexOf("later"),
      );
      await composer.focus();
      await page.keyboard.press("Control+f");
      await page
        .getByRole("textbox", { name: "搜索已加载对话", exact: true })
        .fill("shot-4: ready");
      await expect(page.locator('[data-agent-item="read-4"]')).toContainText(
        "shot-4: ready",
      );
      await page.keyboard.press("Escape");
      await page.locator(".chat-messages").evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await emit("new-stream", "message", {
        phase: "running",
        text: "持续更新，不打断正在阅读的旧内容。",
      });
      await expect(page.locator('[data-agent-item="new-stream"]')).toHaveCount(
        1,
      );
      assert(
        await page
          .locator(".chat-messages")
          .evaluate((el) => el.scrollTop < 10),
        "Streaming must not pull a reader away from old content",
      );
      await page.screenshot({ path: path.join(report, "08-rich-reading.png") });
      t.diagnostic(
        "Ordered Markdown, table, syntax-highlighted code/copy, safe links, plan/thinking, bounded step list and no scroll theft passed.",
      );
      const q = await actions.interactions.create(task.id, {
        requestKey: "freeform",
        title: "补充创作要求",
        questions: [
          { id: "focus", question: "请描述最重要的调整要求", options: [] },
        ],
      });
      await page.getByRole("button", { name: "回答", exact: true }).click();
      const input = page.getByRole("textbox", {
        name: "请描述最重要的调整要求 自由回答",
        exact: true,
      });
      await input.fill("保留音乐，加快开场衔接。");
      await page.reload();
      await expect(input).toHaveValue("保留音乐，加快开场衔接。");
      const second = await context.newPage();
      second.on("pageerror", (e) => errors.push(e.message));
      await second.addInitScript(
        ({ work, chat }) => {
          // This fixture selects the Studio chat, not opaque project iframes.
          if (window !== window.top) return;
          sessionStorage.setItem(
            "frame.active-chat:" + work,
            JSON.stringify({ id: chat }),
          );
        },
        { work: work.id, chat: chat.id },
      );
      await second.goto(origin + "/#/work/" + work.id);
      await expect(second.locator(".agent-question.is-pending")).toBeVisible();
      await page.bringToFront();
      await page.setViewportSize({ width: 390, height: 680 });
      await input.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(report, "09-free-answer-mobile.png"),
      });
      await page
        .getByRole("button", { name: "提交并继续", exact: true })
        .click();
      await expect(page.locator(".agent-answer-toggle")).toContainText(
        "保留音乐，加快开场衔接。",
      );
      await expect(second.locator(".agent-question.is-resolved")).toContainText(
        "保留音乐，加快开场衔接。",
      );
      assert.equal(
        (await call("agent_questions", { work: work.id, task: task.id }))[0]
          .answers.focus.text,
        "保留音乐，加快开场衔接。",
      );
      await second.close();
      const cancelQ = await actions.interactions.create(task.id, {
        requestKey: "cancel-question",
        title: "可取消的问题",
        questions: [
          {
            id: "cancel",
            question: "是否继续？",
            options: [{ id: "yes", label: "继续" }],
          },
        ],
      });
      await expect(page.locator(".agent-question.is-pending")).toBeVisible();
      await page
        .locator(".agent-question.is-pending")
        .getByRole("button", { name: "停止创作", exact: true })
        .click();
      await expect(page.locator("#agent-question-" + cancelQ.id)).toContainText(
        "未使用默认答案",
      );
      assert.equal(
        (await call("agent_questions", { work: work.id, task: task.id })).find(
          (q) => q.id === cancelQ.id,
        ).answers,
        null,
      );
      await db.pool.query(
        "UPDATE tasks SET state='cancelled',finished=now() WHERE id=$1",
        [task.id],
      );
      assert.equal(
        await page.evaluate(() => window.NOTIFICATION_REQUESTS),
        0,
        "Notification permission is never requested automatically",
      );
      t.diagnostic(
        "Free-answer draft survives reload, second tab receives answer, cancellation closes the question without selecting a default.",
      );
      await page.setViewportSize({ width: 1440, height: 960 });
      const background = await call("works_chat_send", {
        id: work.id,
        chat: other.id,
        model: "fixture-agent",
        prompt: "后台失败恢复测试",
      });
      await db.pool.query(
        "UPDATE tasks SET state='failed',error='Upstream unavailable: fixture',finished=now() WHERE id=$1",
        [background.id],
      );
      await expect(page.locator(".agent-toast")).toContainText("创作需要处理");
      await page
        .locator(".agent-toast")
        .getByRole("button", { name: "查看", exact: true })
        .click();
      await expect(page.locator("#agent-turn-" + background.id)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "保留原引用重试", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(report, "10-error-recovery.png"),
      });
      await page
        .getByRole("button", { name: "Agent 通知", exact: true })
        .click();
      const center = page.getByRole("dialog", {
        name: "Agent 通知",
        exact: true,
      });
      await expect(center).toContainText("创作需要处理");
      await center
        .getByRole("button", { name: "通知设置", exact: true })
        .click();
      await center
        .getByRole("checkbox", { name: "窗口失焦时发送桌面通知", exact: true })
        .click();
      await expect(center).toContainText("桌面通知未获授权");
      assert.equal(await page.evaluate(() => window.NOTIFICATION_REQUESTS), 1);
      await center
        .getByRole("button", { name: "关闭弹窗", exact: true })
        .click();
      for (const size of [
        { width: 320, height: 480 },
        { width: 390, height: 844 },
        { width: 768, height: 600 },
      ]) {
        await page.setViewportSize(size);
        await expect(composer).toBeVisible();
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          "No page overflow: " + JSON.stringify(size),
        );
        const box = await composer.boundingBox();
        assert(box.height >= 35 && box.y + box.height <= size.height);
      }
      assert.deepEqual(errors, []);
      t.diagnostic(
        "Failure toast, durable notification center, exact-conversation navigation, explicit desktop permission denial, 320×480 and tablet layouts passed. These UI state fixtures do not claim additional model execution.",
      );
    } catch (error) {
      await page
        ?.screenshot({
          path: path.join(report, "reading-failure.png"),
          fullPage: true,
        })
        .catch(() => {});
      console.error("READING ERRORS", errors);
      throw error;
    } finally {
      await browser?.close();
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
