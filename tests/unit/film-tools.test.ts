import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createExportPlan } from "../../src/engine/export-plan.mjs";
import { readProjectCatalog } from "../../scripts/project-metadata.mjs";

const cli = path.resolve("scripts/film.mjs");
const run = (args: string[], cwd = process.cwd()) =>
  spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });

describe("fixed frame grid", () => {
  it("rounds fractional durations up without a floating-point extra frame", () => {
    expect(createExportPlan({ duration: 1e-12, fps: 24 }).frames).toBe(1);
    expect(
      createExportPlan({ duration: 1, fps: 30, start: 0.1, end: 0.4 }),
    ).toMatchObject({ frames: 9, duration: 0.3 });
    expect(createExportPlan({ duration: 1.01, fps: 24 })).toMatchObject({
      frames: 25,
      duration: 25 / 24,
    });
  });
  it("rejects invalid dimensions, frame rate and ranges", () => {
    for (const change of [
      { width: 641 },
      { width: 336 },
      { fps: 0 },
      { fps: 29.97 },
      { start: -1 },
      { end: 2 },
      { duration: NaN },
    ])
      expect(() => createExportPlan({ duration: 1, ...change })).toThrow();
  });
});

describe("AI-facing film commands", () => {
  it("lists real metadata and emits standalone machine-readable context", () => {
    const listed = run(["list", "--json"]);
    expect(listed.status).toBe(0);
    const expected = readProjectCatalog().map((p) => p.directory);
    expect(
      JSON.parse(listed.stdout).projects.map((p: { id: string }) => p.id),
    ).toEqual(expected);
    const context = run(["context", expected[0], "--json"]);
    expect(context.status).toBe(0);
    expect(JSON.parse(context.stdout)).toMatchObject({
      schemaVersion: 1,
      id: expected[0],
      writeBoundary: `projects/${expected[0]}/`,
    });
    expect(JSON.parse(context.stdout).workflow.length).toBeGreaterThan(0);
  });
  it("rejects unknown commands, extra arguments, unknown projects and traversal", () => {
    for (const args of [
      ["typo"],
      ["list", "garbage"],
      ["doctor", "garbage"],
      ["context", "../outside", "--json"],
      ["context", "nonexistent", "--json"],
      ["render", "../other"],
      ["poster", "paper-wings", "--all"],
    ])
      expect(run(args).status).not.toBe(0);
    expect(
      JSON.parse(run(["inspect", "nonexistent", "--json"]).stdout),
    ).toHaveProperty("error");
  });
  it("creates a complete generated-audio project without touching any shared files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-film-cli-"));
    try {
      fs.writeFileSync(path.join(root, "shared.txt"), "unchanged");
      const result = run(
        [
          "new",
          "my-film",
          "Film",
          "--renderer",
          "canvas",
          "--duration",
          "2.5",
          "--fps",
          "24",
          "--audio",
          "generated",
        ],
        root,
      );
      expect(result.status, result.stderr).toBe(0);
      const info = readProjectCatalog(root)[0];
      expect(info.meta).toMatchObject({
        duration: 2.5,
        fps: 24,
        audioTracks: [{ kind: "generated" }],
      });
      expect(info.audioLoadPath).toBe("./audio");
      expect(
        fs.existsSync(path.join(root, "projects/my-film/production/brief.md")),
      ).toBe(true);
      expect(fs.readFileSync(path.join(root, "shared.txt"), "utf8")).toBe(
        "unchanged",
      );
      expect(fs.readdirSync(root).sort()).toEqual(["projects", "shared.txt"]);
      fs.mkdirSync(path.join(root, "src/engine"), { recursive: true });
      fs.copyFileSync(
        path.resolve("src/engine/types.ts"),
        path.join(root, "src/engine/types.ts"),
      );
      fs.mkdirSync(path.join(root, "projects/broken/public"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(root, "projects/broken/project.ts"),
        "not valid metadata",
      );
      fs.writeFileSync(
        path.join(root, "projects/broken/public/assets.json"),
        "{broken",
      );
      expect(run(["context", "my-film", "--json"], root).status).toBe(0);
      const checked = run(["check", "my-film", "--strict", "--json"], root);
      expect(checked.status, checked.stdout + checked.stderr).toBe(0);
      expect(run(["new", "my-film", "Overwrite"], root).status).not.toBe(0);
      expect(
        run(["new", "bad-film", "Invalid", "--fps", "0"], root).status,
      ).not.toBe(0);
      expect(fs.existsSync(path.join(root, "projects/bad-film"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
