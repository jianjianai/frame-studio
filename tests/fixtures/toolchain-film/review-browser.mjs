import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { launchBrowser } from "../../../scripts/browser.mjs";
import { projectPath } from "../../../scripts/project-paths.mjs";

const project = process.argv[2],
  url = process.env.FRAME_PREVIEW_URL;
if (!url)
  throw new Error(
    "Set FRAME_PREVIEW_URL to this work's temporary works_browser URL; never commit it.",
  );
const root = process.cwd(),
  folder = projectPath(root, project);
if (!fs.existsSync(path.join(folder, "project.ts")))
  throw new Error("Create the local fixture project before reviewing it.");
const output = projectPath(root, project, "exports/toolchain-browser");
fs.mkdirSync(output, { recursive: true });
const browser = await launchBrowser(),
  errors = [],
  responses = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400)
      responses.push({
        status: response.status(),
        path: new URL(response.url()).pathname.replace(
          /\/preview\/[^/]+/,
          "/preview/[redacted]",
        ),
      });
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.FRAME_AI));
  const info = await page.evaluate(() => window.FRAME_AI.ready());
  assert.equal(info.id, project);
  assert.equal(info.duration, 24);
  assert(info.tracks.length >= 2);
  const help = await page.evaluate(() => window.FRAME_AI.help());
  assert(help.export);
  assert(help.frame);
  assert(help.play);
  const frames = [];
  for (const time of [1, 7, 13, 20, 23]) {
    const frame = await page.evaluate(
      (time) => window.FRAME_AI.frame({ time, width: 640, subtitles: true }),
      time,
    );
    const bytes = Buffer.from(frame.dataURL.split(",")[1], "base64");
    fs.writeFileSync(path.join(output, `frame-${time}.png`), bytes);
    frames.push({
      time,
      width: frame.width,
      height: frame.height,
      sha256: hash(bytes),
    });
  }
  await page.evaluate(() => window.FRAME_AI.seek(21));
  const backwards = await page.evaluate(() =>
    window.FRAME_AI.frame({ time: 13, width: 640, subtitles: true }),
  );
  assert.equal(
    hash(Buffer.from(backwards.dataURL.split(",")[1], "base64")),
    frames.find((frame) => frame.time === 13).sha256,
    "cold and reverse seeks produce identical frames",
  );
  await page.mouse.click(24, 24);
  await page.evaluate(() =>
    window.FRAME_AI.play({ start: 2, end: 4, rate: 2, loop: false }),
  );
  await page.waitForTimeout(420);
  const playing = await page.evaluate(() => window.FRAME_AI.state());
  assert(playing.time > 2.25 && playing.time < 4.1, JSON.stringify(playing));
  await page.evaluate(() => window.FRAME_AI.pause());
  const paused = await page.evaluate(() => window.FRAME_AI.state());
  await page.waitForTimeout(200);
  const stopped = await page.evaluate(() => window.FRAME_AI.state());
  assert.equal(stopped.playing, false);
  assert(Math.abs(stopped.time - paused.time) < 0.025);
  await page.evaluate(() =>
    window.FRAME_AI.setTrack("pulse", { muted: true, gain: 0.6 }),
  );
  await page.evaluate(() =>
    window.FRAME_AI.setTrack("pulse", { muted: false, gain: 0.8 }),
  );
  const invalidTrack = await page.evaluate(() => {
    try {
      window.FRAME_AI.setTrack("missing", { muted: true });
      return false;
    } catch {
      return true;
    }
  });
  assert(invalidTrack);
  const { id } = await page.evaluate(() =>
    window.FRAME_AI.exportVideo({
      start: 12,
      end: 14,
      width: 640,
      fps: 30,
      subtitles: true,
    }),
  );
  await page.waitForFunction(
    (id) => window.FRAME_AI.exportStatus(id).state !== "running",
    id,
    { timeout: 120000 },
  );
  const exported = await page.evaluate(
    (id) => window.FRAME_AI.exportStatus(id),
    id,
  );
  assert.equal(exported.state, "succeeded", JSON.stringify(exported));
  assert(exported.bytes > 10000);
  const pending = page.waitForEvent("download");
  await page.evaluate((id) => window.FRAME_AI.download(id), id);
  const download = await pending;
  await download.saveAs(path.join(output, "browser-clip.webm"));
  const subtitles = await page.evaluate(() => window.FRAME_AI.subtitles());
  assert.match(subtitles, /00:00:18,000/);
  fs.writeFileSync(path.join(output, "captions.srt"), subtitles);
  await page.evaluate((id) => window.FRAME_AI.release(id), id);
  const cancel = await page.evaluate(() => {
    const job = window.FRAME_AI.exportVideo({ width: 1280, start: 0, end: 24 });
    window.FRAME_AI.cancelExport(job.id);
    return job.id;
  });
  await page.waitForFunction(
    (id) => window.FRAME_AI.exportStatus(id).state !== "running",
    cancel,
    { timeout: 30000 },
  );
  assert.equal(
    (await page.evaluate((id) => window.FRAME_AI.exportStatus(id), cancel))
      .state,
    "cancelled",
  );
  await page.evaluate((id) => window.FRAME_AI.release(id), cancel);
  assert.deepEqual(
    (await page.evaluate(() => window.FRAME_AI.state())).exports,
    [],
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(responses, []);
  const report = {
    schemaVersion: 1,
    passed: true,
    project,
    duration: info.duration,
    tracks: info.tracks.map((track) => ({ id: track.id, kind: track.kind })),
    frames,
    checks: {
      ready: true,
      help: true,
      deterministicReverseSeek: true,
      playAt2x: true,
      pauseStable: true,
      trackControls: true,
      invalidTrackRejected: true,
      browserWebmExport: true,
      subtitles: true,
      exportCancellation: true,
      objectUrlRelease: true,
    },
    browserExport: {
      bytes: exported.bytes,
      mime: exported.mime,
      path: "browser-clip.webm",
    },
    pageErrors: errors,
    failedResponses: responses,
    listening: "not_confirmed_by_human",
    visualReview: "inspect_saved_frames_separately",
  };
  fs.writeFileSync(
    path.join(output, "review.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
