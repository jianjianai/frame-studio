import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { createApp } from "../../server/app.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";

test("speech model cards download explicitly, show progress and allow removal", { timeout: 45000 }, async () => {
  const previous = { speech: process.env.FRAME_SPEECH_URL, local: process.env.FRAME_LOCAL_MODE, browser: process.env.FRAME_BROWSER };
  const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  if (process.platform === "win32" && fs.existsSync(edge)) process.env.FRAME_BROWSER = edge;
  const models = ["builtin", "melo", "piper"].map((id) => ({ id, builtin: true, ready: false, voices: [], download: { state: "missing" } }));
  let downloads = 0, timer;
  const speech = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const model = models.find((m) => req.url.includes("/" + m.id));
    if (req.url === "/models") return res.end(JSON.stringify(models));
    if (req.method === "POST") {
      downloads++;
      model.download = { state: "downloading", receivedBytes: 10, totalBytes: 100 };
      timer = setTimeout(() => { model.ready = true; model.download = { state: "installed" }; }, 1800);
    } else if (req.method === "DELETE") { model.ready = false; model.download = { state: "missing" }; }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => speech.listen(0, "127.0.0.1", resolve));
  process.env.FRAME_SPEECH_URL = `http://127.0.0.1:${speech.address().port}`;
  process.env.FRAME_LOCAL_MODE = "1";
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-model-ui-"));
  const port = Number(process.env.FRAME_TEST_PORT || 55189);
  const origin = `http://127.0.0.1:${port}`;
  let app, browser;
  try {
    const db = await sqliteDatabase(path.join(data, "db.sqlite"));
    ({ app } = await createApp({ db, data, masterKey: "77".repeat(32), origin, localMode: true, scheduler: false }));
    await app.listen({ host: "127.0.0.1", port });
    browser = await launchBrowser();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/#/settings");
    await page.getByRole("button", { name: /语音引擎/ }).click();
    const card = page.locator(".speech-card").filter({ hasText: "Piper 英文多声线" });
    await card.getByRole("button", { name: "下载模型" }).waitFor();
    assert.equal(downloads, 0);
    assert.equal(await card.getByRole("button", { name: "试听", exact: true }).isEnabled(), false);
    await card.getByRole("button", { name: "下载模型" }).click();
    await card.getByText("已安装", { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(downloads, 1);
    assert.equal(await card.getByRole("button", { name: "试听", exact: true }).isEnabled(), true);
    await card.getByRole("button", { name: "移除 Piper 英文多声线 模型" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认删除", exact: true }).click();
    await card.getByRole("button", { name: "下载模型" }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    clearTimeout(timer);
    await browser?.close();
    await app?.close();
    await new Promise((resolve) => speech.close(resolve));
    fs.rmSync(data, { recursive: true, force: true });
    for (const [key, value] of [["FRAME_SPEECH_URL", previous.speech], ["FRAME_LOCAL_MODE", previous.local], ["FRAME_BROWSER", previous.browser]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
