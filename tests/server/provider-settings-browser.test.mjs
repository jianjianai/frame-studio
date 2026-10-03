import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { expect } from "@playwright/test";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { repo as root } from "../mcp/helpers.mjs";
const url = process.env.FRAME_TEST_DATABASE_URL;

test(
  "provider setup browser: automatic discovery, metadata provenance, batch sync, manual fallback and safe deletion",
  { skip: !url, timeout: 120000 },
  async () => {
    const data = fs.mkdtempSync(
      path.join(os.tmpdir(), "frame-provider-browser-"),
    );
    const db = await database(url, "test-password-at-least-14");
    await db.pool.query(
      "TRUNCATE repos,connections,auth_flows RESTART IDENTITY CASCADE",
    );
    const origin = `http://127.0.0.1:${Number(process.env.FRAME_TEST_PORT || 56971)}`;
    const { app, actions, tasks } = await createApp({
      db,
      data,
      masterKey: "88".repeat(32),
      origin,
      scheduler: false,
    });
    const call = (name, args = {}) => actions.call(name, args);
    const report = path.join(root, ".cache/provider-models/screenshots");
    fs.mkdirSync(report, { recursive: true });
    tasks.connections.catalogLoader = async () => ({
      openai: {
        models: {
          "model-fast": {
            name: "快速调整",
            limit: { context: 64000, output: 4096 },
            tool_call: true,
            cost: { input: 0.4, output: 1.2 },
          },
        },
      },
    });
    let contextWindow = 128000,
      broken = false;
    const requests = [],
      errors = [];
    const upstream = http.createServer(async (request, response) => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
      });
      for await (const _ of request) {
        /* Consume bounded fixture request. */
      }
      response.setHeader("content-type", "application/json");
      if (broken) {
        response.statusCode = 404;
        response.end(
          JSON.stringify({ error: "test-key-must-stay-server-side" }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          data: [
            {
              id: "model-main",
              display_name: "主力创作",
              context_length: contextWindow,
              max_output_tokens: 8192,
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
              },
              supported_parameters: ["tools", "reasoning"],
              pricing: { prompt: "0.000002", completion: "0.000008" },
            },
            { id: "model-fast" },
          ],
        }),
      );
    });
    let browser, page;
    try {
      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
      await app.listen({
        host: "127.0.0.1",
        port: Number(new URL(origin).port),
      });
      browser = await launchBrowser();
      page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      await page
        .getByLabel("登录密码", { exact: true })
        .fill("test-password-at-least-14");
      await page.getByRole("button", { name: "进入工作台" }).click();
      await page.goto(origin + "/#/settings/ai");
      await page
        .getByRole("button", { name: "添加提供商", exact: true })
        .click();
      let dialog = page.getByRole("dialog", {
        name: "添加提供商",
        exact: true,
      });
      await dialog.getByRole("button", { name: /Anthropic/ }).click();
      await expect(dialog.getByLabel("创作工具 / API 协议")).toHaveValue(
        "claude",
      );
      await dialog.getByRole("button", { name: /OpenAI/ }).click();
      await expect(dialog.getByLabel("API 地址", { exact: true })).toHaveValue(
        "https://api.openai.com/v1",
      );
      await dialog
        .getByLabel("提供商名称", { exact: true })
        .fill("团队创作 API");
      await dialog
        .getByLabel("API 地址", { exact: true })
        .fill(baseUrl + "/models");
      await dialog
        .getByLabel("API 密钥", { exact: true })
        .fill("test-key-must-stay-server-side");
      await dialog
        .getByRole("button", { name: "保存并获取模型", exact: true })
        .click();
      dialog = page.getByRole("dialog", {
        name: "从提供商添加模型",
        exact: true,
      });
      await expect(
        dialog.getByRole("checkbox", { name: "选择模型 主力创作" }),
      ).toBeVisible();
      await expect(dialog).toContainText("128K 上下文");
      await expect(dialog).toContainText("含公共参考");
      await dialog
        .getByRole("button", { name: "选择当前结果", exact: true })
        .click();
      await dialog.getByLabel("导入后默认模型").selectOption("model-fast");
      await page.screenshot({
        path: path.join(report, "discovery-desktop.png"),
      });
      await dialog
        .getByRole("button", { name: "添加所选模型（2）", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".provider-model")).toHaveCount(2);
      await expect(
        page.getByLabel("提供商默认模型", { exact: true }),
      ).toHaveValue("model-fast");
      let provider = (await call("connections_list"))[0];
      assert.equal(provider.baseUrl, baseUrl);
      assert.equal(provider.models[0].metadata.inputPrice, 2);
      assert.equal(
        provider.models[1].metadata.sources.contextWindow,
        "catalog",
      );
      assert(
        !JSON.stringify(provider).includes("test-key-must-stay-server-side"),
      );
      await page
        .getByRole("button", { name: "编辑模型参数 主力创作", exact: true })
        .click();
      dialog = page.getByRole("dialog", { name: "模型参数", exact: true });
      await dialog.getByLabel("显示名称", { exact: true }).fill("我的主力");
      await dialog.locator("summary").click();
      await expect(
        dialog.getByLabel("覆盖上下文窗口", { exact: true }),
      ).toHaveValue("128000");
      await dialog.getByLabel("覆盖上下文窗口", { exact: true }).fill("64000");
      await dialog
        .getByRole("button", { name: "保存模型", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await page
        .getByRole("checkbox", { name: "启用模型 我的主力", exact: true })
        .click();
      await expect(
        page.getByRole("checkbox", { name: "启用模型 我的主力", exact: true }),
      ).not.toBeChecked();
      await expect(
        page.getByRole("button", { name: "发现模型", exact: true }),
      ).toBeEnabled();
      contextWindow = 256000;
      await page.getByRole("button", { name: "发现模型", exact: true }).click();
      dialog = page.getByRole("dialog", { name: "从提供商添加模型" });
      await expect(
        dialog.getByRole("checkbox", { name: "选择模型 主力创作" }),
      ).toBeVisible();
      await dialog.getByLabel("筛选发现的模型").selectOption("existing");
      await dialog
        .getByRole("button", { name: "选择当前结果", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "导入并更新（2）", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      provider = (await call("connections_list"))[0];
      assert.equal(provider.models[0].name, "我的主力");
      assert.equal(provider.models[0].enabled, false);
      assert.equal(provider.models[0].overrides.contextWindow, 64000);
      assert.equal(provider.models[0].metadata.contextWindow, 256000);
      assert.equal(provider.model, "model-fast");
      await page
        .getByRole("button", { name: "编辑模型参数 我的主力", exact: true })
        .click();
      dialog = page.getByRole("dialog", { name: "模型参数" });
      await dialog.locator("summary").click();
      await dialog
        .getByRole("button", { name: "恢复自动上下文窗口", exact: true })
        .click();
      await expect(
        dialog.getByLabel("覆盖上下文窗口", { exact: true }),
      ).toHaveValue("256000");
      await dialog
        .getByRole("button", { name: "保存模型", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await page.screenshot({
        path: path.join(report, "settings-desktop.png"),
      });
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          `settings fits ${width}`,
        );
        await page
          .getByRole("button", { name: "编辑模型参数 我的主力", exact: true })
          .click();
        dialog = page.getByRole("dialog", { name: "模型参数" });
        await expect(dialog).toBeVisible();
        assert(
          await dialog.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
          `spec dialog fits ${width}`,
        );
        if ([1440, 390].includes(width))
          await page.screenshot({
            path: path.join(report, `specifications-${width}.png`),
          });
        await dialog
          .getByRole("button", { name: "关闭弹窗", exact: true })
          .click();
        if (width === 390)
          await page.screenshot({
            path: path.join(report, "settings-mobile.png"),
          });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      broken = true;
      await page.getByRole("button", { name: "发现模型", exact: true }).click();
      dialog = page.getByRole("dialog", { name: "从提供商添加模型" });
      await expect(dialog.getByRole("alert")).toContainText("HTTP 404");
      assert(
        !(await dialog.innerText()).includes("test-key-must-stay-server-side"),
      );
      broken = false;
      await dialog
        .getByRole("button", { name: "重新获取", exact: true })
        .click();
      await expect(dialog.getByRole("checkbox")).toHaveCount(2);
      await dialog
        .getByRole("button", { name: "手动添加模型", exact: true })
        .click();
      dialog = page.getByRole("dialog", { name: "添加模型", exact: true });
      await dialog.getByLabel("模型 ID", { exact: true }).fill("private-alias");
      await dialog
        .getByRole("button", { name: "添加模型", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".provider-model")).toHaveCount(3);
      const repo = await call("repositories_add", {
        name: "Provider browser fixture",
      });
      const work = await call("works_create", {
        repo: repo.id,
        title: "History",
      });
      let nativeBusy = true;
      tasks.connections.nativeActivity = async id => id === provider.id && nativeBusy;
      await page
        .getByRole("button", { name: "删除提供商", exact: true })
        .click();
      await page.evaluate(
        (id) =>
          localStorage.setItem(
            "frame.ai-preferences.v1",
            JSON.stringify({
              defaultSelection: { connection: id, model: "model-fast" },
              favorites: [
                JSON.stringify([id, "model-fast"]),
                JSON.stringify(["other-provider", "keep"]),
              ],
            }),
          ),
        provider.id,
      );
      dialog = page.getByRole("dialog", { name: "删除提供商", exact: true });
      await expect(dialog).toContainText("Paseo");
      await dialog
        .getByLabel("输入提供商名称以确认", { exact: true })
        .fill("团队创作 API");
      await expect(
        dialog.getByRole("button", { name: "永久删除提供商", exact: true }),
      ).toBeDisabled();
      nativeBusy = false;
      await dialog.getByRole("button", { name: "重新检查使用情况", exact: true }).click();
      await expect(
        dialog.getByRole("button", { name: "永久删除提供商", exact: true }),
      ).toBeEnabled();
      await dialog
        .getByLabel("输入提供商名称以确认", { exact: true })
        .fill("wrong");
      await expect(
        dialog.getByRole("button", { name: "永久删除提供商", exact: true }),
      ).toBeDisabled();
      await dialog
        .getByLabel("输入提供商名称以确认", { exact: true })
        .fill("团队创作 API");
      await page.screenshot({
        path: path.join(report, "delete-confirmation.png"),
      });
      await dialog
        .getByRole("button", { name: "永久删除提供商", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "连接第一个提供商", exact: true }),
      ).toBeVisible();
      assert.equal((await call("works_open", { id: work.id })).id, work.id);
      assert.equal((await call("connections_list")).length, 0);
      const preferences = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("frame.ai-preferences.v1")),
      );
      assert.deepEqual(
        preferences,
        {
          defaultSelection: { connection: provider.id, model: "model-fast" },
          favorites: [
            JSON.stringify([provider.id, "model-fast"]),
            JSON.stringify(["other-provider", "keep"]),
          ],
        },
        "Provider deletion keeps unrelated browser preferences",
      );
      assert.equal(
        requests.length,
        4,
        "initial discovery, refresh, failed request and retry only",
      );
      assert(
        requests.every(
          (request) =>
            request.method === "GET" &&
            request.authorization === "Bearer test-key-must-stay-server-side",
        ),
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      await page
        ?.screenshot({ path: path.join(report, "failure.png"), fullPage: true })
        .catch(() => {});
      throw error;
    } finally {
      await browser?.close();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
