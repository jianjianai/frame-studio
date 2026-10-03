import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
export async function flowChecks(h) {
  const { page, state, check, more, closeModal, screenshot, reportDir } = h;
  await check("弹窗错误在最上层可读，失败输入保留且关闭需确认", async () => {
    await more("作品资料");
    const dialog = page.getByRole("dialog", { name: "作品资料", exact: true });
    await dialog.getByLabel("简介", { exact: true }).fill("未保存的修改");
    state.failSave = true;
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog.locator(".toast.error")).toBeVisible();
    assert(
      await dialog.locator(".toast.error").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
        );
      }),
    );
    await expect(dialog.getByLabel("简介", { exact: true })).toHaveValue(
      "未保存的修改",
    );
    await screenshot("02-modal-error");
    await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await expect(
      dialog.getByText("有尚未保存的修改", { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(dialog.getByLabel("简介", { exact: true })).toHaveValue(
      "未保存的修改",
    );
    state.failSave = false;
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog.getByText("尚未保存", { exact: true })).toHaveCount(0);
    await closeModal();
    await expect(dialog).toHaveCount(0);
  });
  await check("素材引用不复制，资源加入与回收站分离", async () => {
    await more("素材");
    const dialog = page.getByRole("complementary", {
      name: "素材",
      exact: true,
    });
    await expect(
      dialog.getByText("已加入的旁白.wav", { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "仓库素材库", exact: true })
      .click();
    const card = dialog.locator(".material-card").filter({
      has: page.getByRole("heading", { name: "节奏参考.wav", exact: true }),
    });
    const before = state.calls.filter(
      (c) => c.name === "works_use_asset",
    ).length;
    await card.getByRole("button", { name: "引用到对话", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "已引用", exact: true }),
    ).toBeDisabled();
    assert.equal(
      state.calls.filter((c) => c.name === "works_use_asset").length,
      before,
    );
    await card
      .getByRole("button", { name: "加入本作品资源", exact: true })
      .click();
    await expect(card.getByText(/已加入本作品/)).toBeVisible();
    await dialog.getByRole("button", { name: "回收站", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "上传素材", exact: true }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: /返回对话/ }).click();
    await expect(
      page.getByRole("button", {
        name: "移除素材引用 节奏参考.wav",
        exact: true,
      }),
    ).toBeVisible();
  });
  await check("先试听再采用原音频，编排要求只带入Paseo输入框", async () => {
    await more("配音");
    const dialog = page.getByRole("complementary", {
      name: "配音",
      exact: true,
    });
    await dialog.getByLabel("配音文字", { exact: true }).fill("请听这段旁白");
    await expect(
      dialog.getByRole("button", {
        name: "生成试听（不加入作品）",
        exact: true,
      }),
    )
      .toBeEnabled()
      .catch(async (error) => {
        console.error(
          "Voice fixture diagnostic:",
          await dialog.evaluate((element) => ({
            text: element.querySelector('textarea[name="text"]')?.value,
            voice: element.querySelector('[name="voice"]')?.value,
            engine:
              element.querySelector('[name="engine"]')?.selectedOptions[0]
                ?.textContent,
            pending: element
              .querySelector("form")
              ?.getAttribute("data-pending"),
            unavailable: element.textContent.includes("此模型尚未安装"),
          })),
        );
        throw error;
      });
    await dialog
      .getByRole("button", { name: "生成试听（不加入作品）", exact: true })
      .click();
    await expect(dialog.locator("audio")).toBeVisible();
    const before = state.calls.filter((c) => c.name === "speech_test").length;
    await dialog
      .getByRole("button", {
        name: "采用这份试听，保存为作品资源",
        exact: true,
      })
      .click();
    await expect(dialog.locator(".voice-adopted")).toBeVisible();
    assert.equal(
      state.calls.filter((c) => c.name === "speech_test").length,
      before,
    );
    await dialog.getByLabel("配音编排位置").selectOption("range");
    await dialog
      .getByRole("button", { name: "带入 AI 对话，填写编排要求", exact: true })
      .click();
    const native = page.frames().find((f) => f.url().includes("/paseo/"));
    await native.waitForFunction(() =>
      window.__FRAME_REVIEW_PASEO__?.attachments.some((item) =>
        item.text.includes("配音资源"),
      ),
    );
    assert.equal(
      state.calls.filter((c) => c.name.startsWith("works_chat_")).length,
      0,
      "Voice adoption only attaches context, without obsolete chat writes",
    );
  });
  await check("版本先比较预览，不触发恢复", async () => {
    await more("版本");
    const dialog = page.getByRole("complementary", {
      name: "源代码管理",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: /预览与比较/ })
      .first()
      .click();
    await page
      .getByRole("button", { name: "生成所选版本预览", exact: true })
      .click();
    await expect(
      page.locator('iframe[title="历史版本比较播放器"]'),
    ).toBeVisible();
    const history = page.locator('iframe[title="历史版本比较播放器"]');
    assert((await history.getAttribute("src")).includes("fixtureSnapshot="));
    assert(!(await history.getAttribute("src")).includes("fixtureLive="));
    assert(
      state.snapshotRequests.length > 0,
      "Historical comparison opens an immutable task snapshot",
    );
    await expect
      .poll(() =>
        page.frames().some((f) => f.url().includes("fixtureSnapshot=")),
      )
      .toBe(true);
    const snapshotFrame = page
      .frames()
      .find((f) => f.url().includes("fixtureSnapshot="));
    await snapshotFrame.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
    await snapshotFrame.evaluate(() =>
      parent.postMessage(
        {
          type: "frame-live-preview",
          state: "error",
          error: "A history player cannot replace the active live state",
        },
        "*",
      ),
    );
    await expect(h.player().locator(".work-preview-status")).toHaveText(
      "实时预览",
    );
    assert.equal(
      state.calls.filter((c) => c.name === "works_restore").length,
      0,
    );
    await screenshot("03-version-comparison");
    await closeModal(); // Comparison closes back into the persistent source-control panel.
    await page
      .getByRole("button", { name: "关闭源代码管理", exact: true })
      .click();
  });
  await check("导出状态准确、后台参数统一且停止可用", async () => {
    await page
      .locator(".creation-actions")
      .getByRole("button", { name: "导出", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "导出", exact: true });
    await expect(
      dialog.locator(".export-item").filter({ hasText: "已停止" }).first(),
    ).toBeVisible();
    await dialog.getByLabel("导出分辨率").selectOption("1280");
    await dialog.getByLabel("导出帧率").selectOption("24");
    await dialog.getByLabel("导出范围").selectOption("custom");
    await dialog.getByLabel("导出起点").fill("0.5");
    await dialog.getByLabel("导出终点").fill("1.5");
    await dialog
      .getByRole("button", { name: "开始后台导出 MP4", exact: true })
      .click();
    const call = state.calls
      .filter((c) => c.name === "works_task" && c.args.kind === "render")
      .at(-1);
    assert.deepEqual(call.args.input, {
      width: 1280,
      fps: 24,
      subtitles: true,
      start: 0.5,
      end: 1.5,
    });
    await expect(
      dialog.locator('.export-item details[aria-label="导出源码版本"]'),
    ).toContainText(state.live.sourceRevision.slice(0, 8));
    await dialog
      .locator('.export-item details[aria-label="导出源码版本"] summary')
      .click();
    await expect(
      dialog.locator('.export-item details[aria-label="导出源码版本"]'),
    ).toContainText(state.live.sourceRevision);
    await dialog.getByRole("button", { name: "停止导出", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "停止导出", exact: true }),
    ).toHaveCount(0);
  });
  await check("真实浏览器WebM编码下载及弹窗重开", async () => {
    const dialog = page.getByRole("dialog", { name: "导出", exact: true });
    await dialog.getByLabel("导出格式与位置").selectOption("webm");
    await dialog.getByLabel("导出分辨率").selectOption("640");
    await dialog.getByLabel("导出帧率").selectOption("12");
    const liveCalls = () =>
      state.calls.filter((c) => c.name === "works_live_preview").length;
    await h.frame().evaluate(() => {
      window.__FRAME_REVIEW_EXPORT_HOLD__ = true;
      window.__FRAME_REVIEW_EXPORT_WIDTH__ = 640;
    });
    const download = page.waitForEvent("download", { timeout: 120000 });
    await dialog
      .getByRole("button", { name: "开始本机导出 WebM", exact: true })
      .click();
    await h
      .frame()
      .waitForFunction(
        () =>
          window.__FRAME_REVIEW_EXPORT_WAITING__ &&
          window.__FRAME_PREVIEW_READERS__ > 0,
      );
    await expect(
      h.player().getByRole("button", { name: "重新连接", exact: true }),
    ).toBeDisabled();
    const renewals = liveCalls();
    await h.frame().evaluate(() => {
      for (let i = 0; i < 5; i++)
        parent.postMessage({ type: "frame-preview-update-request" }, "*");
    });
    await page.waitForTimeout(80);
    assert.equal(
      liveCalls(),
      renewals,
      "Export freezes the session; even trusted retries cannot reattach while encoding",
    );
    assert.equal(
      await h.frame().evaluate(() => window.__FRAME_PREVIEW_READERS__),
      1,
    );
    await h.frame().evaluate(() => window.__FRAME_REVIEW_EXPORT_CONTINUE__());
    const file = await download,
      target = path.join(reportDir, "fixture.webm");
    await file.saveAs(target);
    assert(fs.statSync(target).size > 1000);
    assert.equal(
      fs.readFileSync(target).subarray(0, 4).toString("hex"),
      "1a45dfa3",
    );
    await h
      .frame()
      .waitForFunction(() => window.__FRAME_PREVIEW_READERS__ === 0);
    await expect(
      h.player().getByRole("button", { name: "重新连接", exact: true }),
    ).toBeEnabled();
    await expect(
      dialog.getByRole("button", { name: "再次下载 WebM", exact: true }),
    ).toBeVisible();
    await screenshot("04-export-complete");
    await closeModal();
    await page
      .locator(".creation-actions")
      .getByRole("button", { name: "导出", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "再次下载 WebM", exact: true }),
    ).toBeVisible();
    await closeModal();
  });
}
export async function libraryChecks(h) {
  const { page, state, check, uiUrl } = h;
  await check("搜索无结果与错误分离，首次使用可添加仓库", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(uiUrl + "/#/recent");
    await page.getByLabel("搜索作品", { exact: true }).fill("不存在的作品");
    await expect(page.locator(".empty")).toContainText(/没有.*(匹配|符合)/);
    assert(
      !(await page.locator(".empty").innerText()).includes("还没有最近打开"),
    );
    state.failList = true;
    await page.getByLabel("搜索作品", { exact: true }).fill("错误验证");
    await expect(page.getByRole("alert")).toContainText("目录暂时不可读");
    state.failList = false;
    await page.getByLabel("搜索作品", { exact: true }).fill("");
    state.repos = [];
    await page.getByRole("button", { name: "新建作品", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "添加作品仓库", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "添加作品仓库", exact: true })
      .click();
    await page.getByRole("button", { name: "本地仓库", exact: true }).click();
    await page
      .getByRole("dialog", { name: "添加作品仓库", exact: true })
      .getByLabel("仓库名称")
      .fill("首次仓库");
    await page.getByRole("button", { name: "创建仓库", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "新建作品", exact: true })
        .getByLabel("所属仓库", { exact: true }),
    ).not.toHaveValue("");
  });
}
