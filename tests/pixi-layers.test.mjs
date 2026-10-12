import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { browserExecutable } from "../server/render.mjs";

/** A Pixi layer: a blurred label (pooled filter and text textures) and a circle. */
const pixiScene = (label, x) => `import type { SceneOptions } from "@frame/engine/types";
import { createPixiScene } from "@frame/engine/scene-adapters";
import { BlurFilter, Graphics, Text } from "pixi.js";
export const createScene = (options: SceneOptions) =>
  createPixiScene(options, (app) => {
    const text = new Text({ text: "${label}", style: { fill: "#ffffff", fontSize: 60 } });
    text.filters = [new BlurFilter({ strength: 2 })];
    const dot = new Graphics();
    app.stage.addChild(dot, text);
    return (t) => {
      dot.clear().circle(${x} + Math.sin(t) * 20, 180, 50).fill("#5af");
    };
  });
`;

describe("Pixi layers", () => {
  let app, base, work;
  const tool = async (name, args) => {
    const response = await fetch(`${base}/api/tools/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return { status: response.status, body: await response.json() };
  };

  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-pixi-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    work = await app.services.works.create({ title: "Pixi 图层", width: 640, height: 360, duration: 3 });
    fs.writeFileSync(path.join(work.dir, "scenes", "short.ts"), pixiScene("short", 200));
    fs.writeFileSync(path.join(work.dir, "scenes", "long.ts"), pixiScene("long", 440));
    fs.writeFileSync(
      path.join(work.dir, "scene.ts"),
      `import type { SceneOptions } from "@frame/engine/types";
import { createCompositionScene } from "@frame/engine/compositor";
import visual from "./visual.json";
export const createScene = (options: SceneOptions) =>
  createCompositionScene(options, visual, { short: () => import("./scenes/short"), long: () => import("./scenes/long") });
`,
    );
    const layer = (id, start, duration) => ({ id, source: { kind: "scene", module: id, engine: "pixi" }, start, duration });
    fs.writeFileSync(path.join(work.dir, "visual.json"), JSON.stringify({ schemaVersion: 1, background: "#000000", clips: [layer("long", 0, 3), layer("short", 0, 1)] }));
  });
  afterAll(() => app.close());

  it.skipIf(!browserExecutable())("keep drawing after another Pixi layer ends", async () => {
    // Back and forth across the short layer's end: each time it is destroyed and made again.
    const frames = await tool("preview_frames", { work: work.id, times: [0.5, 2, 0.4, 2.5, 0.8, 1.5] });
    expect(frames.status).toBe(200);
    const checked = await tool("work_check", { work: work.id, runtime: true });
    expect(checked.body.text).toMatch(/^检查通过/);
    // Ending one layer must not destroy the textures the others hold.
    expect(checked.body.data.console.filter((line) => /BindGroup|destroyed/.test(line))).toEqual([]);
  }, 120000);

  it.skipIf(!browserExecutable())("draw every layer of a busy picture, the same each time", async () => {
    // More Pixi layers than a browser keeps WebGL contexts (about 16): they share one renderer.
    const clips = Array.from({ length: 18 }, (_, i) => ({
      id: `l${i}`,
      source: { kind: "scene", module: "long", engine: "pixi" },
      start: 0,
      duration: 3,
      transform: { x: (i % 6) / 6, y: Math.floor(i / 6) / 3, width: 1 / 6, height: 1 / 3 },
    }));
    fs.writeFileSync(path.join(work.dir, "visual.json"), JSON.stringify({ schemaVersion: 1, background: "#000000", clips }));
    const { frames } = await app.services.renderer.frames(app.services.works.describe("local", work.id), { times: [1, 1, 2, 1], width: 640 });
    expect(frames[1].png.equals(frames[0].png)).toBe(true);
    expect(frames[3].png.equals(frames[0].png)).toBe(true);
    const checked = await tool("work_check", { work: work.id, runtime: true });
    expect(checked.body.data.console.filter((line) => /WebGL|context/i.test(line))).toEqual([]);
  }, 120000);
});
