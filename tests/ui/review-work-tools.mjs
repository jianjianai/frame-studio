import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function workToolsChecks(h) {
  const { page, player, frame, check, state, screenshot } = h;
  const rail = page.locator(".creation-toolbar");
  const dock = page.locator("#work-dock");
  const tool = (name) => rail.getByRole("button", { name, exact: true });
  const ai = async () => {
    if (await tool("打开 AI 对话").count()) await tool("打开 AI 对话").click();
  };
  await check(
    "64px分组工具条、长标题就地显示、键盘导航与菜单关闭",
    async () => {
      assert.equal((await rail.boundingBox()).width, 64);
      assert.equal(await rail.locator("h1").count(), 0);
      await expect(player().getByRole("heading", { level: 1 })).toHaveText(
        state.work.title,
      );
      for (const name of ["素材", "配音", "后台任务", "源代码管理", "导出"])
        await expect(tool(name)).toBeVisible();
      const exporting = await tool("导出").boundingBox();
      assert(
        exporting.y > 800,
        "Export is anchored to the bottom, not mixed into creative tools",
      );
      await tool("作品菜单").focus();
      await tool("作品菜单").press("End");
      await expect(tool("导出")).toBeFocused();
      await tool("导出").press("Home");
      await tool("作品菜单").press("Enter");
      await expect(
        page.getByRole("menuitem", { name: "作品资料" }),
      ).toBeFocused();
      await page.getByRole("menuitem", { name: "作品资料" }).press("ArrowDown");
      await expect(
        page.getByRole("menuitem", { name: "源代码管理" }),
      ).toBeFocused();
      await page.getByRole("menuitem", { name: "源代码管理" }).press("Escape");
      await expect(tool("作品菜单")).toBeFocused();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await tool("作品菜单").click();
      await player().getByTestId("stage-canvas").click();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await screenshot("09-rail-desktop");
    },
  );
  await check(
    "共用非阻断工作面板，草稿、配音结果、素材搜索及审片位置保留",
    async () => {
      await ai();
      const input = page.getByRole("textbox", { name: "创作要求" });
      await input.fill("切换工具后仍保留的创作要求");
      await frame().evaluate(() => window.__FRAME_STUDIO__.frame(0.75));
      const before = await frame().evaluate(() =>
        window.__FRAME_STUDIO__.getState(),
      );
      await tool("素材").click();
      await expect(dock).toHaveAttribute("role", "complementary");
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await dock
        .getByRole("button", { name: "仓库素材库", exact: true })
        .click();
      const search = dock.getByRole("textbox", { name: "搜索素材" });
      await search.fill("节奏");
      await expect(dock.locator(".material-card")).toHaveCount(1);
      await page.locator('[data-dock-pane="materials"]').evaluate((el) => {
        el.dataset.retained = "same-instance";
      });
      await tool("配音").click();
      await expect(dock.locator(".voice-adopted")).toBeVisible();
      await expect(dock.getByLabel("配音文字", { exact: true })).toHaveValue(
        "请听这段旁白",
      );
      await tool("打开 AI 对话").click();
      await expect(input).toHaveValue("切换工具后仍保留的创作要求");
      await tool("素材").click();
      await expect(search).toHaveValue("节奏");
      await expect(
        page.locator('[data-dock-pane="materials"]'),
      ).toHaveAttribute("data-retained", "same-instance");
      const after = await frame().evaluate(() =>
        window.__FRAME_STUDIO__.getState(),
      );
      assert.equal(after.time, before.time);
      assert.deepEqual(after.selection, before.selection);
      await expect(page.locator(".work-tool-pane:not([hidden])")).toHaveCount(
        1,
      );
      await screenshot("10-materials-dock");
      await search.fill("");
      await dock.getByRole("button", { name: /返回对话/ }).click();
      await expect(input).toHaveValue("切换工具后仍保留的创作要求");
    },
  );
  await check(
    "AI 输入区与工具面板衔接：素材引用、局部展开和分层 Escape",
    async () => {
      await ai();
      const input = page.getByRole("textbox", { name: "创作要求" });
      const draft = await input.inputValue();
      await page.getByRole("button", { name: "引用素材", exact: true }).click();
      await expect(dock).toHaveAttribute("aria-label", "素材");
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await dock.getByRole("button", { name: /返回对话/ }).click();
      await expect(input).toHaveValue(draft);
      const assertInsideDock = async (element) => {
        const bounds = await dock.boundingBox();
        const box = await element.boundingBox();
        assert(
          box.x >= bounds.x - 1 &&
            box.x + box.width <= bounds.x + bounds.width + 1,
        );
        assert(
          box.y >= bounds.y - 1 &&
            box.y + box.height <= bounds.y + bounds.height + 1,
        );
      };
      await page.getByRole("button", { name: "对话历史", exact: true }).click();
      await assertInsideDock(
        page.getByRole("dialog", { name: "选择创作对话" }),
      );
      await page.getByRole("textbox", { name: "搜索对话" }).press("Escape");
      await expect(dock).toBeVisible();
      await page
        .getByRole("button", { name: "展开输入框", exact: true })
        .click();
      await assertInsideDock(page.locator(".composer-expanded .chat-composer"));
      await input.press("Escape");
      await expect(page.locator(".composer-expanded")).toHaveCount(0);
      await expect(dock).toBeVisible();
      await expect(input).toHaveValue(draft);
    },
  );
  await check("任务/同步是可收起面板，点击画面不误关或中断任务", async () => {
    const cancellations = state.calls.filter(
      (c) => c.name === "task_cancel",
    ).length;
    await tool("后台任务").click();
    await expect(dock).toHaveAttribute("aria-label", "后台任务");
    await expect(
      dock.getByRole("region", { name: "本机导出任务" }),
    ).toContainText("导出完成");
    await expect(
      dock.getByRole("region", { name: "本机导出任务" }),
    ).toContainText("关闭标签页会中断");
    await player().getByTestId("stage-canvas").click();
    await expect(dock).toBeVisible();
    await tool("源代码管理").click();
    await expect(dock).toHaveAttribute("aria-label", "源代码管理");
    await expect(
      dock.getByText(state.work.branch, { exact: true }),
    ).toBeVisible();
    await dock.getByRole("button", { name: "关闭源代码管理" }).click();
    await expect(dock).toBeHidden();
    await expect(tool("源代码管理")).toBeFocused();
    assert.equal(
      state.calls.filter((c) => c.name === "task_cancel").length,
      cancellations,
    );
    await ai();
  });
  await check("大量变更可滚动浏览，选择文件立即看到差异", async () => {
    state.scmFiles = Array.from({ length: 80 }, (_, i) => ({
      path: `projects/test-film/scenes/shot-${String(i).padStart(2, "0")}.ts`,
      index: ".",
      working: "M",
      status: "M",
    }));
    await tool("源代码管理").click();
    await page.getByRole("tab", { name: /变更/ }).click();
    await state.broadcast();
    await expect(dock.locator(".scm-file-row")).toHaveCount(80);
    const files = dock.locator(".scm-file-groups");
    assert(await files.evaluate((el) => el.scrollHeight > el.clientHeight));
    await dock
      .getByRole("button", { name: "查看更改：scenes/shot-00.ts", exact: true })
      .click();
    await expect(dock.locator(".scm-diff-toolbar")).toBeInViewport();
    await expect(dock.locator(".scm-diff-table")).toContainText("const n = 2");
    await screenshot("14-scm-large-change-list");
    state.scmFiles = [];
    await state.broadcast();
    await ai();
  });
  await check(
    "画面内更新预览、拒绝其他窗口消息、真实状态与失败重试",
    async () => {
      state.previewStale = true;
      await state.broadcast();
      await expect(player().locator(".work-preview-status")).toHaveText(
        "预览待更新",
      );
      const builds = () =>
        state.calls.filter(
          (c) => c.name === "works_task" && c.args.kind === "build",
        ).length;
      const before = builds();
      await page.evaluate(() =>
        window.postMessage({ type: "frame-preview-update-request" }, "*"),
      );
      await page.waitForTimeout(80);
      assert.equal(
        builds(),
        before,
        "Only the current player's source window can request a rebuild",
      );
      await player()
        .getByRole("button", { name: "更新预览", exact: true })
        .click();
      await expect.poll(builds).toBe(before + 1);
      await expect(
        player().getByRole("button", { name: "更新预览", exact: true }),
      ).toBeDisabled();
      await expect(player().locator(".work-preview-status")).toHaveText(
        "正在更新预览",
      );
      await frame().evaluate(() => {
        for (let i = 0; i < 5; i++)
          parent.postMessage({ type: "frame-preview-update-request" }, "*");
      });
      await page.waitForTimeout(80);
      assert.equal(
        builds(),
        before + 1,
        "Repeated requests cannot enqueue concurrent builds",
      );
      for (const t of state.tasks)
        if (t.kind === "build") t.state = "succeeded";
      state.previewStale = false;
      await state.broadcast();
      await expect(player().locator(".work-preview-status")).toHaveText(
        "预览最新",
      );
      state.failBuild = true;
      await player()
        .getByRole("button", { name: "更新预览", exact: true })
        .click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "验收：预览更新失败" })
          .or(
            page.getByRole("alert").filter({ hasText: "验收：预览更新失败" }),
          ),
      ).toBeVisible();
      await expect(
        player().getByRole("button", { name: "更新预览", exact: true }),
      ).toBeEnabled();
      state.failBuild = false;
      state.previewError = true;
      await state.broadcast();
      await expect(player().locator(".work-preview-status")).toHaveText(
        "版本核对失败",
      );
      state.previewError = false;
      await state.broadcast();
      await expect(player().locator(".work-preview-status")).toHaveText(
        "预览最新",
      );
    },
  );
  await check(
    "窄屏单行工具栏、44px目标、抽屉焦点约束和关闭回到入口",
    async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("textbox", { name: "创作要求" }).press("Escape");
      assert.equal((await rail.boundingBox()).height, 52);
      await expect(
        rail.locator(".work-menu-trigger .work-tool-label"),
      ).toBeVisible();
      for (const control of await rail.locator("[data-tool-key]").all()) {
        const b = await control.boundingBox();
        assert(b.width >= 44 && b.height >= 44);
      }
      await tool("作品工具菜单").click();
      await page
        .getByRole("menuitem", { name: "素材", exact: true })
        .press("ArrowDown");
      await page
        .getByRole("menuitem", { name: "配音", exact: true })
        .press("Enter");
      await expect(dock).toHaveAttribute("role", "dialog");
      await expect(dock).toHaveAttribute("aria-modal", "true");
      await expect(rail).toHaveAttribute("inert", "");
      await expect(page.locator(".preview-pane")).toHaveAttribute("inert", "");
      const first = dock.getByRole("button", { name: "关闭配音", exact: true });
      await first.focus();
      await first.press("Shift+Tab");
      assert(await dock.evaluate((el) => el.contains(document.activeElement)));
      await page.keyboard.press("Escape");
      await expect(tool("作品工具菜单")).toBeFocused();
      await expect(dock).toBeHidden();
      await screenshot("11-rail-mobile");
      await tool("打开 AI 对话").click();
      await expect(page.getByRole("textbox", { name: "创作要求" })).toHaveValue(
        "切换工具后仍保留的创作要求",
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(dock).toHaveAttribute("role", "complementary");
      await expect(rail).not.toHaveAttribute("inert", "");
      await expect(page.locator(".work-tool-pane:not([hidden])")).toHaveCount(
        1,
      );
    },
  );
}
