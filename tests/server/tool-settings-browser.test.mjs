import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import { expect } from "@playwright/test";
import { launchBrowser } from "../../scripts/browser.mjs";

test(
  "tool settings: latest/manual updates, input recovery, live progress, retry, history and responsive layout",
  { timeout: 60000 },
  async () => {
    const root = path.resolve(import.meta.dirname, "../.."),
      report = path.join(root, ".cache/tool-settings-review");
    fs.mkdirSync(report, { recursive: true });
    const port = Number(process.env.FRAME_TEST_PORT || 56843);
    const ui = await createServer({
      configFile: path.join(root, "studio/vite.config.mjs"),
      configLoader: "runner",
      cacheDir: path.join(report, "vite"),
      logLevel: "warn",
      server: { host: "127.0.0.1", port, strictPort: true },
    });
    let browser;
    const calls = [],
      errors = [],
      subscriptions = new Set();
    const now = new Date().toISOString();
    const tools = [
      {
        tool: "codex",
        available: true,
        version: "codex-cli 1.9.0",
        installedVersion: "1.9.0",
        installedVersions: ["1.9.0"],
        localMode: false,
        updateAvailable: true,
        updates: [],
        releasesUrl: "https://github.com/openai/codex/releases",
        release: { status: "ready", latestVersion: "1.10.0", checkedAt: now },
      },
      {
        tool: "claude",
        available: true,
        version: "2.0.0 (Claude Code)",
        installedVersion: "2.0.0",
        installedVersions: [],
        localMode: false,
        updateAvailable: false,
        updates: [],
        release: { status: "ready", latestVersion: "2.0.0", checkedAt: now },
      },
    ];
    const broadcast = () => {
      for (const sub of subscriptions)
        if (sub.name === "tools_info")
          sub.route.send(
            JSON.stringify({ type: "update", id: sub.id, result: tools }),
          );
    };
    const handle = (name, args) => {
      if (name === "tools_info" || name === "tools_check_updates") return tools;
      if (name === "tools_update") {
        if (args.version === "9.9.9")
          throw Error("官方包中没有这个版本，请检查版本号。");
        const tool = tools.find((tool) => tool.tool === args.provider);
        const version =
          args.version === "latest"
            ? tool.release.latestVersion
            : args.version.replace(/^v/, "");
        const task = {
          id: randomUUID(),
          kind: "tools-update",
          state: "queued",
          input: { provider: args.provider, version },
          created: now,
        };
        tool.updates.unshift(task);
        return task;
      }
      if (name === "task_get")
        return {
          task: tools
            .flatMap((tool) => tool.updates)
            .find((task) => task.id === args.id),
          events: [
            {
              id: 1,
              kind: "log",
              created: now,
              data: { text: "npm: official package installed\n" },
            },
          ],
        };
      if (name === "task_retry_publish") {
        const task = tools.flatMap((tool) => tool.updates).find((task) => task.id === args.id);
        task.state = "publishing";
        return task;
      }
      if (name === "agent_notifications")
        return { items: [], unread: 0, next: null };
      if (name === "system_status") return { warnings: [] };
      return [];
    };
    try {
      await ui.listen();
      browser = await launchBrowser();
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      await context.route("**/api/me", (route) =>
        route.fulfill({ json: { admin: true, localMode: false } }),
      );
      await context.routeWebSocket("**/api/ws", (route) => {
        route.onMessage((text) => {
          const message = JSON.parse(String(text));
          if (message.type === "unsubscribe") {
            for (const sub of subscriptions)
              if (sub.id === message.id) subscriptions.delete(sub);
            return;
          }
          if (message.type === "subscribe")
            subscriptions.add({ ...message, route });
          else calls.push({ name: message.name, args: message.args });
          try {
            route.send(
              JSON.stringify({
                type: message.type === "subscribe" ? "update" : "result",
                id: message.id,
                result: handle(message.name, message.args),
              }),
            );
            if (message.name === "tools_update") broadcast();
          } catch (error) {
            route.send(
              JSON.stringify({
                type: message.type === "subscribe" ? "update" : "result",
                id: message.id,
                error: error.message,
                status: 404,
              }),
            );
          }
        });
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("http://127.0.0.1:" + port + "/#/settings/tools");
      const codex = page.getByRole("article", {
        name: "Codex 工具",
        exact: true,
      });
      const claude = page.getByRole("article", {
        name: "Claude Code 工具",
        exact: true,
      });
      await expect(codex.getByText("有新版本", { exact: true })).toBeVisible();
      await expect(
        claude.getByRole("button", { name: "已是最新" }),
      ).toBeDisabled();
      await page.screenshot({
        path: path.join(report, "desktop.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "检查创作工具更新" }).click();
      await expect(
        page.getByText("已检查最新版本", { exact: true }),
      ).toBeVisible();
      assert.ok(calls.some((call) => call.name === "tools_check_updates"));

      await codex.getByRole("button", { name: "更新到最新" }).click();
      await expect(
        claude.getByRole("button", { name: "指定版本" }),
      ).toBeDisabled();
      assert.deepEqual(
        calls.filter((call) => call.name === "tools_update").at(-1).args,
        { provider: "codex", version: "latest" },
      );
      const latest = tools[0].updates[0];
      latest.state = "running";
      latest.progress = { stage: "下载并安装官方版本" };
      broadcast();
      await expect(
        codex.getByText("下载并安装官方版本", { exact: true }),
      ).toBeVisible();
      latest.state = "succeeded";
      tools[0].installedVersion = "1.10.0";
      tools[0].updateAvailable = false;
      broadcast();
      await expect(
        codex.getByRole("button", { name: "已是最新" }),
      ).toBeDisabled();

      await codex.getByRole("button", { name: "指定版本" }).click();
      const dialog = page.getByRole("dialog", { name: "Codex · 指定版本" });
      await dialog.getByLabel("目标版本").fill("9.9.9");
      await dialog.getByRole("button", { name: "安装此版本" }).click();
      await expect(
        dialog.getByText("官方包中没有这个版本，请检查版本号。"),
      ).toBeVisible();
      await expect(dialog.getByLabel("目标版本")).toHaveValue("9.9.9");
      await dialog.getByLabel("目标版本").fill("v1.9.0");
      await dialog.getByRole("button", { name: "安装此版本" }).click();
      await expect(dialog).not.toBeVisible();
      assert.equal(
        calls.filter((call) => call.name === "tools_update").at(-1).args
          .version,
        "v1.9.0",
      );

      const manual = tools[0].updates[0];
      manual.state = "failed";
      manual.error = "连接超时，当前版本已保留";
      broadcast();
      await expect(
        codex.getByRole("button", { name: "重试更新" }),
      ).toBeEnabled();
      await codex.locator("summary").click();
      await codex
        .getByRole("button", { name: "查看 Codex 1.9.0 更新详情", exact: true })
        .click();
      const logDialog = page.getByRole("dialog", { name: "Codex 更新详情" });
      await expect(
        logDialog.getByText("npm: official package installed"),
      ).toBeVisible();
      await logDialog.getByRole("button", { name: "关闭弹窗" }).click();
      await codex.getByRole("button", { name: "重试更新" }).click();
      assert.equal(
        calls.filter((call) => call.name === "tools_update").at(-1).args
          .version,
        "1.9.0",
      );
      tools[0].updates[0].state = "succeeded";
      broadcast();

      const recovery = tools[0].updates[0];
      recovery.state = "publish_failed";
      recovery.error = "安装已完成，结果保存需要重试";
      broadcast();
      await expect(claude.getByRole("button", { name: "指定版本" })).toBeDisabled();
      const installsBeforeRecovery = calls.filter((call) => call.name === "tools_update").length;
      await codex.getByRole("button", { name: "重试保存结果" }).click();
      assert.deepEqual(calls.filter((call) => call.name === "task_retry_publish").at(-1).args, { id: recovery.id });
      assert.equal(calls.filter((call) => call.name === "tools_update").length, installsBeforeRecovery);
      recovery.state = "succeeded";
      broadcast();

      tools[1].release = {
        status: "error",
        latestVersion: "2.0.0",
        checkedAt: now,
        error: "无法连接官方版本服务，请检查网络后重试。",
      };
      broadcast();
      await expect(claude.getByText("上次发现的版本")).toBeVisible();
      await expect(
        claude.getByRole("button", { name: "检查并更新" }),
      ).toBeEnabled();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(codex).toBeVisible();
      await page.screenshot({
        path: path.join(report, "mobile.png"),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        true,
        "mobile page must not overflow horizontally",
      );
      for (const tool of tools) tool.localMode = true;
      broadcast();
      await expect(
        page.getByText("由这台电脑管理", { exact: false }),
      ).toHaveCount(2);
      await expect(page.getByRole("button", { name: "指定版本" })).toHaveCount(
        0,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await ui.close();
    }
  },
);
