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
      const native = page.locator('iframe[title^="T3 Code ·"]');
      await expect(native).toBeVisible();
      await native.evaluate((el) => {
        el.dataset.retained = "same-native-iframe";
      });
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
      await expect(native).toHaveAttribute(
        "data-retained",
        "same-native-iframe",
      );
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
      await expect(native).toHaveAttribute(
        "data-retained",
        "same-native-iframe",
      );
    },
  );
  await check("完整T3 Code作品面板入口：素材、独立标签页与展开恢复", async () => {
    await ai();
    const native = page.locator('iframe[title^="T3 Code ·"]');
    await expect(native).toBeVisible();
    await page.getByRole("button", { name: /^选择素材/ }).click();
    await expect(dock).toHaveAttribute("aria-label", "素材");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await dock.getByRole("button", { name: /返回对话/ }).click();
    await expect(native).toHaveAttribute("data-retained", "same-native-iframe");
    await expect(
      page.getByRole("button", { name: "旧版记录", exact: true }),
    ).toHaveCount(0);
    const popupPromise = page.waitForEvent("popup");
    await page
      .getByRole("link", { name: "在新标签页打开 T3 Code", exact: true })
      .click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(new URL(popup.url()).pathname, "/ai/");
    assert.equal(new URL(popup.url()).searchParams.get("frameStandalone"), "1");
    assert.equal(await popup.evaluate(() => window.opener), null);
    await popup.close();
    await page
      .getByRole("button", { name: "展开 AI 面板", exact: true })
      .click();
    await expect(dock).toHaveClass(/ai-expanded/);
    await expect(native).toBeVisible();
    const bounds = await dock.boundingBox(),
      box = await native.boundingBox();
    assert(
      box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width + 1,
    );
    assert(
      box.y >= bounds.y && box.y + box.height <= bounds.y + bounds.height + 1,
    );
    await page
      .getByRole("button", { name: "还原 AI 面板", exact: true })
      .click();
    await expect(dock).not.toHaveClass(/ai-expanded/);
    await expect(native).toHaveAttribute("data-retained", "same-native-iframe");
    const child = await (await native.elementHandle()).contentFrame();
    await child.evaluate(() =>
      window.__FRAME_REVIEW_AI__.request("results.open", {}),
    );
    const results = page.getByRole("region", {
      name: "作品检查",
      exact: true,
    });
    await expect(results).toContainText("当前作品尚未检查");
    await expect(results).toBeFocused();
    await expect(native).toBeVisible();
    await results
      .getByRole("button", { name: "检查当前作品", exact: true })
      .click();
    await state.broadcast();
    await expect(results).toContainText("作品检查通过");
    const revision = state.live.sourceRevision;
    state.live.sourceRevision = "e".repeat(64);
    await state.broadcast();
    await expect(results).toContainText("检查对应较早版本，当前修改尚未检查");
    state.live.sourceRevision = revision;
    await state.broadcast();
    await expect(
      results.getByRole("button", { name: "应用到作品", exact: true }),
    ).toHaveCount(0);
  });
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
    "Tone 实际混音 UI：18 种效果、湿声与移调、完整 JSON 校验及权威保存",
    async () => {
      await tool("音频").click();
      const editor = dock.getByRole("region", {
        name: "多轨音频编辑器",
        exact: true,
      });
      await expect(editor).toBeVisible();
      await editor
        .getByLabel("选择音频处理器", { exact: true })
        .selectOption("tone");
      await editor.getByRole("button", { name: "处理器", exact: true }).click();
      const effect = editor.getByRole("region", {
        name: "Tone 效果 1",
        exact: true,
      });
      const type = effect.getByLabel("Tone 效果类型 1", { exact: true });
      const wet = effect.getByLabel("Tone 湿声比例 1", { exact: true });
      await expect(type).toHaveValue("Reverb");
      assert.equal(await type.locator("option").count(), 18);
      await expect(wet).toHaveValue("0.25");
      const draft = () =>
        page.evaluate(
          (id) =>
            JSON.parse(sessionStorage.getItem("frame-audio-draft:" + id))
              .document,
          state.work.id,
        );
      const processor = async () => (await draft()).master.processors[0];
      assert.equal(
        (await processor()).effect,
        "Reverb",
        "Add creates a valid required Tone effect",
      );
      await type.selectOption("Chorus");
      await wet.fill("0.4");
      await wet.press("Tab");
      await expect.poll(async () => (await processor()).options.wet).toBe(0.4);
      const json = effect.getByLabel("Tone 参数 JSON 1", { exact: true });
      if (!(await json.isVisible()))
        await effect.getByText("完整官方参数 JSON", { exact: true }).click();
      await json.fill(
        JSON.stringify({
          wet: 0.4,
          frequency: 2.5,
          depth: 0.3,
          delayTime: 3.5,
          feedback: 0.12,
        }),
      );
      await effect
        .getByRole("button", { name: "应用 JSON 参数", exact: true })
        .click();
      await expect(effect.getByRole("alert")).toHaveCount(0);
      await wet.fill("0.55");
      await wet.press("Tab");
      await expect.poll(async () => (await processor()).options.wet).toBe(0.55);
      assert.equal(
        (await processor()).options.frequency,
        2.5,
        "Common control preserves other complete official options",
      );
      assert.equal((await processor()).options.feedback, 0.12);
      await type.selectOption("PitchShift");
      await effect.getByLabel("Tone 移调半音 1", { exact: true }).fill("7");
      await wet.fill("0.35");
      await wet.press("Tab");
      await expect.poll(async () => (await processor()).options.pitch).toBe(7);
      await expect.poll(async () => (await processor()).options.wet).toBe(0.35);
      assert.equal((await processor()).effect, "PitchShift");
      const good = structuredClone((await processor()).options);
      await json.fill('{"pitch":');
      await effect
        .getByRole("button", { name: "应用 JSON 参数", exact: true })
        .click();
      await expect(effect.getByRole("alert")).toBeVisible();
      assert.deepEqual(
        (await processor()).options,
        good,
        "Invalid JSON leaves the last valid processor options unchanged",
      );
      await effect
        .getByRole("button", { name: "恢复当前参数", exact: true })
        .click();
      await expect(json).toHaveValue(JSON.stringify(good, null, 2));
      await expect(effect.getByRole("alert")).toHaveCount(0);
      const saves = state.calls.filter(
        (c) => c.name === "works_audio_edit",
      ).length;
      await editor
        .getByRole("button", { name: "保存混音", exact: true })
        .click();
      await expect(editor.locator(".audio-status")).toHaveText("已保存");
      assert.equal(
        state.calls.filter((c) => c.name === "works_audio_edit").length,
        saves + 1,
      );
      const stored = state.audio.document.master.processors[0];
      assert.equal(stored.type, "tone");
      assert.equal(stored.effect, "PitchShift");
      assert.deepEqual(
        stored.options,
        good,
        "Saving writes the same validated options to the authoritative audio document",
      );
      await dock
        .getByRole("button", { name: "关闭音频工作台", exact: true })
        .click();
      await tool("音频").click();
      await expect(
        editor.getByLabel("Tone 效果类型 1", { exact: true }),
      ).toHaveValue("PitchShift");
      await expect(
        editor.getByLabel("Tone 移调半音 1", { exact: true }),
      ).toHaveValue("7");
      await expect(
        editor.getByLabel("Tone 湿声比例 1", { exact: true }),
      ).toHaveValue("0.35");
      await dock
        .getByRole("button", { name: "关闭音频工作台", exact: true })
        .click();
      await ai();
    },
  );
  await check(
    "导出前明确提醒未保存音频与JSON，返回保存保留输入且不自动保存",
    async () => {
      await tool("音频").click();
      const editor = page.getByRole("region", {
        name: "多轨音频编辑器",
        exact: true,
      });
      const effect = editor.getByRole("region", {
        name: "Tone 效果 1",
        exact: true,
      });
      const json = effect.getByLabel("Tone 参数 JSON 1", { exact: true });
      if (!(await json.isVisible()))
        await effect.getByText("完整官方参数 JSON", { exact: true }).click();
      const original = await json.inputValue();
      await json.fill('{"pitch":');
      const saves = state.calls.filter(
        (c) => c.name === "works_audio_edit",
      ).length;
      await tool("导出").click();
      const dialog = page.getByRole("dialog", { name: "导出", exact: true });
      await expect(
        dialog.getByRole("status", { name: "导出前未保存修改" }),
      ).toContainText("导出只包含已保存的内容");
      await dialog
        .getByRole("button", { name: "返回音频保存", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(editor).toBeVisible();
      await expect(json).toHaveValue('{"pitch":');
      assert.equal(
        state.calls.filter((c) => c.name === "works_audio_edit").length,
        saves,
      );
      await editor
        .getByRole("button", { name: "保存混音", exact: true })
        .click();
      await expect(editor.getByRole("alert").first()).toContainText(
        "有尚未应用的 JSON 参数",
      );
      assert.equal(
        state.calls.filter((c) => c.name === "works_audio_edit").length,
        saves,
      );
      await effect
        .getByRole("button", { name: "恢复当前参数", exact: true })
        .click();
      await expect(json).toHaveValue(original);
      await expect(editor.locator(".audio-status")).toHaveText("已保存");
      await tool("导出").click();
      await expect(
        page.getByRole("status", { name: "导出前未保存修改" }),
      ).toHaveCount(0);
      await page
        .getByRole("dialog", { name: "导出", exact: true })
        .getByRole("button", { name: "关闭弹窗", exact: true })
        .click();
      await dock
        .getByRole("button", { name: "关闭音频工作台", exact: true })
        .click();
      await ai();
    },
  );
  await check(
    "实时预览可信状态、源码引用更新、重复状态去重与失败重连，不入构建队列",
    async () => {
      const status = player().locator(".work-preview-status");
      const reconnect = player().getByRole("button", {
        name: "重新连接",
        exact: true,
      });
      const liveCalls = () =>
        state.calls.filter((c) => c.name === "works_live_preview").length;
      const builds = () =>
        state.calls.filter(
          (c) => c.name === "works_task" && c.args.kind === "build",
        ).length;
      const initialBuilds = builds(),
        initialLiveCalls = liveCalls(),
        originalFrame = frame();
      await expect(status).toHaveText("实时预览");
      assert(originalFrame.url().includes("fixtureLive="));
      const retries = () =>
        originalFrame.evaluate(() => window.__FRAME_REVIEW_LIVE__.retries);
      const initialRetries = await retries();
      // An actual foreign WindowProxy and the top-level window must both be ignored.
      await page.evaluate(async () => {
        window.postMessage({ type: "frame-preview-update-request" }, "*");
        const foreign = document.createElement("iframe");
        foreign.srcdoc =
          '<script>parent.postMessage({type:"frame-live-preview",state:"error",error:"foreign iframe must be ignored"},"*");parent.postMessage({type:"frame-preview-update-request"},"*");<\/script>';
        await new Promise((resolve) => {
          foreign.onload = resolve;
          document.body.append(foreign);
        });
        foreign.remove();
      });
      await page.waitForTimeout(80);
      assert.equal(
        liveCalls(),
        initialLiveCalls,
        "Foreign messages cannot renew the current session",
      );
      assert.equal(await retries(), initialRetries);
      await expect(status).toHaveText("实时预览");
      await originalFrame.evaluate(() =>
        parent.postMessage(
          { type: "frame-live-preview", state: "invalid" },
          "*",
        ),
      );
      await expect(status).toHaveText("实时预览");
      await state.sendLive(originalFrame, { state: "updating", revision: 1 });
      await expect(status).toHaveText("正在更新");
      await reconnect.click();
      await expect.poll(liveCalls).toBe(initialLiveCalls + 1);
      await expect.poll(retries).toBe(initialRetries + 1);
      const updated = {
        state: "ready",
        revision: 2,
        sourceRevision: "2".repeat(64),
      };
      await state.sendLive(originalFrame, updated);
      await expect(status).toHaveText("实时预览");
      const native = page.frames().find((f) => f.url().includes("/ai/"));
      assert(native, "T3 Code protocol boundary is mounted");
      const reference = await native.evaluate(() =>
        window.__FRAME_REVIEW_AI__.context(),
      );
      assert.equal(reference.liveSessionId, state.live.sessionId);
      assert.equal(
        reference.sourceRevision,
        updated.sourceRevision,
        "Frame bridge references the actually applied live revision",
      );
      assert.equal(reference.previewTask, undefined);
      assert.equal(reference.sourceCommit, undefined);
      const beforeDuplicates = liveCalls(),
        contexts = await originalFrame.evaluate(
          () => window.__FRAME_REVIEW_LIVE__.contexts.length,
        );
      for (let i = 0; i < 5; i++) await state.sendLive(originalFrame, updated);
      await page.waitForTimeout(80);
      assert.equal(
        frame(),
        originalFrame,
        "Duplicate applied revisions preserve the same player instance",
      );
      assert.equal(
        liveCalls(),
        beforeDuplicates,
        "Duplicate state messages do not renew the session",
      );
      assert.equal(
        await originalFrame.evaluate(
          () => window.__FRAME_REVIEW_LIVE__.contexts.length,
        ),
        contexts,
        "Identical live status does not reconfigure the player",
      );
      await state.sendLive(originalFrame, {
        state: "error",
        revision: 2,
        error: "验收：实时源语法失败，保留当前画面",
      });
      await expect(status).toHaveText("保留当前预览");
      await expect(page.locator(".live-preview-note")).toContainText(
        "实时源语法失败",
      );
      assert.equal(frame(), originalFrame);
      state.failLive = true;
      await reconnect.click();
      await expect(status).toHaveText("断线重连");
      await expect(page.locator(".live-preview-note")).toContainText(
        "实时预览连接失败",
      );
      await expect(reconnect).toBeEnabled();
      state.failLive = false;
      state.live.state = "ready";
      await reconnect.click();
      await expect(status).toHaveText("实时预览");
      await expect(page.locator(".live-preview-note")).toHaveCount(0);
      assert.equal(
        frame(),
        originalFrame,
        "Reconnect resumes the retained player",
      );
      assert.equal(
        builds(),
        initialBuilds,
        "Live revision/retry never enqueues an immutable build",
      );
    },
  );
  await check(
    "窄屏单行工具栏、44px目标、抽屉焦点约束和关闭回到入口",
    async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await dock.focus();
      await page.keyboard.press("Escape");
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
      await expect(page.locator('iframe[title^="T3 Code ·"]')).toHaveAttribute(
        "data-retained",
        "same-native-iframe",
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
