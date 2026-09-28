import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
const base = process.env.FRAME_SMOKE_URL || "http://127.0.0.1:45842";
const r = await fetch(base + "/api/login", {
  method: "POST",
  headers: { Origin: base, "Content-Type": "application/json" },
  body: JSON.stringify({ password: process.env.FRAME_SMOKE_PASSWORD }),
});
assert.equal(r.status, 200);
const cookie = r.headers.get("set-cookie").split(";")[0];
const api = async (name, args = {}) => {
  const r = await fetch(base + "/api/action", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args }),
  });
  const v = await r.json();
  assert.equal(r.status, 200, JSON.stringify(v));
  return v;
};
const work = (await api("works_list", { search: "作品平台验收" }))[0];
assert(work);
let link = await api("works_browser", { id: work.id });
while (link.state !== "ready") {
  for (let n = 0; n < 120; n++) {
    const { task } = await api("task_get", { id: link.task });
    if (!["queued", "running"].includes(task.state)) {
      assert.equal(task.state, "succeeded", JSON.stringify(task));
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  link = await api("works_browser", { id: work.id });
}
const before = (await api("works_tasks", { id: work.id })).length;
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",
  ],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1050 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(link.url);
  await page.waitForFunction(
    () => window.FRAME_AI && window.__FRAME_STUDIO__?.ready,
  );
  const info = await page.evaluate(() => FRAME_AI.ready());
  assert.equal(info.compute, "browser");
  assert.equal(await page.evaluate(() => window.origin), "null");
  const samples = await page.evaluate(async () => {
    const a = await FRAME_AI.frame({ time: 0, width: 320 }),
      b = await FRAME_AI.frame({ frame: 15, width: 320 }),
      c = await FRAME_AI.frame({ time: 0, width: 320 });
    return {
      same: a.dataURL === c.dataURL,
      different: a.dataURL !== b.dataURL,
      width: a.width,
      storyboard: (
        await FRAME_AI.storyboard({ times: [0, 0.5, 1], width: 320 })
      ).frames.length,
    };
  });
  assert.deepEqual(samples, {
    same: true,
    different: true,
    width: 320,
    storyboard: 3,
  });
  await page.getByRole("button", { name: "启用声音并播放" }).click();
  await page.evaluate(() => FRAME_AI.pause());
  await page.evaluate(() => FRAME_AI.play({ start: 0.2, end: 0.8 }));
  await page.waitForFunction(
    () => !FRAME_AI.state().playing && FRAME_AI.state().time >= 0.79,
  );
  const state = await page.evaluate(() => FRAME_AI.state());
  assert(Math.abs(state.time - 0.8) < 0.02, JSON.stringify(state));
  const download = page.waitForEvent("download");
  await page.evaluate(() =>
    FRAME_AI.frame({ time: 0.5, width: 320, download: true }),
  );
  await (await download).saveAs("/evidence/ai-frame.png");
  const job = await page.evaluate(() =>
    FRAME_AI.exportVideo({ start: 0.5, end: 1.5, width: 320, fps: 12 }),
  );
  await page.waitForFunction(
    (id) => FRAME_AI.exportStatus(id).state !== "running",
    job.id,
    { timeout: 120000 },
  );
  const result = await page.evaluate((id) => FRAME_AI.exportStatus(id), job.id);
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  const video = page.waitForEvent("download");
  await page.evaluate((id) => FRAME_AI.download(id), job.id);
  await (await video).saveAs("/evidence/ai-segment.webm");
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        "/evidence/ai-segment.webm",
      ],
      { encoding: "utf8" },
    ),
  );
  const stream = probe.streams.find((s) => s.codec_type === "video");
  assert.equal(Number(stream.nb_read_frames), 12);
  assert(probe.streams.some((s) => s.codec_type === "audio"));
  const cancelled = await page.evaluate(() => {
    const j = FRAME_AI.exportVideo({ width: 1920, fps: 60 });
    FRAME_AI.cancelExport(j.id);
    return j.id;
  });
  await page.waitForFunction(
    (id) => FRAME_AI.exportStatus(id).state === "cancelled",
    cancelled,
  );
  await page.screenshot({ path: "/evidence/ai-browser.png", fullPage: true });
  assert.equal(
    (await api("works_tasks", { id: work.id })).length,
    before,
    "client rendering must create no server render tasks",
  );
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    "/evidence/ai-browser-smoke.json",
    JSON.stringify(
      {
        work: work.id,
        task: link.task,
        info,
        samples,
        state,
        result,
        videoFrames: stream.nb_read_frames,
        noServerRenderTasks: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: private AI URL, console frames/storyboard/segment playback, PNG download, client WebM segment with audio, cancellation, no server rendering",
  );
} finally {
  await browser.close();
}
