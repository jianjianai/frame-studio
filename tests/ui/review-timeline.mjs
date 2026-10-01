import fs from "node:fs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";

/** Dense source-defined fixtures exercise offset clips and overflowing tracks, not production works. */
export function populateTimelineFixture(f) {
  const source = fs.readFileSync(f.file("project.ts"), "utf8");
  const begin = source.indexOf("{ ...") + 5;
  const end = source.indexOf(", load:", begin);
  const meta = JSON.parse(source.slice(begin, end));
  meta.beats = [0.25, 0.75, 1.25, 1.75].map((at, i) => ({
    at,
    title: `镜头 ${i + 1}`,
    detail: "真实时间坐标与非零起点",
  }));
  meta.subtitles = [
    { start: 0.5, end: 1, text: "第一句字幕" },
    { start: 1.25, end: 1.75, text: "第二句字幕" },
  ];
  meta.audioTracks = Array.from({ length: 10 }, (_, i) => ({
    id: i ? `layer-${i}` : "melody",
    name: i ? `声音层 ${i}` : "旋律",
    kind: "generated",
    gain: 0.03,
    start: i ? 0.25 : 0,
    duration: i ? 1.5 : 2,
    offset: i ? 0.5 : 0,
  }));
  fs.writeFileSync(
    f.file("project.ts"),
    source.slice(0, begin) + JSON.stringify(meta, null, 2) + source.slice(end),
  );
  fs.writeFileSync(
    f.file("public/waveforms.json"),
    JSON.stringify({
      melody: Array.from({ length: 180 }, (_, i) =>
        Math.abs(Math.sin(i * 0.17)),
      ),
    }),
  );
  // Hold one real export frame until the UI has exercised its frozen-preview
  // controls. This only edits the UUID fixture; no production renderer is mocked.
  const sceneSource = fs.readFileSync(f.file("scene.ts"), "utf8");
  assert(sceneSource.includes("export function createScene("));
  fs.writeFileSync(
    f.file("scene.ts"),
    sceneSource.replace(
      "export function createScene(",
      "function createFixtureScene(",
    ) +
      `
export function createScene(options: SceneOptions): Scene {
  const scene = createFixtureScene(options), prepare = scene.prepareFrame?.bind(scene);
  scene.prepareFrame = async (time, frameOptions) => {
    const scope = globalThis as typeof globalThis & {
      __FRAME_PREVIEW_READERS__?: number; __FRAME_REVIEW_EXPORT_HOLD__?: boolean;
      __FRAME_REVIEW_EXPORT_WAITING__?: boolean; __FRAME_REVIEW_EXPORT_WIDTH__?: number;
      __FRAME_REVIEW_EXPORT_CONTINUE__?: () => void;
    };
    if ((scope.__FRAME_PREVIEW_READERS__ || 0) > 0 && scope.__FRAME_REVIEW_EXPORT_HOLD__ && options.width === scope.__FRAME_REVIEW_EXPORT_WIDTH__) {
      scope.__FRAME_REVIEW_EXPORT_HOLD__ = false;
      scope.__FRAME_REVIEW_EXPORT_WAITING__ = true;
      await new Promise<void>((resolve) => { scope.__FRAME_REVIEW_EXPORT_CONTINUE__ = resolve; });
    }
    await prepare?.(time, frameOptions);
  };
  return scene;
}
`,
  );
}

export async function timelineChecks(h) {
  const { page, player, frame, check, screenshot } = h;
  const p = player();
  const area = p.locator(".timeline-scroll");
  const timeline = p.locator("#work-timeline");
  const nav = p.locator(".timeline-navigator");
  const start = p.getByRole("slider", { name: "时间轴可视起点", exact: true });
  const end = p.getByRole("slider", { name: "时间轴可视终点", exact: true });
  const pan = p.getByRole("slider", { name: "时间轴可视范围", exact: true });
  const val = async (el) => Number(await el.getAttribute("aria-valuenow"));
  const stateTime = () =>
    frame().evaluate(() => window.__FRAME_STUDIO__.getState().time);
  const drag = async (box, x, y) => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y ?? box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(80);
  };
  await check(
    "时间轴不再挤占工具行，宽屏操作栏在左，逐帧位于播放器",
    async () => {
      await p.locator(".timecode-disclosure > summary").press("Escape");
      const panel = await timeline.boundingBox(),
        ruler = await p.getByTestId("timeline").boundingBox();
      assert(Math.abs(panel.y - ruler.y) < 2);
      assert.equal(
        await timeline
          .locator(
            ".timeline-toolbar,.current-shot,.timeline-options,select,.frame-controls",
          )
          .count(),
        0,
      );
      await expect(
        p
          .locator(".theater")
          .getByRole("button", { name: "上一帧", exact: true }),
      ).toBeVisible();
      await expect(
        p
          .locator(".theater")
          .getByRole("button", { name: "下一帧", exact: true }),
      ).toBeVisible();
      const tools = await page.locator(".creation-toolbar").boundingBox();
      const preview = await page.locator(".preview-pane").boundingBox();
      assert(
        tools.width <= 100 &&
          tools.x + tools.width <= preview.x + 1 &&
          preview.y === 0,
      );
      await frame().evaluate(() => window.__FRAME_STUDIO__.frame(0.5));
      await p.getByRole("button", { name: "下一帧", exact: true }).click();
      assert(Math.abs((await stateTime()) - 7 / 12) < 0.005);
      await p.getByRole("button", { name: "上一帧", exact: true }).click();
      assert(Math.abs((await stateTime()) - 0.5) < 0.005);
    },
  );
  await check("范围拖动条两端缩放、中间平移、双击全片及左右边界", async () => {
    await pan.press("0");
    const b = await nav.boundingBox();
    await drag(await end.boundingBox(), b.x + b.width * 0.5);
    assert(Math.abs((await val(end)) - 1) < 0.06);
    const fixedEnd = await val(end);
    await drag(await start.boundingBox(), b.x + b.width * 0.2);
    assert(Math.abs((await val(start)) - 0.4) < 0.06);
    assert(Math.abs((await val(end)) - fixedEnd) < 0.002);
    const oldSpan = (await val(end)) - (await val(start));
    const pb = await pan.boundingBox();
    await drag(pb, pb.x + pb.width / 2 + b.width * 0.2);
    assert(Math.abs((await val(end)) - (await val(start)) - oldSpan) < 0.002);
    assert((await val(start)) > 0.65);
    await pan.press("End");
    assert(Math.abs((await val(end)) - 2) < 0.002);
    await pan.press("Home");
    assert(Math.abs(await val(start)) < 0.002);
    await end.press("Home");
    assert(
      (await pan.boundingBox()).width >= 16,
      "Maximum zoom leaves a draggable middle",
    );
    await nav.dblclick();
    assert(
      Math.abs(await val(start)) < 0.002 &&
        Math.abs((await val(end)) - 2) < 0.002,
    );
  });
  await check(
    "鼠标滚轮默认横滚、Shift纵滚，固定轨头/标尺/总览条不丢失",
    async () => {
      const b = await nav.boundingBox();
      await drag(await end.boundingBox(), b.x + b.width * 0.42);
      const a = await area.boundingBox();
      const beforeTop = await area.evaluate((el) => el.scrollTop);
      await page.mouse.move(a.x + a.width * 0.8, a.y + 55);
      await page.mouse.wheel(0, 210);
      await expect
        .poll(() => area.evaluate((el) => el.scrollLeft))
        .toBeGreaterThan(150);
      assert.equal(await area.evaluate((el) => el.scrollTop), beforeTop);
      const head = await p.locator(".video-label").boundingBox();
      assert(Math.abs(head.x - a.x) < 2);
      assert((await val(start)) > 0);
      const left = await area.evaluate((el) => el.scrollLeft);
      const navY = (await nav.boundingBox()).y;
      await page.keyboard.down("Shift");
      await page.mouse.wheel(0, 240);
      await page.keyboard.up("Shift");
      await expect
        .poll(() => area.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(20);
      assert(Math.abs((await area.evaluate((el) => el.scrollLeft)) - left) < 1);
      assert(
        Math.abs((await p.getByTestId("timeline").boundingBox()).y - a.y) < 2,
      );
      assert(Math.abs((await nav.boundingBox()).y - navY) < 1);
      await area.evaluate((el) => {
        el.scrollTop = 0;
      });
      await pan.press("0");
    },
  );
  await check(
    "非零镜头/音轨/字幕与播放头坐标一致，拖动选段和双击镜头",
    async () => {
      await frame().evaluate(() => window.__FRAME_STUDIO__.frame(0.5));
      const r = await p.getByTestId("timeline").boundingBox();
      const shot = await p.locator('[data-clip="shot-0"]').boundingBox();
      const audio = await p
        .locator('[data-clip="audio-layer-1"]')
        .boundingBox();
      assert(Math.abs(shot.x - (r.x + r.width * 0.125)) < 1.5);
      assert(Math.abs(shot.x - audio.x) < 1.5);
      const playhead = await p.locator(".track-playhead").boundingBox();
      assert(Math.abs(playhead.x - (r.x + r.width * 0.25)) < 1.5);
      await page.mouse.move(r.x + r.width * 0.2, r.y + 12);
      await page.keyboard.down("Shift");
      await page.mouse.down();
      await page.mouse.move(r.x + r.width * 0.65, r.y + 12, { steps: 15 });
      await page.mouse.up();
      await page.keyboard.up("Shift");
      await expect(p.getByRole("slider", { name: "调整入点" })).toBeVisible();
      await expect(p.getByRole("slider", { name: "调整出点" })).toBeVisible();
      const e = p.getByRole("slider", { name: "调整出点" });
      await drag(await e.boundingBox(), r.x + r.width * 0.85);
      assert((await val(e)) > 1.6);
      await p.locator('[data-clip="shot-1"]').dblclick();
      assert(
        Math.abs(
          (await val(p.getByRole("slider", { name: "调整入点" }))) - 0.75,
        ) < 0.002,
      );
      assert(Math.abs((await val(e)) - 1.25) < 0.002);
      assert(Math.abs((await stateTime()) - 0.75) < 0.002);
      await screenshot("07-dense-timeline");
    },
  );
  await check("多轨静音/独听保持原始设置，音量弹层不被轨道裁切", async () => {
    const mute = p.getByRole("button", { name: "旋律静音", exact: true });
    await mute.click();
    await p.getByRole("button", { name: "声音层 1独听", exact: true }).click();
    await expect
      .poll(() =>
        frame().evaluate(
          () =>
            window.__FRAME_STUDIO__.getDiagnostics().audio.tracks["layer-2"]
              .muted,
        ),
      )
      .toBe(true);
    await p.getByRole("button", { name: "声音层 1独听", exact: true }).click();
    await expect
      .poll(() =>
        frame().evaluate(
          () =>
            window.__FRAME_STUDIO__.getDiagnostics().audio.tracks["layer-2"]
              .muted,
        ),
      )
      .toBe(false);
    assert(
      await frame().evaluate(
        () =>
          window.__FRAME_STUDIO__.getDiagnostics().audio.tracks.melody.muted,
      ),
    );
    await mute.click();
    await p.getByLabel("旋律音轨控制", { exact: true }).click();
    const popup = p.locator(".timeline-popover:popover-open");
    await expect(popup).toBeVisible();
    const pop = await popup.boundingBox(),
      embed = await page.locator('iframe[title="作品播放器"]').boundingBox();
    assert(
      pop.x >= embed.x &&
        pop.y >= embed.y &&
        pop.y + pop.height <= embed.y + embed.height + 1,
    );
    await p.getByLabel("旋律音量", { exact: true }).fill("0.45");
    await expect
      .poll(() =>
        frame().evaluate(
          () =>
            window.__FRAME_STUDIO__.getDiagnostics().audio.tracks.melody.gain,
        ),
      )
      .toBe(0.45);
    await p.getByRole("button", { name: "关闭旋律音轨控制" }).click();
    await expect(popup).toHaveCount(0);
  });
  await check(
    "窄屏范围条最大缩放仍可拖拽，短屏控件不被时间轴挤出",
    async () => {
      for (const viewport of [
        { width: 320, height: 640 },
        { width: 1366, height: 768 },
      ]) {
        await page.setViewportSize(viewport);
        const close = page
          .locator("#work-dock")
          .getByRole("button", { name: "关闭 AI 对话", exact: true });
        if (await close.count()) await close.click();
        await end.press("Home");
        assert((await pan.boundingBox()).width >= 16);
        const b = await pan.boundingBox();
        await drag(b, b.x + b.width / 2 + 25);
        assert((await val(start)) > 0);
        await pan.press("0");
        await expect(
          p.getByRole("button", { name: "下一帧", exact: true }),
        ).toBeVisible();
        const b2 = await nav.boundingBox();
        assert(b2.y + b2.height <= viewport.height);
        if (viewport.width === 320) {
          const tools = await page.locator(".creation-toolbar").boundingBox();
          const preview = await page.locator(".preview-pane").boundingBox();
          assert(tools.y + tools.height <= preview.y + 1);
        }
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await screenshot(`08-timeline-${viewport.width}`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page
        .getByRole("button", { name: "打开 AI 对话", exact: true })
        .click();
      await pan.press("0");
      await area.evaluate((el) => {
        el.scrollTop = 0;
      });
    },
  );
}
