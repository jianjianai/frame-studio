import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { browserExecutable } from "../server/render.mjs";
import { regionPlan, sceneModule } from "../server/tools/preview-tools.mjs";
import { timingReport } from "../server/tools/work-tools.mjs";

/**
 * The film: coloured dots that pan left at 600 px/s from 1 s to 2 s with no easing, and a red
 * square that pops in at 2.5 s (design size 1920×1080).
 */
const FILM = `import type { Scene, SceneOptions } from "@frame/engine/types";
export function createScene({ width, height }: SceneOptions): Scene {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  return {
    canvas,
    render(t) {
      const shift = t < 1 ? 0 : t < 2 ? (t - 1) * 600 : 600;
      ctx.setTransform(width / 1920, 0, 0, height / 1080, 0, 0);
      ctx.fillStyle = "#203040";
      ctx.fillRect(0, 0, 1920, 1080);
      for (let i = 0; i < 500; i++) {
        ctx.fillStyle = \`hsl(\${(i * 47) % 360} 70% \${40 + (i % 5) * 10}%)\`;
        ctx.beginPath();
        ctx.arc(((i * 137.5) % 3000) - shift, (i * 61.7) % 1080, 12 + ((i * 7) % 30), 0, Math.PI * 2);
        ctx.fill();
      }
      if (t >= 2.5) {
        ctx.fillStyle = "#ff0000";
        ctx.fillRect(100, 100, 120, 120);
      }
    },
    dispose() {
      canvas.width = canvas.height = 1;
    },
  };
}
`;

/** A character sheet beside the film: green until 1 s, then blue. */
const SHEET = `import type { Scene, SceneOptions } from "@frame/engine/types";
export function createScene({ width, height }: SceneOptions): Scene {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  return {
    canvas,
    render(t) {
      ctx.fillStyle = t < 1 ? "#00ff00" : "#0000ff";
      ctx.fillRect(0, 0, width, height);
    },
    dispose() {},
  };
}
`;

const pixel = async (data, x, y) => {
  const { data: raw, info } = await sharp(Buffer.from(data, "base64")).raw().toBuffer({ resolveWithObject: true });
  const at = (Math.round(y * (info.height - 1)) * info.width + Math.round(x * (info.width - 1))) * info.channels;
  return [raw[at], raw[at + 1], raw[at + 2]];
};

describe("pictures for the AI: modules on their own, close looks, timing, motion", () => {
  let app, base, work;
  const tool = async (name, args) => {
    const response = await fetch(`${base}/api/tools/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return { status: response.status, body: await response.json() };
  };

  beforeAll(async () => {
    app = await createApp({ env: { FRAME_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "frame-preview-")), FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    work = await app.services.works.create({ title: "画面检查", duration: 4 });
    fs.writeFileSync(path.join(work.dir, "scenes", "title.ts"), FILM);
    fs.mkdirSync(path.join(work.dir, "sheets"));
    fs.writeFileSync(path.join(work.dir, "sheets", "sheet.ts"), SHEET);
  });
  afterAll(() => app.close());

  it("plans close looks in the work's pixels and finds modules inside the work only", () => {
    const project = { composition: { width: 1920, height: 1080 } };
    expect(regionPlan(project, [100, 100, 200, 200])).toMatchObject({
      width: 3840,
      crop: { x: 200, y: 200, width: 400, height: 400 },
      scale: 2,
      capped: false,
    });
    expect(regionPlan(project, [0, 0, 1920, 1080])).toMatchObject({ width: 1000, scale: 1000 / 1920 });
    expect(regionPlan(project, [0, 0, 400, 300], 3)).toMatchObject({ width: 3840, capped: true, most: 2 });
    expect(() => regionPlan(project, [1800, 0, 200, 100])).toThrow("超出了画面：作品画面是 1920×1080");
    expect(sceneModule(work, "sheets/sheet.ts")).toBe("sheets/sheet.ts");
    expect(sceneModule(work, `projects/${work.slug}/sheets/sheet.ts`)).toBe("sheets/sheet.ts");
    expect(() => sceneModule(work, "../../etc/passwd.ts")).toThrow("作品文件夹里的文件");
    expect(() => sceneModule(work, "sheets/none.ts")).toThrow("作品里没有 sheets/none.ts");
    expect(() => sceneModule(work, "AGENTS.md")).toThrow("createScene");
  });

  it("reports the slow stretches with their layers and shots", () => {
    const samples = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((time) => ({ time, ms: time >= 1.5 && time <= 2 ? 120 : 20 }));
    samples[6] = { time: 3, ms: 400, again: 25 };
    const project = {
      fps: 30,
      beats: [{ at: 1.2, title: "飞越" }],
      visual: {
        clips: [
          { id: "a", name: "第二幕", start: 1, duration: 2 },
          { id: "g", name: "颗粒", start: 0, duration: 4 },
        ],
      },
    };
    const text = timingReport({ samples, width: 1280, height: 720, step: 0.5, lastStep: 0.5, complete: true, ms: 900, loadMs: 300 }, project).join("\n");
    expect(text).toContain("中位 20 ms");
    expect(text).toContain("- 0:01.50–0:02.00 平均 120 ms，最慢 120 ms（0:01.50），图层「第二幕」「颗粒」，镜头「飞越」");
    expect(text).toContain("0:03.00 首次 400 ms → 再画 25 ms");
  });

  it.skipIf(!browserExecutable())(
    "draws a module of the work on its own and leaves the film alone",
    async () => {
      const visual = fs.readFileSync(path.join(work.dir, "visual.json"), "utf8");
      const sheet = await tool("preview_frames", { work: work.id, scene: "sheets/sheet.ts", times: [0.5, 1.5], format: "png" });
      expect(sheet.status).toBe(200);
      expect(sheet.body.text).toContain("sheets/sheet.ts（单独画，不是成片）");
      expect(await pixel(sheet.body.images[0].data, 0.5, 0.5)).toEqual([0, 255, 0]);
      expect(await pixel(sheet.body.images[1].data, 0.5, 0.5)).toEqual([0, 0, 255]);
      // Without times: the moment 0 only.
      expect((await tool("preview_frames", { work: work.id, scene: "sheets/sheet.ts" })).body.data.times).toEqual([0]);
      // The film is still the film, and its timeline untouched.
      const film = await tool("preview_frames", { work: work.id, times: [0.5], format: "png" });
      expect(await pixel(film.body.images[0].data, 0.5, 0.5)).not.toEqual([0, 255, 0]);
      expect(fs.readFileSync(path.join(work.dir, "visual.json"), "utf8")).toBe(visual);
      // An edit of the module shows at once.
      fs.writeFileSync(path.join(work.dir, "sheets", "sheet.ts"), SHEET.replace("#00ff00", "#ffff00"));
      const edited = await tool("preview_frames", { work: work.id, scene: "sheets/sheet.ts", times: [0.5], format: "png" });
      expect(await pixel(edited.body.images[0].data, 0.5, 0.5)).toEqual([255, 255, 0]);
      // A module without createScene says so.
      fs.writeFileSync(path.join(work.dir, "sheets", "plain.ts"), "export const x = 1;\n");
      const plain = await tool("preview_frames", { work: work.id, scene: "sheets/plain.ts" });
      expect(plain.body.error.message).toContain("sheets/plain.ts 没有导出 createScene(options)");
      expect((await tool("preview_frames", { work: work.id, scene: "sheets/sheet.ts", compare: work.id })).body.error.message).toContain(
        "compare 不和 region、scene 一起用",
      );
    },
    120000,
  );

  it.skipIf(!browserExecutable())(
    "enlarges a part of the picture and times every frame",
    async () => {
      const close = await tool("preview_frames", { work: work.id, times: [3], region: [100, 100, 120, 120], format: "png" });
      expect(close.status).toBe(200);
      expect(close.body.data).toMatchObject({ width: 240, height: 240 });
      expect(close.body.text).toContain("局部 [100, 100, 120, 120] 放大 2 倍");
      expect(await pixel(close.body.images[0].data, 0.5, 0.5)).toEqual([255, 0, 0]);
      expect(close.body.text).toMatch(/0:03\.00（[0-9a-f]{12}，\d+ ms/);
      expect(close.body.data.ms[0]).toBeGreaterThanOrEqual(0);
      const capped = await tool("preview_frames", { work: work.id, times: [3], region: [0, 0, 400, 300], scale: 3 });
      expect(capped.body.text).toContain("最多 2 倍：画面长边最多 3840 像素");
      expect((await tool("preview_frames", { work: work.id, times: [3], scale: 2 })).body.error.message).toContain("要和 region 一起用");
      expect((await tool("preview_frames", { work: work.id, times: [3], region: [0, 0, 100, 100], width: 640 })).body.error.message).toContain("不用 width");
      // Several at once on one page, at different sizes: each gets its own frames.
      const alone = await Promise.all([
        tool("preview_frames", { work: work.id, times: [0.5], width: 640, format: "png" }),
        tool("preview_frames", { work: work.id, times: [3], width: 480, format: "png" }),
      ]);
      const together = await Promise.all([
        tool("preview_frames", { work: work.id, times: [0.5], width: 640, format: "png" }),
        tool("preview_frames", { work: work.id, times: [3], width: 480, format: "png" }),
        tool("preview_frames", { work: work.id, times: [3], region: [100, 100, 120, 120] }),
      ]);
      expect(together[0].body.data.digests).toEqual(alone[0].body.data.digests);
      expect(together[1].body.data.digests).toEqual(alone[1].body.data.digests);
      expect(together[1].body.data.width).toBe(480);
    },
    120000,
  );

  it.skipIf(!browserExecutable())(
    "finds a start and a stop without easing and a pop, and measures the film",
    async () => {
      const motion = await tool("preview_motion", { work: work.id, start: 0.5, end: 3 });
      expect(motion.status).toBe(200);
      const text = motion.body.text;
      expect(text).toMatch(/运动检查 0:00\.50–0:03\.00：30 fps，76 帧（按 320×180 画来分析/);
      expect(text).toMatch(/- 0:01\.00–0:02\.00（1\.00 秒）往 ← 移 6\d\d px，最快 6\d\d px\/s/);
      expect(text).toMatch(/起步突然：第一帧就到 6\d\d px\/s，没有缓入；停得突然：最后一帧还有 6\d\d px\/s，没有缓出/);
      expect(text).toContain("0:02.50 局部突变：画面里不到 1% 的地方一帧内变了");
      expect(motion.body.images[0].mimeType).toBe("image/jpeg");
      const speeds = motion.body.data.series.filter((item) => item.time > 1.1 && item.time < 1.9).map((item) => item.speed);
      for (const speed of speeds) expect(Math.abs(speed - 600)).toBeLessThan(60);
      const long = await tool("preview_motion", { work: work.id, start: 0, end: 4, fps: 60 });
      expect(long.body.error.message).toContain("作品是 30 fps");
      const many = await tool("preview_motion", { work: work.id, start: 0, end: 4 });
      expect(many.status).toBe(200);
      // Timing the whole film like the studio preview draws it.
      const check = await tool("work_check", { work: work.id, timing: true });
      expect(check.body.text).toContain("渲染耗时（按工作台预览的样子：1280×720，标准画质，含字幕；每 0.5 秒取一帧；共 8 帧");
      expect(check.body.data.timing.samples).toHaveLength(8);
      expect((await tool("work_check", { work: work.id, timing: true, runtime: false })).body.error.message).toContain("不能和 runtime: false 一起用");
    },
    180000,
  );
});
