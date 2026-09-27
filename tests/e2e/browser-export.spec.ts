import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "../../src/engine/debug";

test("complete 32-second browser WebM includes a downloadable recording", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto("/?debug=1#/film/paper-wings");
  await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
  await page.getByRole("combobox", { name: "预览画质" }).selectOption("draft");
  await page.waitForFunction(
    () =>
      window.__FRAME_STUDIO__?.ready &&
      window.__FRAME_STUDIO__.getState().width === 640,
  );
  await page.getByRole("button", { name: "导出作品" }).click();
  const download = page.waitForEvent("download", { timeout: 65000 });
  await page.getByRole("button", { name: /浏览器录制 · WebM/ }).click();
  await expect(page.getByText(/正在实时录制/)).toBeVisible();
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
  await expect(page.getByText(/正在实时录制/)).toHaveCount(0);
});
