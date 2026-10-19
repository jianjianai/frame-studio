import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { browserExecutable } from "../server/render.mjs";
import { regionPlan } from "../server/tools/preview-tools.mjs";
import { sceneModule } from "../server/files.mjs";
import { ensureAudioDocument } from "../server/documents.mjs";
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

/** A sample (样片): red until 1 s, then white; 1.5 s long, with the work's sound from 2 s on. */
const SAMPLE = SHEET.replace('"#00ff00" : "#0000ff"', '"#ff0000" : "#ffffff"') + "export const sample = { duration: 1.5, audioFrom: 2 };\n";

/** A 440 Hz tone, 16-bit mono WAV. */
const tone = (seconds, rate = 48000) => {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + samples * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  return data;
};
const loud = (channel) => Math.sqrt(channel.reduce((sum, value) => sum + value * value, 0) / channel.length);

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

  it("names the layers whose creation holds the page, and not the quick ones", () => {
    const layers = [
      { id: "body", name: "岛上", at: 8.785, ms: 2700, longest: 2600, held: 2650 },
      { id: "paper", at: 14.5, ms: 1100, longest: 1100, held: 1100 },
      { id: "title", at: 0, ms: 40, longest: 0, held: 0 },
    ];
    const text = timingReport({ samples: [{ time: 0, ms: 5 }], layers, width: 1280, height: 720, step: 0.5, lastStep: 0.5, complete: true, ms: 900, loadMs: 300 }, { fps: 30 }).join("\n");
    expect(text).toContain("- 「岛上」（0:08.79 出现）创建用了 2.7 秒，最长一次连续卡住 2.6 秒");
    expect(text).toContain("- 「paper」（0:14.50 出现）创建用了 1.1 秒，最长一次连续卡住 1.1 秒");
    expect(text).not.toContain("title");
    expect(text).toContain("显卡帮不上");
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
    "plays a sample as long as it says, with the work's sound from where it says, and exports only it",
    async () => {
      fs.writeFileSync(path.join(work.dir, "sheets", "sample.ts"), SAMPLE);
      fs.mkdirSync(path.join(work.dir, "public"), { recursive: true });
      fs.writeFileSync(path.join(work.dir, "public", "tone.wav"), tone(2));
      const audio = {
        schemaVersion: 1,
        sources: [{ id: "tone", kind: "file", src: `films/${work.slug}/tone.wav` }],
        tracks: [{ id: "music", name: "配乐" }],
        clips: [{ id: "t", track: "music", source: "tone", start: 2, duration: 2 }],
      };
      ensureAudioDocument(work);
      const silent = fs.readFileSync(path.join(work.dir, "audio.json"), "utf8");
      fs.writeFileSync(path.join(work.dir, "audio.json"), JSON.stringify(audio));
      onTestFinished(() => fs.writeFileSync(path.join(work.dir, "audio.json"), silent));
      // The explorer knows samples and modules without running them.
      const tree = await (await fetch(`${base}/api/works/local/${work.id}/tree`)).json();
      const entry = (file) => tree.find((item) => item.path === file);
      expect(entry("sheets/sample.ts")).toMatchObject({ scene: "sample", duration: 1.5 });
      expect(entry("sheets/sheet.ts")).toMatchObject({ scene: "module" });
      expect(entry("sheets/sheet.ts").duration).toBeUndefined();
      expect(entry("scene.ts").scene).toBeUndefined();
      expect(entry("scenes/title.ts")).toMatchObject({ scene: "module" });
      // Sampled over its own 1.5 s; later moments are its last one.
      const spread = await tool("preview_frames", { work: work.id, scene: "sheets/sample.ts" });
      expect(spread.body.data.times).toHaveLength(12);
      expect(Math.max(...spread.body.data.times)).toBeLessThan(1.5);
      const shots = await tool("preview_frames", { work: work.id, scene: "sheets/sample.ts", times: [0.5, 3], format: "png" });
      expect(shots.body.data.times).toEqual([0.5, 1.499]);
      expect(await pixel(shots.body.images[0].data, 0.5, 0.5)).toEqual([255, 0, 0]);
      expect(await pixel(shots.body.images[1].data, 0.5, 0.5)).toEqual([255, 255, 255]);
      // From its 0 s it sounds as the work does from 2 s; the film is silent before 2 s.
      const lease = await app.services.renderer.lease(work, { scene: "sheets/sample.ts" });
      try {
        expect(lease.handle.sample).toEqual({ duration: 1.5, audioFrom: 2 });
        expect(loud((await app.services.renderer.pcmOn(lease.handle, { start: 0.2, duration: 0.5 })).left)).toBeGreaterThan(0.1);
      } finally {
        lease.release();
      }
      expect(loud((await app.services.renderer.audioPcm(work, { start: 0.2, duration: 0.5 })).left)).toBeLessThan(0.001);
      // An export of only the sample: its length, its sound, its name.
      const task = app.services.exports.start(work, { scene: "sheets/sample.ts", width: 320, fps: 12 });
      const done = await app.services.tasks.wait(task.id, 110000);
      expect([done.status, done.error]).toEqual(["done", null]);
      expect(done.result).toMatchObject({ frames: 18, duration: 1.5, audio: true, scene: "sheets/sample.ts", title: "画面检查 · 样片 sample" });
      expect(done.result.name).toMatch(/^画面检查-sample-.+\.mp4$/);
      expect(() => app.services.exports.start(work, { scene: "sheets/none.ts" })).toThrow("作品里没有 sheets/none.ts");
    },
    180000,
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
    "measures a linear pan and a pop, and times the film",
    async () => {
      const motion = await tool("preview_motion", { work: work.id, start: 0.5, end: 3 });
      expect(motion.status).toBe(200);
      const text = motion.body.text;
      expect(text).toMatch(/运动测量 0:00\.50–0:03\.00：30 fps，76 帧（按 320×180 画来分析/);
      expect(text).toMatch(/- 0:01\.00–0:02\.00（1\.00 秒）往 ← 移 6\d\d px；开头一帧 6\d\d px\/s，最快 6\d\d px\/s（0:01\.\d\d[^）]*），结尾一帧 6\d\d px\/s/);
      expect(text).toContain("0:02.50 一帧内不到 1% 的画面变了（整体运动以外的变化）");
      expect(text).not.toMatch(/突然|缓入|缓出|穿帮|不用改/);
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
