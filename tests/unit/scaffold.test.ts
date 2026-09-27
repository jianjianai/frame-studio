import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const script = path.resolve("scripts/new-animation.mjs");
describe("safe project scaffolding", () => {
  for (const renderer of ["canvas", "pixi", "three"])
    it("creates a discoverable " + renderer + " project", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "frame-scaffold-"));
      try {
        const result = spawnSync(
          process.execPath,
          [script, "new-story", "新的故事", "--renderer", renderer],
          { cwd: dir, encoding: "utf8" },
        );
        expect(result.status).toBe(0);
        const manifest = readFileSync(
          path.join(dir, "projects/new-story/project.ts"),
          "utf8",
        );
        expect(manifest).toContain("新的故事");
        expect(manifest).toContain(renderer);
        expect(
          readFileSync(
            path.join(dir, "projects/new-story/scene.ts"),
            "utf8",
          ),
        ).toContain("render(time)");
        const again = spawnSync(
          process.execPath,
          [script, "new-story", "do not overwrite"],
          { cwd: dir },
        );
        expect(again.status).not.toBe(0);
        expect(
          readFileSync(
            path.join(dir, "projects/new-story/project.ts"),
            "utf8",
          ),
        ).toBe(manifest);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  it("rejects path traversal", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "frame-scaffold-"));
    try {
      const result = spawnSync(
        process.execPath,
        [script, "../outside", "invalid"],
        { cwd: dir },
      );
      expect(result.status).not.toBe(0);
      expect(existsSync(path.join(dir, "src"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
