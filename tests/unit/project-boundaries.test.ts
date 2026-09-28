import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { assetPath, projectPath } from "../../scripts/project-paths.mjs";
import { projectSchema } from "../../src/engine/types";
import paper from "../../projects/paper-wings/project";
const script = path.resolve("scripts/project-scope.mjs");

describe("single project boundaries", () => {
  it("rejects paths, cross-project assets and directory junctions that escape the owner", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-boundaries-"));
    try {
      for (const id of ["one", "two"])
        fs.mkdirSync(path.join(root, "projects", id, "public"), {
          recursive: true,
        });
      expect(() => projectPath(root, "one", "../two/output.png")).toThrow();
      expect(() => assetPath(root, "films/two/audio.wav", "one")).toThrow();
      expect(() =>
        assetPath(root, "films/one/../two/audio.wav", "one"),
      ).toThrow();
      fs.symlinkSync(
        path.join(root, "projects/two"),
        path.join(root, "projects/one/linked"),
        "junction",
      );
      expect(() => projectPath(root, "one", "linked/file.wav")).toThrow(
        /symlink/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("checks untracked, staged and unstaged writes independently and supports commit baselines", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-scope-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [script, "one", ...args], {
        cwd: root,
        encoding: "utf8",
      });
    try {
      git("init");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Fixture");
      fs.mkdirSync(path.join(root, "projects/one"), { recursive: true });
      fs.writeFileSync(path.join(root, "shared.txt"), "original");
      git("add", "shared.txt");
      git("commit", "-m", "fixture");
      const base = git("rev-parse", "HEAD").toString().trim();
      fs.writeFileSync(path.join(root, "projects/one/scene.ts"), "owned");
      expect(run().status).toBe(0);
      fs.writeFileSync(path.join(root, "outside.txt"), "outside");
      expect(run().stderr).toContain("outside.txt");
      fs.unlinkSync(path.join(root, "outside.txt"));
      fs.writeFileSync(path.join(root, "shared.txt"), "staged");
      git("add", "shared.txt");
      fs.writeFileSync(path.join(root, "shared.txt"), "original");
      expect(run().status).toBe(1); // A net-zero diff must not hide a staged violation.
      git("commit", "-m", "shared change");
      git("restore", "shared.txt");
      expect(run("--base", base).status).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15000); // Several Windows Git/Node startups can exceed the default 5 seconds.
});

it("rejects duplicate or out-of-range tracks and ambiguous legacy audio", () => {
  const track = { id: "synth", name: "代码", kind: "generated" as const };
  const project = { ...paper, audio: undefined, audioTracks: [track] };
  expect(projectSchema.safeParse(project).success).toBe(true);
  for (const audioTracks of [
    [track, track],
    [{ ...track, start: paper.duration }],
    [{ ...track, gain: NaN }],
    [{ ...track, start: 1, duration: paper.duration }],
  ])
    expect(projectSchema.safeParse({ ...project, audioTracks }).success).toBe(
      false,
    );
  expect(
    projectSchema.safeParse({
      ...paper,
      audio: "films/paper-wings/legacy.wav",
      audioTracks: [track],
    }).success,
  ).toBe(false);
});
