import assert from "node:assert/strict";
import { expect } from "@playwright/test";
export async function persistenceChecks(h) {
  const { page, player, frame, check } = h;
  await check("刷新后保留AI草稿、显隐状态、拖拽比例和预览画质", async () => {
    await player()
      .getByRole("button", { name: "隐藏时间轴", exact: true })
      .click();
    await player()
      .getByLabel("预览画质", { exact: true })
      .first()
      .selectOption("high");
    await frame().waitForFunction(
      () =>
        window.__FRAME_STUDIO__?.ready &&
        document.querySelector("canvas").width === 1920,
    );
    await page
      .getByRole("textbox", { name: "创作要求" })
      .fill("刷新后仍保留的审片要求");
    await page
      .locator(".creation-actions")
      .getByRole("button", { name: "关闭 AI 对话", exact: true })
      .click();
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("frame.player-view")),
    );
    assert.equal(saved.timelineVisible, false);
    assert.equal(saved.quality, "high");
    await page.reload();
    await player().getByTestId("play-toggle").waitFor();
    await frame().waitForFunction(
      () =>
        window.__FRAME_STUDIO__?.ready &&
        document.querySelector("canvas").width === 1920,
    );
    await expect(page.locator("#work-chat")).toBeHidden();
    await expect(player().locator("#work-timeline")).toBeHidden();
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("frame.player-view")).videoRatio,
      ),
      saved.videoRatio,
    );
    await page
      .getByRole("button", { name: "打开 AI 对话", exact: true })
      .click();
    await expect(page.getByRole("textbox", { name: "创作要求" })).toHaveValue(
      "刷新后仍保留的审片要求",
    );
    await player()
      .getByRole("button", { name: "显示时间轴", exact: true })
      .click();
  });
}
