import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { extractModule, paramLine, score } from "../server/resources.mjs";
import { browserExecutable } from "../server/render.mjs";

const SHAPES = `/** 测试用的形状。 */
import { z } from "zod";
import { defineResources, resource } from "@frame/engine/resources";
import { pulse } from "@frame/engine/tempo";

const unit = z.number().min(0).max(1);

export const ballOptions = z.object({
  color: z.enum(["#e55", "#5a5"]).default("#e55").describe("颜色"),
  r: z.number().min(10).max(200).default(80).describe("半径"),
  // How far it lifts on the beat.
  lift: unit.default(0.5),
  label: z.string().optional(),
});

/** A ball that bounces on the beat. */
export function ball(ctx: CanvasRenderingContext2D, x: number, y: number, time: number, options: z.input<typeof ballOptions> = {}) {
  const { color, r, lift } = ballOptions.parse(options);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y - pulse(time, 6) * 100 * lift, r, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------- helpers
export const half = (n: number): number => n / 2;

/** Pose of the test figure. */
export interface Pose {
  /** eyes open or shut */
  eyes?: "open" | "shut";
  turn?: number;
}

export const resources = defineResources({
  ball: resource({
    kind: "prop",
    title: "弹跳的球",
    description: "跟着节拍弹起的球。",
    tags: ["球", "节拍"],
    usage: "ball(ctx, x, y, abs, options)",
    params: ballOptions,
    presets: { 大绿球: { color: "#5a5", r: 160 } },
    preview: { width: 400, height: 300, duration: 2, draw: (ctx, t, p) => ball(ctx, 200, 200, t, p) },
  }),
  sky: resource({ kind: "set", title: "天空", preview: { width: 400, height: 300, background: "#123456", draw() {} } }),
});
`;

const SFX = `import { defineSounds } from "@frame/engine/resources";
const SR = 48000;
function tone(f: number, seconds: number): [Float32Array, Float32Array] {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = Math.sin((2 * Math.PI * f * i) / SR) * 0.5;
  return [l, l.slice()];
}
export default defineSounds(SR, {
  beep: { title: "嘀", duration: 0.4, hit: 0, tags: ["提示"], make: () => tone(880, 0.4) },
  /** a low one */
  boop: { title: "嘟", duration: 0.8, make: () => tone(220, 0.8) },
});
`;

describe("resource declarations, read without running code", () => {
  it("reads resources, parameters, presets, sounds and exports", () => {
    const shapes = extractModule(SHAPES, "测试/code/shapes.ts");
    expect(shapes.doc).toBe("测试用的形状。");
    expect(shapes.errors).toEqual([]);
    const [ball, sky] = shapes.resources;
    expect(ball).toMatchObject({ key: "ball", kind: "prop", title: "弹跳的球", tags: ["球", "节拍"], usage: "ball(ctx, x, y, abs, options)", presets: { 大绿球: { color: "#5a5", r: 160 } } });
    expect(ball.preview).toMatchObject({ width: 400, height: 300, duration: 2 });
    expect(ball.preview.draw).toContain("ball(ctx, 200, 200, t, p)");
    expect(ball.params.map(paramLine)).toEqual([
      'color?: "#e55" | "#5a5" = "#e55" — 颜色',
      "r?: number 10–200 = 80 — 半径",
      "lift?: number 0–1 = 0.5 — How far it lifts on the beat.",
      "label?: string",
    ]);
    expect(sky).toMatchObject({ key: "sky", kind: "set", params: [], preview: { background: "#123456" } });
    const names = Object.fromEntries(shapes.exports.map((item) => [item.name, item]));
    expect(names.ball).toMatchObject({ kind: "function", doc: "A ball that bounces on the beat." });
    expect(names.ball.signature).toMatch(/^ball\(ctx: CanvasRenderingContext2D, x: number/);
    // Section rulers are not documentation.
    expect(names.half).toMatchObject({ kind: "function", signature: "half(n: number): number", doc: "" });
    expect(names.Pose.members).toEqual([
      { name: "eyes", optional: true, type: '"open" | "shut"', doc: "eyes open or shut" },
      { name: "turn", optional: true, type: "number", doc: "" },
    ]);
    expect(names.resources).toBeUndefined();

    const sfx = extractModule(SFX, "测试/code/sfx.ts");
    expect(sfx.sounds).toMatchObject([
      { key: "beep", title: "嘀", duration: 0.4, hit: 0, tags: ["提示"] },
      { key: "boop", title: "嘟", duration: 0.8, description: "a low one" },
    ]);
    expect(sfx.exports).toEqual([]);
  });

  it("follows constants: presets from a cast, spread preview settings", () => {
    const code = `import { z } from "zod";
import { defineResources, resource } from "@frame/engine/resources";
const CAST = { jie: { hair: "short", seed: 301 }, yu: { hair: "curly" } };
const FRAME = { width: 1080, height: 1920, duration: 3 };
export const resources = defineResources({
  person: resource({
    kind: "character",
    title: "人",
    params: z.object({ hair: z.string().optional(), face: z.string().optional() }),
    presets: { 杰: CAST.jie, 杰大笑: { ...CAST.jie, face: "laugh" }, 雨: CAST["yu"], 动态: { face: pick() } },
    preview: { ...FRAME, draw(ctx) { ctx.fill(); } },
  }),
});`;
    const [person] = extractModule(code, "库/people.ts").resources;
    expect(person.presets).toEqual({ 杰: { hair: "short", seed: 301 }, 杰大笑: { hair: "short", seed: 301, face: "laugh" }, 雨: { hair: "curly" }, 动态: { "(代码)": "{ face: pick() }" } });
    expect(person.preview).toMatchObject({ width: 1080, height: 1920, duration: 3 });
  });

  it("ranks matches by where the words appear", () => {
    const entry = { title: "弹跳的球", key: "ball", tags: ["节拍"], description: "跟着节拍弹起", kindLabel: "物品" };
    expect(score(entry, "球")).toBeGreaterThan(score(entry, "弹起"));
    expect(score(entry, "球 节拍")).toBeGreaterThan(0);
    expect(score(entry, "球 下雨")).toBe(0);
  });
});

describe("resources of the material libraries", () => {
  let app, base, works, work;
  const call = async (route, { method = "GET", body, raw } = {}) => {
    const response = await fetch(base + route, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const type = response.headers.get("content-type") || "";
    return { status: response.status, body: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  const tool = (name, args) => call(`/api/tools/${name}`, { method: "POST", body: args });
  const lib = "/api/repos/local/materials";
  const put = (file, content) => call(`${lib}/libraries/${encodeURIComponent("测试")}/upload?path=${encodeURIComponent(file)}&replace=1`, { method: "POST", raw: content });

  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-resources-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    ({ works } = app.services);
    await call(`${lib}/libraries`, { method: "POST", body: { name: "测试" } });
    await put("code/shapes.ts", SHAPES);
    await put("code/sfx.ts", SFX);
    work = await works.create({ title: "用资源" });
  });
  afterAll(() => app.close());

  it("lets the AI find and read resources and code", async () => {
    const all = await tool("resources_search", { work: work.id });
    expect(all.body.text).toContain("素材库「测试」（本作品未关联");
    expect(all.body.text).toContain("测试/code/shapes.ts#ball 弹跳的球");
    expect(all.body.text).toContain("beep 嘀");
    const found = await tool("resources_search", { work: work.id, query: "球" });
    expect(found.body.data.items[0]).toMatchObject({ id: "测试/code/shapes.ts#ball", type: "resource", kindLabel: "物品" });
    const sounds = await tool("resources_search", { work: work.id, kind: "sound" });
    expect(sounds.body.data.items.map((item) => item.id)).toEqual(["测试/code/sfx.ts#beep", "测试/code/sfx.ts#boop"]);
    const code = await tool("resources_search", { work: work.id, query: "bounces", kind: "code" });
    expect(code.body.data.items.map((item) => item.id)).toEqual(["测试/code/shapes.ts#ball"]);

    const detail = await tool("resource_view", { work: work.id, id: "测试/code/shapes.ts#ball", image: false });
    expect(detail.body.text).toContain('导入：import { … } from "@materials/测试/code/shapes"');
    expect(detail.body.text).toContain("- r?: number 10–200 = 80 — 半径");
    expect(detail.body.text).toContain('- 大绿球：{"color":"#5a5","r":160}');
    const module = await tool("resource_view", { work: work.id, id: "测试/code/shapes.ts", image: false });
    expect(module.body.text).toContain("测试用的形状。");
    expect(module.body.text).toContain("- half(n: number): number");
    const sound = await tool("resource_view", { work: work.id, id: "测试/code/sfx.ts#boop" });
    expect(sound.body.text).toContain('module: "materials/测试/code/sfx.ts", trackId: "boop"');
    expect((await tool("resource_view", { work: work.id, id: "测试/code/shapes.ts#nothing" })).status).toBe(404);

    const listing = (await call(`/api/works/local/${work.id}/resources`)).body;
    expect(listing.libraries).toEqual([{ id: "测试", title: "测试", linked: false }]);
    expect(listing.items.map((item) => item.id)).toEqual(["测试/code/sfx.ts#beep", "测试/code/sfx.ts#boop", "测试/code/shapes.ts#ball", "测试/code/shapes.ts#sky"]);
    expect(listing.items.find((item) => item.key === "ball").version).toMatch(/^[0-9a-f]{24}$/);
  });

  it("places library sounds as generated clips and locks their module", async () => {
    const placed = await tool("audio_place", { work: work.id, sound: "测试/code/sfx.ts#boop", start: 1 });
    expect(placed.body.text).toContain("已把音效「嘟」放到音轨「音效」");
    await call(`/api/works/local/${work.id}/audio/place`, { method: "POST", body: { sound: "测试/code/sfx.ts#boop", start: 3, track: "音效" } });
    const audio = JSON.parse(fs.readFileSync(path.join(work.dir, "audio.json"), "utf8"));
    // One source per sound, its length from the declaration.
    expect(audio.sources).toEqual([expect.objectContaining({ kind: "generated", module: "materials/测试/code/sfx.ts", trackId: "boop" })]);
    expect(audio.clips.map((clip) => [clip.start, clip.duration, clip.name])).toEqual([
      [1, 0.8, "嘟"],
      [3, 0.8, "嘟"],
    ]);
    // Using a library's sound links the library; the module is locked; no audio.ts loader is needed.
    const project = fs.readFileSync(path.join(work.dir, "project.ts"), "utf8");
    expect(project).toContain('materials: ["测试"]');
    expect(project).not.toContain("loadAudio:");
    expect(Object.keys(app.services.materials.readLocks(work.dir))).toEqual(["测试/code/sfx.ts"]);
    expect((await tool("audio_place", { work: work.id, sound: "测试/code/shapes.ts#ball" })).status).toBe(400);
  });

  it("serves library code a document names from the work's copies, at its locked version", async () => {
    const { pluginContainer } = app.services.preview.vite.environments.client;
    const copy = path.join(work.root, ".materials", "测试", "code", "sfx.ts");
    fs.rmSync(path.join(work.root, ".materials"), { recursive: true, force: true });
    const url = "/@fs" + path.join(work.root, ".materials", encodeURIComponent("测试"), "code", "sfx.ts");
    expect((await pluginContainer.resolveId(url, path.join(process.cwd(), "index.html"))).id).toBe(copy);
    expect(fs.readFileSync(copy, "utf8")).toContain("defineSounds(SR");
    // The engine alias works from any folder.
    const engine = (await pluginContainer.resolveId("@frame/engine/resources", copy)).id;
    expect(engine).toBe(path.join(process.cwd(), "src", "engine", "resources.ts"));
  });

  it("runs library code for previews as the library has it now, not at the work's locked versions", async () => {
    await put("code/paint.ts", 'export const SKY = "#aa0000";\n');
    await app.services.materials.lock(work, ["测试/code/paint.ts"]);
    await put("code/paint.ts", 'export const SKY = "#123456";\nexport const GROUND = "#654321";\n');
    const { pluginContainer } = app.services.preview.vite.environments.client;
    const { materialBase, assetBase } = app.services.materials.libraryBases("local");
    const copy = (await pluginContainer.resolveId(`${materialBase}${encodeURIComponent("测试")}/code/paint.ts`, path.join(process.cwd(), "index.html"))).id;
    expect(fs.readFileSync(copy, "utf8")).toContain("GROUND");
    // Bare imports in the copies find the studio's packages.
    expect((await pluginContainer.resolveId("zod", copy))?.id).toMatch(/zod/);
    const file = `materials/${encodeURIComponent("测试")}/code/paint.ts`;
    expect((await call(`${assetBase}${file}`)).body.toString()).toContain("GROUND");
    // The work keeps running the version it locked; the catalog says so.
    expect((await call(`/files/local/${work.id}/${file}`)).body.toString()).toContain("#aa0000");
    const view = await tool("resource_view", { work: work.id, id: "测试/code/paint.ts" });
    expect(view.body.text).toContain("本作品锁定了另一个版本");
  });

  it("renders thumbnails in the background, the latest request first", async () => {
    const catalog = app.services.resources;
    const original = catalog.renderThumbnail;
    const order = [];
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const events = [];
    const unsubscribe = app.services.events.subscribe((event) => event.type === "resource-thumb" && events.push(event));
    catalog.renderThumbnail = async ({ key }, file) => {
      order.push(key);
      if (key === "ball") await gate;
      if (key === "hill") throw new Error("画不出来");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "webp");
    };
    try {
      await put(
        "code/scenery.ts",
        'import { defineResources, resource } from "@frame/engine/resources";\nexport const resources = defineResources({ hill: resource({ kind: "set", title: "山", preview: { width: 10, height: 10, draw() {} } }), lake: resource({ kind: "set", title: "湖", preview: { width: 10, height: 10, draw() {} } }) });\n',
      );
      const thumb = (id) => call(`/api/works/local/${work.id}/resources/thumb?id=${encodeURIComponent(id)}`);
      const first = await thumb("测试/code/shapes.ts#ball");
      expect(first.status).toBe(202);
      await thumb("测试/code/scenery.ts#hill");
      await thumb("测试/code/scenery.ts#lake");
      release();
      for (let i = 0; events.length < 3 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      // ball was being drawn; then the latest request (lake) before the earlier one (hill).
      expect(order).toEqual(["ball", "lake", "hill"]);
      expect(events.find((event) => event.id === "测试/code/scenery.ts#hill")).toMatchObject({ repo: "local", error: "画不出来" });
      expect((await thumb("测试/code/shapes.ts#ball")).status).toBe(200);
      // A failure is remembered for that version instead of being drawn again on every request.
      const failed = await thumb("测试/code/scenery.ts#hill");
      expect([failed.status, failed.body.error.message]).toEqual([422, "画不出来"]);
      expect(order).toHaveLength(3);
    } finally {
      catalog.renderThumbnail = original;
      unsubscribe();
      for (const item of fs.readdirSync(catalog.dir)) fs.rmSync(path.join(catalog.dir, item), { force: true });
    }
  });

  it("type-checks works and library code that import the engine by its alias", async () => {
    const scene = path.join(work.dir, "scenes", "balls.ts");
    fs.writeFileSync(
      scene,
      'import type { Scene, SceneOptions } from "@frame/engine/types";\nimport { beatAt } from "@frame/engine/tempo";\nimport { ball, resources } from "@materials/测试/code/shapes";\n' +
        "export function createScene({ width, height }: SceneOptions): Scene {\n  const canvas = document.createElement(\"canvas\");\n  canvas.width = width;\n  canvas.height = height;\n  const ctx = canvas.getContext(\"2d\")!;\n" +
        "  return { canvas, render(t) { ball(ctx, 100, 100, t + beatAt(1), { r: 20 }); void resources.ball.title; }, dispose() {} };\n}\n",
    );
    const { checkWork } = await import("../server/checks.mjs");
    const checked = await checkWork(app.services, work, { runtime: false });
    expect(checked.problems.filter((problem) => problem.source === "types")).toEqual([]);
    fs.writeFileSync(scene, fs.readFileSync(scene, "utf8").replace("{ r: 20 }", '{ r: "big" }'));
    const wrong = await checkWork(app.services, work, { runtime: false });
    expect(wrong.problems.some((problem) => problem.source === "types" && problem.file === "scenes/balls.ts")).toBe(true);
    fs.rmSync(scene);
  }, 60000);

  it.skipIf(!browserExecutable())("renders resources in the work's context for the AI and for thumbnails", async () => {
    await call(`/api/works/local/${work.id}`, { method: "PATCH", body: { tempo: { bpm: 60, firstBeat: 0, beatsPerBar: 4 } } });
    const { frames, info } = await app.services.renderer.resourceFrames(work, { ref: "测试/code/shapes.ts", key: "ball", preset: "大绿球", times: [0, 0.5], width: 200 });
    expect(info).toMatchObject({ key: "ball", width: 400, height: 300, duration: 2, presets: { 大绿球: { color: "#5a5", r: 160 } }, defaults: { color: "#e55", r: 80, lift: 0.5 } });
    expect(info.schema.properties.r).toMatchObject({ type: "number", minimum: 10, maximum: 200, default: 80 });
    const first = await sharp(frames[0].png).metadata();
    expect([first.width, first.height]).toEqual([200, 150]);
    // On the beat (0 s at 60 BPM) the ball is lifted; half a beat later it is down: different pictures.
    const [a, b] = await Promise.all(frames.map((frame) => sharp(frame.png).raw().toBuffer()));
    expect(a.equals(b)).toBe(false);
    const view = await tool("resource_view", { work: work.id, id: "测试/code/shapes.ts#sky" });
    expect(view.body.images).toHaveLength(1);
    // The first request queues it (202); the image is there once rendered.
    const route = `/api/works/local/${work.id}/resources/thumb?id=${encodeURIComponent("测试/code/shapes.ts#sky")}`;
    let thumb = await call(route);
    for (let i = 0; thumb.status === 202 && i < 300; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      thumb = await call(route);
    }
    expect(thumb.status).toBe(200);
    const pixel = await sharp(thumb.body).raw().toBuffer();
    // The set's background (#123456), give or take the WebP compression.
    [0x12, 0x34, 0x56].forEach((value, index) => expect(Math.abs(pixel[index] - value)).toBeLessThan(6));
  }, 120000);

  it.skipIf(!browserExecutable())("previews code whose imports changed since the work locked them", async () => {
    // The work locked paint.ts before GROUND existed; the preview must not mix that copy in.
    await put(
      "code/scenery.ts",
      'import { defineResources, resource } from "@frame/engine/resources";\nimport { SKY, GROUND } from "./paint";\n' +
        'export const resources = defineResources({ hill: resource({ kind: "set", title: "山", preview: { width: 100, height: 100, draw(ctx) { ctx.fillStyle = SKY; ctx.fillRect(0, 0, 100, 50); ctx.fillStyle = GROUND; ctx.fillRect(0, 50, 100, 50); } } }) });\n',
    );
    const { frames } = await app.services.renderer.resourceFrames(work, { ref: "测试/code/scenery.ts", key: "hill", width: 100 });
    const pixels = await sharp(frames[0].png).removeAlpha().raw().toBuffer();
    expect([...pixels.subarray(0, 3)]).toEqual([0x12, 0x34, 0x56]);
    expect([...pixels.subarray(90 * 100 * 3, 90 * 100 * 3 + 3)]).toEqual([0x65, 0x43, 0x21]);
  }, 120000);

  it("lists a summary instead of the whole directory when the libraries hold many resources", async () => {
    const items = Array.from({ length: 300 }, (_, i) => `  item${i}: resource({ kind: "prop", title: "道具 ${i}", preview: { width: 10, height: 10, draw() {} } }),`).join("\n");
    await put("code/many.ts", `import { defineResources, resource } from "@frame/engine/resources";\nexport const resources = defineResources({\n${items}\n});\n`);
    const all = await tool("resources_search", { work: work.id });
    expect(all.body.text).toContain("资源较多，每类只列出前几个");
    expect(all.body.text).toMatch(/物品（30\d）：[^\n]*……（kind: "prop"）/);
    expect(all.body.text.length).toBeLessThan(2000);
    const props = await tool("resources_search", { work: work.id, kind: "prop" });
    expect(props.body.text).toContain("用 query 搜索这一类");
    expect((await tool("resources_search", { work: work.id, query: "道具 299" })).body.data.items[0].id).toBe("测试/code/many.ts#item299");
  });
});
