import assert from "node:assert/strict";
import { expect } from "@playwright/test";
export async function layoutChecks(h) {
  const { check, state, context, player, frame, screenshot } = h;
  await check("作品卡片显示状态并在独立无导航标签打开", async () => {
    let page = h.page;
    await expect(
      page.locator(".work-card-status .production-review"),
    ).toBeVisible();
    const opened = context.waitForEvent("page");
    await page
      .getByRole("link", { name: /前端交互验收.*（在新标签页打开）/ })
      .click();
    const library = page;
    page = h.page = await opened;
    await page.waitForLoadState("domcontentloaded");
    await expect(player().getByRole("heading", { level: 1 })).toHaveText(
      state.work.title,
    );
    assert.equal(await page.locator(".navigation").count(), 0);
    await expect(page.locator('iframe[title^="Paseo ·"]')).toBeVisible();
    assert(!library.url().includes("#/work/"));
    await player().getByTestId("play-toggle").waitFor();
    await frame().waitForFunction(() => window.__FRAME_STUDIO__?.ready);
    await screenshot("01-workspace-desktop");
  });
  const page = h.page;
  await check(
    "AI显隐保留完整原生界面实例和后台任务，无上下布局切换",
    async () => {
      const native = page.locator('iframe[title^="Paseo ·"]');
      await native.evaluate((el) => {
        el.dataset.retained = "same-instance";
      });
      await page
        .locator(".creation-actions")
        .getByRole("button", { name: "关闭 AI 对话", exact: true })
        .click();
      await expect(page.locator("#work-dock")).toBeHidden();
      await page
        .getByRole("button", { name: "打开 AI 对话", exact: true })
        .click();
      await expect(native).toHaveAttribute("data-retained", "same-instance");
      assert.equal(
        state.calls.filter((c) => c.name === "task_cancel").length,
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: "切换左右或上下布局" }).count(),
        0,
      );
    },
  );
  await check("细分割线鼠标与键盘调整AI宽度", async () => {
    const handle = page.getByRole("separator", {
        name: "调整播放器和工作面板大小",
      }),
      box = await handle.boundingBox();
    assert.equal(box.width, 1);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(160);
    assert.equal(
      await handle.evaluate((el) => getComputedStyle(el, "::after").opacity),
      "0",
    );
    const before = await page.locator(".preview-pane").boundingBox();
    await page.mouse.move(box.x, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x - 100, box.y + 100, { steps: 8 });
    await page.mouse.up();
    assert(
      (await page.locator(".preview-pane").boundingBox()).width <
        before.width - 60,
    );
    await handle.press("ArrowRight");
  });
  await check("独立视频进度条、时间轴显隐与拖拽高度、画质切换", async () => {
    const p = player(),
      handle = p.getByRole("separator", { name: "调整视频与时间轴高度" }),
      box = await handle.boundingBox();
    assert.equal(box.height, 1);
    const before = await p.locator(".theater").boundingBox();
    await page.mouse.move(box.x + 100, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y - 90, { steps: 8 });
    await page.mouse.up();
    assert(
      (await p.locator(".theater").boundingBox()).height < before.height - 60,
    );
    await p.getByRole("button", { name: "隐藏时间轴", exact: true }).click();
    await expect(p.locator("#work-timeline")).toBeHidden();
    const progress = p.getByRole("slider", {
      name: "视频播放进度",
      exact: true,
    });
    await expect(progress).toBeVisible();
    const b = await progress.boundingBox();
    await page.mouse.move(b.x + b.width * 0.25, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.75, b.y + b.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    assert(
      (await frame().evaluate(() => window.__FRAME_STUDIO__.getState().time)) >
        1.2,
    );
    await p.getByRole("button", { name: "显示时间轴", exact: true }).click();
    await p
      .getByLabel("预览画质", { exact: true })
      .first()
      .selectOption("draft");
    await frame().waitForFunction(
      () =>
        document.querySelector("canvas").width === 640 &&
        window.__FRAME_STUDIO__?.ready,
    );
    await p.locator(".timeline-options summary").click();
    const locate = p.getByLabel("定位帧", { exact: true });
    await locate.fill("6");
    await locate.press("Enter");
    await p.getByRole("button", { name: "设为入点" }).click();
    await locate.fill("18");
    await locate.press("Enter");
    await p.getByRole("button", { name: "设为出点" }).click();
    await p
      .getByRole("slider", { name: "时间轴可视终点", exact: true })
      .press("Home");
    assert(
      await p
        .locator(".timeline-scroll")
        .evaluate((el) => el.scrollWidth > el.clientWidth * 3),
    );
    await p
      .getByRole("slider", { name: "时间轴可视范围", exact: true })
      .press("0");
  });
  await check("Frame选段上下文绑定实际预览，旧聊天入口已移除", async () => {
    const native = page.frames().find((f) => f.url().includes("/paseo/"));
    await native.waitForFunction(() => window.__FRAME_REVIEW_PASEO__?.ready);
    const reference = await native.evaluate(() =>
      window.__FRAME_REVIEW_PASEO__.context(),
    );
    assert.equal(reference.start, 0.5);
    assert.equal(reference.end, 1.5);
    await expect(
      page.getByRole("button", { name: "旧版记录", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "旧版创作记录" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "在新标签页打开 Paseo", exact: true }),
    ).toBeVisible();
  });
}
export async function responsiveChecks(h) {
  const { page, player, check, screenshot } = h;
  await check("1440/1280/1024/768/390/320宽度及窄屏对话", async () => {
    for (const width of [1440, 1280, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const close = page
        .locator("#work-dock")
        .getByRole("button", { name: "关闭 AI 对话", exact: true });
      if (await close.count()) await close.click();
      await expect(
        player().getByRole("slider", { name: "视频播放进度", exact: true }),
      ).toBeVisible();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await expect(
        page.locator(".work-menu-trigger .work-tool-label"),
      ).toBeVisible();
      const stage = await player().getByTestId("stage-canvas").boundingBox();
      assert(stage.height > 120, "Useful video height");
      if (width <= 768) {
        await page
          .getByRole("button", { name: "打开 AI 对话", exact: true })
          .click();
        const r = await page.locator('iframe[title^="Paseo ·"]').boundingBox();
        assert(r.y + r.height <= 844);
        await screenshot("05-chat-" + width);
        await page.locator("#work-dock").focus();
        await page.keyboard.press("Escape");
        await expect(page.locator("#work-dock")).toBeHidden();
      }
      await screenshot("06-player-" + width);
    }
  });
}
