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
