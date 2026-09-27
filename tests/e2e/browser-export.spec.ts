import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {} from "../../src/engine/debug";

test("complete browser export has every planned frame and offline audio", async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.captureStream = () => {
      throw new Error("Realtime capture forbidden");
    };
  });
  await page.goto("/?debug=1#/film/paper-wings");
  await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
  await page.getByRole("combobox", { name: "预览画质" }).selectOption("draft");
  await page.waitForFunction(
    () =>
      window.__FRAME_STUDIO__?.ready &&
      window.__FRAME_STUDIO__.getState().width === 640,
  );
  await page.getByRole("button", { name: "导出作品" }).click();
  await page.screenshot({ path: test.info().outputPath("export-dialog.png") });
  await page.getByRole("combobox", { name: "导出分辨率" }).selectOption("640");
  await page.getByRole("combobox", { name: "导出帧率" }).selectOption("12");
  const download = page.waitForEvent("download", { timeout: 150000 });
  await page.getByRole("button", { name: /浏览器逐帧导出 · WebM/ }).click();
  await expect(
    page.getByText(/正在逐帧渲染|正在准备导出|正在封装视频/),
  ).toBeVisible();
  const file = await download;
  expect(file.suggestedFilename()).toBe("paper-wings.webm");
  await fs.mkdir("projects/paper-wings/exports", { recursive: true });
  await file.saveAs(
    path.resolve("projects/paper-wings/exports/verification-browser.webm"),
  );
  expect(
    (await fs.stat("projects/paper-wings/exports/verification-browser.webm"))
      .size,
  ).toBeGreaterThan(50000);
  await expect(
    page.getByText(/正在逐帧渲染|正在准备导出|正在封装视频/),
  ).toHaveCount(0);
  const probe = await promisify(execFile)(
    process.env.FFPROBE_PATH || "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      (await file.path())!,
    ],
    { windowsHide: true },
  );
  const inspected = JSON.parse(probe.stdout);
  const video = inspected.streams.find(
    (stream: { codec_type: string }) => stream.codec_type === "video",
  );
  expect(video).toMatchObject({
    width: 640,
    height: 360,
    nb_read_frames: "384",
  });
  expect(Number(inspected.format.duration)).toBeCloseTo(32, 1);
  expect(
    inspected.streams.some(
      (stream: { codec_type: string }) => stream.codec_type === "audio",
    ),
  ).toBe(true);
});
