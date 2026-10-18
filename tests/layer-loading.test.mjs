import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { browserExecutable } from "../server/render.mjs";

/** A layer that is ready only once the other layer has started loading too. */
const waitingScene = (id, other, color) => `import type { SceneOptions } from "@frame/engine/types";
const started = ((globalThis as { __started?: Set<string> }).__started ??= new Set<string>());
export async function createScene({ width, height }: SceneOptions) {
  started.add("${id}");
  const end = Date.now() + 5000;
  while (!started.has("${other}")) {
    if (Date.now() > end) throw new Error("layers loaded one after another");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  return { canvas, render() { ctx.fillStyle = "${color}"; ctx.fillRect(0, 0, width, height / 2); } };
}
`;

describe("layer loading", () => {
  let app, base, work;
  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-layers-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    work = await app.services.works.create({ title: "一起加载", width: 320, height: 180, duration: 2 });
    fs.writeFileSync(path.join(work.dir, "scenes", "a.ts"), waitingScene("a", "b", "#ff0000"));
    fs.writeFileSync(path.join(work.dir, "scenes", "b.ts"), waitingScene("b", "a", "#0000ff"));
    fs.writeFileSync(
      path.join(work.dir, "scene.ts"),
      `import type { SceneOptions } from "@frame/engine/types";
import { createCompositionScene } from "@frame/engine/compositor";
import visual from "./visual.json";
export const createScene = (options: SceneOptions) => createCompositionScene(options, visual, { a: () => import("./scenes/a"), b: () => import("./scenes/b") });
`,
    );
    const layer = (id) => ({ id, source: { kind: "scene", module: id, engine: "canvas" }, start: 0, duration: 2 });
    fs.writeFileSync(path.join(work.dir, "visual.json"), JSON.stringify({ schemaVersion: 1, background: "#000000", clips: [layer("a"), layer("b")] }));
  });
  afterAll(() => app.close());

  // Each layer's modules, fonts and media load over the network: one after another, a
  // picture with several new layers waits for each in turn.
  it.skipIf(!browserExecutable())(
    "loads the new layers of a picture together",
    async () => {
      const response = await fetch(`${base}/api/tools/preview_frames`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ work: work.id, times: [0.5] }),
      });
      const body = await response.json();
      expect(body.error?.message ?? "").not.toMatch(/one after another/);
      expect(response.status).toBe(200);
      expect(body.images.length).toBe(1);
    },
    120000,
  );
});

/** A layer that takes a while to load (like a model), noting where playback was when it began. */
const slowScene = `import type { SceneOptions } from "@frame/engine/types";
export async function createScene({ width, height }: SceneOptions) {
  const stage = (globalThis as { __FRAME_STAGE__?: { player(): { getState(): { time: number } } | undefined } }).__FRAME_STAGE__;
  (globalThis as { __slowAt?: number }).__slowAt = stage?.player()?.getState().time ?? -1;
  await new Promise((resolve) => setTimeout(resolve, 800));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return { canvas, render() {}, dispose() {} };
}
`;

describe("layers ahead of playback", () => {
  let app, base, work;
  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-ahead-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    work = await app.services.works.create({ title: "提前载入", width: 320, height: 180, duration: 4 });
    fs.writeFileSync(path.join(work.dir, "scenes", "slow.ts"), slowScene);
    fs.writeFileSync(
      path.join(work.dir, "scene.ts"),
      `import type { SceneOptions } from "@frame/engine/types";
import { createCompositionScene } from "@frame/engine/compositor";
import visual from "./visual.json";
export const createScene = (options: SceneOptions) => createCompositionScene(options, visual, { title: () => import("./scenes/title"), slow: () => import("./scenes/slow") });
`,
    );
    const layer = (id, start, duration) => ({ id, source: { kind: "scene", module: id, engine: "canvas" }, start, duration });
    fs.writeFileSync(path.join(work.dir, "visual.json"), JSON.stringify({ schemaVersion: 1, background: "#000000", clips: [layer("title", 0, 4), layer("slow", 2, 2)] }));
  });
  afterAll(() => app.close());

  // A new layer (a model: seconds to load and compile) used to start loading when playback
  // reached it, and playback stopped for it (缓冲中).
  it.skipIf(!browserExecutable())(
    "start loading while playback is still before them",
    async () => {
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
      try {
        const page = await browser.newPage();
        const query = new URLSearchParams({ module: app.services.preview.moduleUrl(path.join(work.dir, "project.ts")), assetBase: `/files/${work.repo}/${work.id}/`, live: "0" });
        await page.goto(`${base}/preview/stage.html?${query}`);
        await page.waitForFunction(() => window.__FRAME_STAGE__?.player()?.ready, null, { timeout: 60000 });
        await page.evaluate(() => window.__FRAME_STAGE__.player().play());
        await page.waitForFunction(() => globalThis.__slowAt !== undefined, null, { timeout: 10000 });
        expect(await page.evaluate(() => globalThis.__slowAt)).toBeLessThan(2);
      } finally {
        await browser.close();
      }
    },
    120000,
  );
});

describe("layers that hold the page", () => {
  let app, base, work;
  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-hold-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    work = await app.services.works.create({ title: "卡住页面", width: 320, height: 180, duration: 2 });
    // Creating this layer computes for 400 ms at once, as building terrain or parsing a model does.
    fs.writeFileSync(
      path.join(work.dir, "scenes", "heavy.ts"),
      `import type { SceneOptions } from "@frame/engine/types";
export function createScene({ width, height }: SceneOptions) {
  const end = performance.now() + 400;
  while (performance.now() < end);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return { canvas, render() {}, dispose() {} };
}
`,
    );
    fs.writeFileSync(
      path.join(work.dir, "scene.ts"),
      `import type { SceneOptions } from "@frame/engine/types";
import { createCompositionScene } from "@frame/engine/compositor";
import visual from "./visual.json";
export const createScene = (options: SceneOptions) => createCompositionScene(options, visual, { title: () => import("./scenes/title"), heavy: () => import("./scenes/heavy") });
`,
    );
    const layer = (id, name, start, duration) => ({ id, name, source: { kind: "scene", module: id, engine: "canvas" }, start, duration });
    fs.writeFileSync(path.join(work.dir, "visual.json"), JSON.stringify({ schemaVersion: 1, background: "#000000", clips: [layer("title", "标题", 0, 2), layer("heavy", "重的", 1, 1)] }));
  });
  afterAll(() => app.close());

  it.skipIf(!browserExecutable())(
    "are named by timing, with how long they held it",
    async () => {
      const response = await fetch(`${base}/api/tools/work_check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ work: work.id, timing: true }) });
      const body = await response.json();
      expect(body.error?.message ?? "").toBe("");
      expect(response.status).toBe(200);
      expect(body.text).toMatch(/「重的」（0:01\.00 出现）创建用了 0\.[4-9] 秒，最长一次连续卡住 0\.[3-9] 秒/);
      expect(body.text).not.toMatch(/「标题」（/);
    },
    180000,
  );
});
