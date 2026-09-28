import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { expectSameFrame } from "../helpers/frame-match";
import type { StudioApi } from "../../src/engine/debug";
const state = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.__FRAME_STUDIO__!.getState());
async function ready(page: import("@playwright/test").Page, id: string) {
  await page.goto("/?debug=1#/film/" + id);
  await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
  await expect(page.getByRole("alert")).toHaveCount(0);
}
async function frame(page: import("@playwright/test").Page, time: number) {
  return page.evaluate((t) => {
    const api = window.__FRAME_STUDIO__ as StudioApi;
    api.frame(t, false);
    return api.dataURL();
  }, time);
}
test("standalone player has no nested workbench navigation", async ({
  page,
}) => {
  await ready(page, "tiny-seed");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator("canvas")).toBeVisible();
});
for (const id of ["paper-wings", "sunny-rail", "tiny-seed"])
  test(
    id + ": play, pause, UI seek, reverse determinism and frame stepping",
    async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await ready(page, id);
      const a = await frame(page, 10);
      const b = await frame(page, 23);
      const a2 = await frame(page, 10);
      expect(a.length).toBeGreaterThan(5000);
      expect(a).not.toBe(b);
      await expectSameFrame(a2, a);
      await page.evaluate(() => window.__FRAME_STUDIO__!.seek(0));
      await page.getByTestId("play-toggle").click();
      await page.waitForFunction(
        () => window.__FRAME_STUDIO__!.getState().time > 0.6,
      );
      expect((await state(page)).audioState).toBe("running");
      await page.getByTestId("play-toggle").click();
      const paused = (await state(page)).time;
      await page.waitForTimeout(220);
      expect((await state(page)).time).toBe(paused);
      const pausedImage = await page.evaluate(() =>
        window.__FRAME_STUDIO__!.dataURL(),
      );
      await page.waitForTimeout(180);
      expect(
        await page.evaluate(() => window.__FRAME_STUDIO__!.dataURL()),
      ).toBe(pausedImage);
      const slider = await page.getByTestId("timeline").boundingBox();
      await page.mouse.click(
        slider!.x + slider!.width * 0.6,
        slider!.y + slider!.height / 2,
      );
      const seeked = (await state(page)).time;
      expect(seeked).toBeGreaterThan(15);
      expect(seeked).toBeLessThan(25);
      await page.getByRole("button", { name: "下一帧", exact: true }).click();
      expect((await state(page)).time - seeked).toBeCloseTo(1 / 30, 5);
      await page.getByRole("button", { name: "上一帧", exact: true }).click();
      expect((await state(page)).time).toBeCloseTo(seeked, 5);
      await page.getByRole("button", { name: "中文字幕", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "中文字幕", exact: true }),
      ).toHaveAttribute("aria-pressed", "false");
      await page
        .getByRole("combobox", { name: "播放速度" })
        .selectOption("1.5");
      expect((await state(page)).rate).toBe(1.5);
      await page.getByRole("button", { name: "循环播放", exact: true }).click();
      expect((await state(page)).loop).toBe(true);
      await page.evaluate(() =>
        window.__FRAME_STUDIO__!.seek(window.__FRAME_STUDIO__!.duration - 0.1),
      );
      await page.getByTestId("play-toggle").click();
      await page.waitForFunction(
        () => {
          const current = window.__FRAME_STUDIO__!.getState();
          return (
            current.playing &&
            current.audioState === "running" &&
            current.time < 2
          );
        },
        undefined,
        { timeout: 30000 },
      );
      expect((await state(page)).time).toBeLessThan(2);
      // Stop through the console immediately. A UI click may wait several seconds
      // for software WebGL on CI; quality changes must preserve the actual pause point.
      const beforeQuality = await page.evaluate(() => {
        window.__FRAME_STUDIO__!.pause();
        return window.__FRAME_STUDIO__!.getState().time;
      });
      await page
        .getByRole("combobox", { name: "预览画质" })
        .selectOption("draft");
      await page.waitForFunction(
        () =>
          window.__FRAME_STUDIO__?.ready &&
          window.__FRAME_STUDIO__.getState().width === 640,
      );
      expect((await state(page)).time).toBeCloseTo(beforeQuality, 5);
      await page.screenshot({
        path: "test-results/" + id + "-player.png",
        fullPage: true,
      });
      expect(errors).toEqual([]);
    },
  );
test("PNG and SRT downloads contain the actual current frame and captions", async ({
  page,
}) => {
  await ready(page, "tiny-seed");
  await page.evaluate(() => window.__FRAME_STUDIO__!.seek(25));
  await page.getByRole("button", { name: "导出作品" }).click();
  const [png] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /当前帧 · PNG/ }).click(),
  ]);
  expect(png.suggestedFilename()).toMatch(/tiny-seed-frame-750\.png/);
  const [srt] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /中文字幕 · SRT/ }).click(),
  ]);
  expect(srt.suggestedFilename()).toBe("tiny-seed.srt");
  const file = await srt.path();
  expect(await fs.readFile(file!, "utf8")).toContain(
    "00:00:01,000 --> 00:00:05,000",
  );
  await expect(page.getByText("正式输出 · 逐帧 MP4")).toBeVisible();
});
test("switching between different rendering engines cleans up safely", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "sunny-rail");
  for (const id of ["paper-wings", "tiny-seed", "sunny-rail", "tiny-seed"]) {
    await ready(page, id);
    await page.waitForFunction(
      (id) =>
        window.__FRAME_STUDIO__?.ready &&
        window.__FRAME_STUDIO__.projectId === id,
      id,
    );
    await frame(page, 17);
  }
  expect(errors).toEqual([]);
});
test("standalone player fits a narrow phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page, "tiny-seed");
  await page.evaluate(() => window.__FRAME_STUDIO__!.seek(25));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/mobile-player.png",
    fullPage: true,
  });
});
