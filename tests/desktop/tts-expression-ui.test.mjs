import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { createApp } from "../../server/app.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";

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
