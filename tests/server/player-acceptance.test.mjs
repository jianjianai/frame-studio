import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "vite";
import { fixture } from "../mcp/helpers.mjs";
import { projectConfig } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { command } from "../../server/process.mjs";

test("platform player fixture: deterministic seek, audio playback, export cancellation and complete offline export", { timeout: 180000 }, async () => {
  const f = fixture({ browser: true, renderer: "canvas" });
  const old = { preview: process.env.FRAME_WORK_PREVIEW, audio: process.env.FRAME_PREVIEW_AUDIO };
  process.env.FRAME_WORK_PREVIEW = "1";
  process.env.FRAME_PREVIEW_AUDIO = "0";
  let server, browser;
  try {
    const config = projectConfig(f.root, "test-film");
    server = await createServer({ ...config, server: { ...config.server, port: 0, strictPort: false } });
    await server.listen();
    browser = await launchBrowser();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      HTMLCanvasElement.prototype.captureStream = () => { throw Error("Realtime capture is forbidden in offline export"); };
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?debug=1&ai=1`);
    await page.waitForFunction(() => window.FRAME_AI && window.__FRAME_STUDIO__?.ready);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const frames = await page.evaluate(() => {
      const api = window.__FRAME_STUDIO__;
      api.frame(0.5, false); const first = api.dataURL();
      api.frame(1.5, false); api.frame(0.5, false);
      return [first, api.dataURL()];
    });
    assert.equal(frames[0], frames[1]);
    await page.getByRole("button", { name: "启用声音并播放", exact: true }).click();
    await page.waitForFunction(() => window.__FRAME_STUDIO__.getState().time > 0.7);
    await page.evaluate(() => window.FRAME_AI.pause());
    const cancelled = await page.evaluate(() => {
      const job = window.FRAME_AI.exportVideo({ width: 640, fps: 12 });
      window.FRAME_AI.cancelExport(job.id);
      return job.id;
    });
    await page.waitForFunction((id) => window.FRAME_AI.exportStatus(id).state === "cancelled", cancelled);
    const job = await page.evaluate(() => window.FRAME_AI.exportVideo({ width: 640, fps: 12 }));
    await page.waitForFunction((id) => window.FRAME_AI.exportStatus(id).state !== "running", job.id, { timeout: 120000 });
    const result = await page.evaluate((id) => window.FRAME_AI.exportStatus(id), job.id);
    assert.equal(result.state, "succeeded", JSON.stringify(result));
    const download = page.waitForEvent("download");
    await page.evaluate((id) => window.FRAME_AI.download(id), job.id);
    const file = await download;
    fs.mkdirSync(f.file("exports"), { recursive: true });
    const output = f.file("exports/platform-acceptance.webm");
    await file.saveAs(output);
    const probe = JSON.parse(await command(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", output]));
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    assert.equal(Number(video.nb_read_frames), 24);
    assert.equal(video.width, 640);
    assert(Math.abs(Number(probe.format.duration) - 2) < 0.1);
    assert(probe.streams.some((stream) => stream.codec_type === "audio"));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server?.close();
    for (const [key, value] of [["FRAME_WORK_PREVIEW", old.preview], ["FRAME_PREVIEW_AUDIO", old.audio]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    f.close();
  }
});
