import { it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readProject } from "../../scripts/project-metadata.mjs";
it("creates an engine-neutral empty composition with engineering-only instructions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "frame-neutral-"));
  try {
    const r = spawnSync(
      process.execPath,
      [path.resolve("scripts/new-animation.mjs"), "fresh-film", "新作品"],
      { cwd: root, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    const folder = path.join(root, "projects/fresh-film");
    const meta = readProject(path.join(folder, "project.ts"));
    expect(meta.meta.renderer).toBe("composition");
    expect(meta.meta.visual?.clips).toEqual([]);
    expect(meta.meta.beats).toEqual([]);
    const scene = readFileSync(path.join(folder, "scene.ts"), "utf8");
    expect(scene).not.toMatch(/from ["'](three|pixi.js|@babylonjs)/);
    expect(meta.visualLoadPath).toBe("./visual.json");
    const readme = readFileSync(path.join(folder, "README.md"), "utf8");
    expect(readme).toContain("不预选 2D 或 3D");
    expect(readme).toContain("visual.json");
    expect(readme).toContain("Babylon.js");
    expect(readme).not.toContain("先核对分镜");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
