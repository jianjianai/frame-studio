import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import sharp from "sharp";
import { writeProjectPoster } from "../../scripts/poster-output.mjs";
import { checkProjects, localAsset } from "../../scripts/check-projects.mjs";
import {
  readProject,
  readProjectCatalog,
  validProjectId,
} from "../../scripts/project-metadata.mjs";
const createScript = path.resolve("scripts/new-animation.mjs"),
  checkScript = path.resolve("scripts/check-projects.mjs"),
  renderScript = path.resolve("scripts/render.mjs");
function write(root: string, name: string, text: string) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function withRoot(run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-standard-"));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const metadata = (id = "story") => ({
  id,
  title: "标题",
  subtitle: "副标题",
  description: "用动作讲故事",
  renderer: "canvas",
  status: "draft",
  duration: 24,
  fps: 30,
  poster: `films/${id}/poster.svg`,
  tags: [],
  credits: ["原创"],
  beats: [{ at: 0, title: "开场", detail: "动作" }],
  subtitles: [],
});
function fixture(
  root: string,
  changes: Record<string, unknown> = {},
  code = "export function createScene(){return {canvas:{},render(time:number){return time},dispose(){}}}",
) {
  const meta = { ...metadata(), ...changes };
  write(
    root,
    "projects/story/project.ts",
    `const project={...${JSON.stringify(meta)},load:()=>import('./scene')};export default project;`,
  );
  write(root, "projects/story/scene.ts", code);
  write(root, "projects/story/public/poster.svg", "<svg/>");
  write(root, "projects/story/README.md", "# Actual production notes");
}
const codes = (root: string) =>
  checkProjects(root).issues.map((issue) => issue.code);

describe("static project registry metadata", () => {
  it("supports typed objects, local constant spreads and satisfies without executing code", () =>
    withRoot((root) => {
      fixture(root);
      write(
        root,
        "projects/story/project.ts",
        `import type { AnimationProject } from '../../engine/types'; const identity=${JSON.stringify(metadata())} as const; const project={...identity,load:()=>import('./scene')} satisfies AnimationProject; export default project;`,
      );
      const item = readProject(path.join(root, "projects/story/project.ts"));
      expect(item.meta.id).toBe("story");
      expect(item.loadPath).toBe("./scene");
    }));
  it("rejects computed metadata and circular constants without evaluating them", () =>
    withRoot((root) => {
      fixture(root);
      for (const text of [
        `const x=(()=>{throw new Error('must not run')})();export default x;`,
        `const x=y;const y=x;export default x;`,
      ]) {
        write(root, "projects/story/project.ts", text);
        expect(() =>
          readProject(path.join(root, "projects/story/project.ts")),
        ).toThrow();
      }
    }));
  it("reports syntax errors instead of silently omitting a broken project", () =>
    withRoot((root) => {
      fixture(root);
      write(root, "projects/story/project.ts", "export default {");
      expect(codes(root)).toContain("STATIC_METADATA");
    }));
  it("finds newly registered projects without fixed totals or loading renderers", () =>
    withRoot((root) => {
      fixture(root);
      write(
        root,
        "projects/second/project.ts",
        `export default {...${JSON.stringify(metadata("second"))},renderer:'three',load:()=>import('./scene')}`,
      );
      const records = readProjectCatalog(root);
      expect(records).toHaveLength(2);
      expect(records.filter((p) => p.meta.renderer === "three")).toHaveLength(
        1,
      );
    }));
  it("rejects traversal, reserved names and ambiguous new ids", () => {
    for (const id of [
      "../x",
      "X",
      "a--b",
      "a-",
      "con",
      "aux",
      "lpt1",
      "a".repeat(65),
      "",
    ])
      expect(validProjectId(id)).toBe(false);
    for (const id of ["a", "film-2026", "tiny-seed"])
      expect(validProjectId(id)).toBe(true);
  });
});
describe("project engineering checks", () => {
  it("passes coherent schema values without requiring audio", () =>
    withRoot((root) => {
      fixture(root);
      const report = checkProjects(root, { strict: true });
      expect(report.passed).toBe(true);
      expect(report.issues).toEqual([]);
    }));
  it("checks that the folder, metadata and local scene entry agree", () =>
    withRoot((root) => {
      fixture(root, { id: "different" });
      expect(codes(root)).toContain("PROJECT_ID");
      fs.unlinkSync(path.join(root, "projects/story/scene.ts"));
      expect(codes(root)).toContain("SCENE_MISSING");
    }));
  it("validates duration, fps, explicit status and subtitle order", () =>
    withRoot((root) => {
      fixture(root, {
        status: "approved",
        duration: 0,
        fps: 2,
        subtitles: [
          { start: 4, end: 6, text: "a" },
          { start: 5, end: 7, text: "b" },
        ],
      });
      expect(codes(root)).toEqual(
        expect.arrayContaining(["STATUS", "DURATION", "FPS", "SUBTITLES"]),
      );
    }));
  it("rejects duplicated or out-of-range shot markers", () =>
    withRoot((root) => {
      fixture(root, {
        beats: [
          { at: 0, title: "A" },
          { at: 0, title: "B" },
          { at: 25, title: "C" },
        ],
      });
      expect(codes(root)).toContain("BEATS");
    }));
  it("does not crash on invalid metadata collection types", () =>
    withRoot((root) => {
      fixture(root, { subtitles: 12, tags: 12, credits: 12, beats: 12 });
      expect(() => checkProjects(root)).not.toThrow();
      expect(codes(root)).toContain("SUBTITLES");
    }));
  it("blocks remote, encoded, absolute and traversal asset paths", () =>
    withRoot((root) => {
      fixture(root);
      for (const ref of [
        "https://remote/audio.wav",
        "../secret",
        ".//x",
        "/outside",
        "C:/x",
        "x%2fy",
        "x?y",
        "x\\y",
      ])
        expect(() => localAsset(root, ref)).toThrow();
      expect(localAsset(root, "films/story/poster.svg")).toBe(
        path.join(root, "projects/story/public/poster.svg"),
      );
    }));
  it("detects missing local imports and private cross-film dependencies", () =>
    withRoot((root) => {
      fixture(
        root,
        {},
        `import {x} from './missing'; import {y} from '../other/private'; export function createScene(){}`,
      );
      write(root, "projects/other/private.ts", "export const y=1");
      expect(codes(root)).toEqual(
        expect.arrayContaining(["IMPORT_MISSING", "CROSS_PROJECT_IMPORT"]),
      );
    }));
  it("detects real independent clocks/audio and nondeterminism, but not comments or strings", () =>
    withRoot((root) => {
      fixture(
        root,
        {},
        `// Math.random(); requestAnimationFrame(f)
const note='Date.now()';export function createScene(){return 1}`,
      );
      expect(checkProjects(root).errors).toBe(0);
      write(
        root,
        "projects/story/scene.ts",
        `export function createScene(){Math.random();Date.now();performance.now();requestAnimationFrame(()=>{});setInterval(()=>{},1);new Audio();new AudioContext();}`,
      );
      expect(codes(root)).toEqual(
        expect.arrayContaining([
          "NONDETERMINISTIC_TIME",
          "OWN_CLOCK",
          "OWN_AUDIO",
        ]),
      );
    }));
  it("blocks runtime CDN imports and direct remote asset loads", () =>
    withRoot((root) => {
      fixture(
        root,
        {},
        `import x from 'https://cdn.example/library.js';export function createScene(){fetch('https://example/sound.mp3');}`,
      );
      expect(codes(root)).toEqual(
        expect.arrayContaining(["REMOTE_IMPORT", "REMOTE_RUNTIME_ASSET"]),
      );
    }));
  it("checks catalog bytes and licensing records without claiming to verify legal rights", () =>
    withRoot((root) => {
      fixture(root, { audio: "films/story/audio.wav" });
      write(root, "projects/story/public/audio.wav", "test");
      write(
        root,
        "public/assets.json",
        JSON.stringify([
          {
            url: "films/story/audio.wav",
            type: "image",
            bytes: 8,
            license: "",
          },
        ]),
      );
      expect(codes(root)).toEqual(
        expect.arrayContaining(["AUDIO_CATALOG", "AUDIO_LICENSE"]),
      );
    }));
  it("warns about missing engineering indexes by default and rejects them in strict mode", () =>
    withRoot((root) => {
      fixture(root);
      fs.unlinkSync(path.join(root, "projects/story/README.md"));
      expect(checkProjects(root).passed).toBe(true);
      expect(checkProjects(root, { strict: true }).passed).toBe(false);
      write(root, "projects/story/README.md", "# Source and scripts");
      expect(checkProjects(root, { strict: true }).issues).toEqual([]);
    }));
  it("detects credited local documents that do not exist", () =>
    withRoot((root) => {
      fixture(root, { credits: ["说明 docs/NOT-HERE.md"] });
      expect(codes(root)).toContain("BROKEN_DOC_LINK");
    }));
  it("reports unknown projects and invalid JSON catalogs", () =>
    withRoot((root) => {
      fixture(root);
      expect(checkProjects(root, { ids: ["no-such-film"] }).passed).toBe(false);
      write(root, "public/assets.json", "not json");
      expect(codes(root)).toContain("ASSET_CATALOG");
    }));
  it("is a read-only check, including CLI JSON and strict exit codes", () =>
    withRoot((root) => {
      fixture(root);
      fs.unlinkSync(path.join(root, "projects/story/README.md"));
      const before = fs.readFileSync(
        path.join(root, "projects/story/project.ts"),
      );
      const run = spawnSync(
        process.execPath,
        [checkScript, "story", "--strict", "--json"],
        { cwd: root, encoding: "utf8" },
      );
      expect(run.status).toBe(1);
      expect(JSON.parse(run.stdout).warnings).toBeGreaterThan(0);
      expect(
        fs.readFileSync(path.join(root, "projects/story/project.ts")),
      ).toEqual(before);
      expect(fs.existsSync(path.join(root, "exports"))).toBe(false);
    }));
});
describe("safe complete project scaffold", () => {
  it("creates independent resources, an engineering README and a complete scene before registration", () =>
    withRoot((root) => {
      write(
        root,
        "src/engine/types.ts",
        "export type Scene = unknown; export type SceneOptions = unknown; export type AnimationProject = unknown;",
      );
      const run = spawnSync(
        process.execPath,
        [createScript, "new-story", 'A "quoted" 标题', "--renderer", "canvas"],
        { cwd: root, encoding: "utf8" },
      );
      expect(run.status, run.stderr).toBe(0);
      const meta = readProject(
        path.join(root, "projects/new-story/project.ts"),
      ).meta;
      expect(meta.status).toBe("draft");
      expect(meta.poster).toBe("films/new-story/poster.svg");
      expect(
        fs.readFileSync(
          path.join(root, "projects/new-story/public/poster.svg"),
          "utf8",
        ),
      ).toContain("DRAFT");
      expect(
        fs.readFileSync(
          path.join(root, "projects/new-story/README.md"),
          "utf8",
        ),
      ).toContain('A "quoted" 标题 · 工程说明');
      expect(checkProjects(root, { strict: true }).issues).toEqual([]);
      expect(
        fs.existsSync(
          path.join(root, "projects/new-story/tests/e2e/scene.spec.ts"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(root, "projects/new-story/scene.ts")),
      ).toBe(true);
      expect(fs.existsSync(path.join(root, "public/assets.json"))).toBe(false);
    }));
  it("preserves existing production material and rejects invalid command options", () =>
    withRoot((root) => {
      write(root, "projects/new-story/README.md", "keep");
      const run = spawnSync(
        process.execPath,
        [createScript, "new-story", "Title"],
        { cwd: root },
      );
      expect(run.status).not.toBe(0);
      expect(
        fs.readFileSync(
          path.join(root, "projects/new-story/README.md"),
          "utf8",
        ),
      ).toBe("keep");
      expect(fs.existsSync(path.join(root, "src"))).toBe(false);
      expect(
        spawnSync(
          process.execPath,
          [createScript, "other", "Title", "--renderer", "canvas", "--unknown"],
          { cwd: root },
        ).status,
      ).not.toBe(0);
    }));
  it("never overwrites an existing per-film test", () =>
    withRoot((root) => {
      write(root, "projects/new-story/tests/e2e/scene.spec.ts", "keep-test");
      expect(
        spawnSync(process.execPath, [createScript, "new-story", "Title"], {
          cwd: root,
        }).status,
      ).not.toBe(0);
      expect(
        fs.readFileSync(
          path.join(root, "projects/new-story/tests/e2e/scene.spec.ts"),
          "utf8",
        ),
      ).toBe("keep-test");
    }));
  it("serializes competing creation of the same id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-race-"));
    try {
      const launch = () => {
        const child = spawn(
          process.execPath,
          [createScript, "same-story", "Title"],
          { cwd: root, stdio: "ignore" },
        );
        return once(child, "exit");
      };
      const result = await Promise.all([launch(), launch()]);
      expect(result.filter(([code]) => code === 0)).toHaveLength(1);
      expect(
        fs.existsSync(path.join(root, "projects/same-story/scene.ts")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(root, "projects/same-story/public/poster.svg")),
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("requires an explicit poster target or full-library request before starting a browser", () =>
    withRoot((root) => {
      const run = spawnSync(process.execPath, [renderScript, "--posters"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("--project");
      expect(fs.existsSync(path.join(root, "public"))).toBe(false);
    }));
});

describe("engineering rules do not impose creation policy", () => {
  it("accepts film metadata with no audio, captions or shot markers and never infers approval from text", () =>
    withRoot((root) => {
      fixture(root, {
        status: "film",
        title: "待审核 / 任意内容",
        subtitle: "",
        description: "",
        tags: ["制作中"],
        credits: [],
        beats: [],
        subtitles: [],
      });
      const report = checkProjects(root, { strict: true });
      expect(report.passed).toBe(true);
      expect(report.issues).toEqual([]);
    }));
  it("does not read README prose as a production-approval gate", () =>
    withRoot((root) => {
      fixture(root);
      write(
        root,
        "projects/story/README.md",
        "# 工程说明\n<!-- production:pending -->\nTODO: document helper functions",
      );
      expect(checkProjects(root, { strict: true }).issues).toEqual([]);
    }));
  it("keeps repository rules and the scaffold template free of creative workflow and quality thresholds", () => {
    for (const file of [
      "AGENTS.md",
      "docs/NEW-PROJECT-STANDARD.md",
      "docs/AUTHORING.md",
      "templates/engineering.md",
    ]) {
      const text = fs.readFileSync(file, "utf8");
      for (const rule of [
        "先做 10–20 秒",
        "样片审核",
        "LUFS",
        "dBTP",
        "音乐先行",
        "禁止 PPT",
        "最小交付清单",
        "质量底线",
        "production:pending",
      ])
        expect(text, file + " contains a creative policy").not.toContain(rule);
    }
  });
});

describe("poster writes follow the declared path and protect other files", () => {
  const makePNG = () =>
    sharp({
      create: { width: 32, height: 18, channels: 3, background: "#808080" },
    })
      .png()
      .toBuffer();
  it("updates the declared SVG rather than a second hard-coded folder", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-poster-"));
    try {
      fixture(root);
      write(root, "public/posters/other.webp", "KEEP");
      const output = await writeProjectPoster(root, "story", await makePNG());
      expect(output).toBe(path.join(root, "projects/story/public/poster.svg"));
      expect(fs.readFileSync(output, "utf8")).toContain(
        "data:image/png;base64,",
      );
      expect(
        fs.readFileSync(path.join(root, "public/posters/other.webp"), "utf8"),
      ).toBe("KEEP");
      expect(fs.existsSync(path.join(root, "public/posters/story.webp"))).toBe(
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("creates a missing declared WebP and never touches metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-poster-"));
    try {
      fixture(root, { poster: "films/story/poster.webp" });
      const before = fs.readFileSync(
        path.join(root, "projects/story/project.ts"),
      );
      const output = await writeProjectPoster(root, "story", await makePNG());
      expect((await sharp(fs.readFileSync(output)).metadata()).format).toBe(
        "webp",
      );
      expect(
        fs.readFileSync(path.join(root, "projects/story/project.ts")),
      ).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("rejects shared destinations and traversal without overwriting bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-poster-"));
    try {
      fixture(root);
      write(
        root,
        "projects/other/project.ts",
        `export default {...${JSON.stringify({ ...metadata("other"), poster: "films/story/poster.svg" })},load:()=>import('./scene')};`,
      );
      const png = await makePNG();
      await expect(writeProjectPoster(root, "story", png)).rejects.toThrow(
        "shared",
      );
      expect(
        fs.readFileSync(
          path.join(root, "projects/story/public/poster.svg"),
          "utf8",
        ),
      ).toBe("<svg/>");
      fixture(root, { poster: "../outside.webp" });
      await expect(writeProjectPoster(root, "story", png)).rejects.toThrow(
        "poster path",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
