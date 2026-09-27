import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { assetCatalog as readAssets } from "../../scripts/project-assets.mjs";
import { readProjectCatalog } from "../../scripts/project-metadata.mjs";
import type { StudioApi } from "../../src/engine/debug";
const projectCatalog = readProjectCatalog().map((record) => record.meta);
const projectCount = projectCatalog.length;
const assetCatalog = readAssets(process.cwd()) as {
  type: string;
}[];
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
test("library search, renderer filters, real posters and asset navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("project-card")).toHaveCount(projectCount);
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".animation-card img")].every(
      (i) =>
        (i as HTMLImageElement).complete &&
        (i as HTMLImageElement).naturalWidth > 0,
    ),
  );
  await page.getByRole("button", { name: "3D 场景", exact: true }).click();
  await expect(page.getByTestId("project-card")).toHaveCount(
    projectCatalog.filter((project) => project.renderer === "three").length,
  );
  await page.getByRole("button", { name: /全部作品/ }).click();
  await page.getByRole("textbox", { name: "搜索动画" }).fill("种子");
  await expect(page.getByTestId("project-card")).toHaveCount(
    projectCatalog.filter((project) =>
      [project.title, project.subtitle, ...project.tags]
        .join(" ")
        .includes("种子"),
    ).length,
  );
  await page.getByRole("link", { name: "素材库", exact: true }).click();
  await expect(page.locator(".asset-card")).toHaveCount(assetCatalog.length);
  await expect(page.locator("audio")).toHaveCount(
    assetCatalog.filter((a) => a.type === "audio").length,
  );
  await page.getByRole("link", { name: "制作指南", exact: true }).click();
  await expect(page.getByText("把下一个故事，放进来。")).toBeVisible();
  expect(errors).toEqual([]);
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
      expect(a2).toBe(a);
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
      await page.waitForTimeout(400);
      expect((await state(page)).time).toBeLessThan(2);
      await page.getByTestId("play-toggle").click();
      await page
        .getByRole("combobox", { name: "预览画质" })
        .selectOption("draft");
      await page.waitForFunction(
        () =>
          window.__FRAME_STUDIO__?.ready &&
          window.__FRAME_STUDIO__.getState().width === 640,
      );
      expect((await state(page)).time).toBeLessThan(2);
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
    await page.locator('.project-nav a[href="#/film/' + id + '"]').click();
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
test("responsive library and player fit a narrow phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("project-card")).toHaveCount(projectCount);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/mobile-library.png",
    fullPage: true,
  });
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
