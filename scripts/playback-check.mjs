import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import { projectConfig } from "./project-execution.mjs";
import { launchBrowser } from "./browser.mjs";
import { inputManifest } from "./production-input.mjs";
import { projectPath } from "./project-paths.mjs";
import { readProject } from "./project-metadata.mjs";
export async function checkPlayback(
  root,
  id,
  { start = 0, duration = 2 } = {},
) {
  const { meta } = readProject(projectPath(root, id, "project.ts"));
  if (
    !Number.isFinite(start) ||
    start < 0 ||
    start >= meta.duration ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 3600
  )
    throw new Error("Invalid playback range");
  const input = inputManifest(root, id),
    errors = [],
    checks = [];
  let browser, server;
  const report = {
    schemaVersion: 1,
    project: id,
    input,
    status: "failed",
    checks,
    errors,
    contentReview: { visual: "not_run", listening: "not_run" },
  };
  try {
    server = await createServer(projectConfig(root, id));
    await server.listen();
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      "http://127.0.0.1:" +
        server.httpServer.address().port +
        "/?debug=1#/film/" +
        id,
    );
    await page.waitForFunction(
      () => window.__FRAME_STUDIO__?.ready,
      {},
      { timeout: 60000 },
    );
    const capture = await page.evaluate(
      async (start) =>
        window.__FRAME_STUDIO__.captureAt(start, { audio: true }),
      start,
    );
    checks.push({
      name: "cold-seek-ready",
      status: "passed",
      time: capture.time,
    });
    await page.mouse.click(2, 2);
    await page.evaluate(() => window.__FRAME_STUDIO__.play());
    const until = Math.min(meta.duration, start + duration);
    await page.waitForFunction(
      (until) => window.__FRAME_STUDIO__.getState().time >= until - 0.025,
      until,
      { timeout: Math.ceil(duration * 1000) + 60000 },
    );
    const state = await page.evaluate(() => {
      const api = window.__FRAME_STUDIO__;
      api.pause();
      return api.getState();
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const paused = await page.evaluate(() =>
      window.__FRAME_STUDIO__.getState(),
    );
    if (Math.abs(paused.time - state.time) > 0.002)
      throw new Error("Paused clock advanced");
    checks.push({
      name: "play-pause",
      status: "passed",
      from: start,
      through: state.time,
      audioState: state.audioState,
    });
    const second = Math.min(
      Math.max(0, state.time - 0.25),
      Math.max(0, meta.duration - 0.5),
    );
    const control = await page.evaluate(async (time) => {
      const api = window.__FRAME_STUDIO__;
      api.setRate(2);
      await api.captureAt(time, { audio: true });
      await api.play();
      return api.getState();
    }, second);
    await page.waitForFunction(
      (time) => window.__FRAME_STUDIO__.getState().time > time + 0.1,
      second,
      { timeout: 60000 },
    );
    if (control.rate !== 2) throw new Error("Rate change failed");
    const diagnostics = await page.evaluate(() => {
      const api = window.__FRAME_STUDIO__;
      api.pause();
      return api.getDiagnostics();
    });
    checks.push({
      name: "reverse-seek-and-rate",
      status: "passed",
      diagnostics,
    });
    if (errors.length || diagnostics.errors?.length)
      throw new Error("Browser/runtime errors were recorded");
    if (inputManifest(root, id).fingerprint !== input.fingerprint)
      throw new Error("Inputs changed during playback validation");
    report.status = "passed";
  } catch (error) {
    errors.push(error.message);
  } finally {
    await browser?.close();
    await server?.close();
  }
  const file = projectPath(
    root,
    id,
    "exports/playback-" + randomUUID() + ".json",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return { ...report, report: file };
}
