import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkFiles } from "../server/templates.mjs";
import { readVisual, editVisual, readAudio, editAudio, placeAudio } from "../server/documents.mjs";
import { readProjectDir } from "../server/project-meta.mjs";

let work;
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-doc-"));
  for (const [file, content] of Object.entries(
    createWorkFiles({ slug: "work-doc", title: "文档", width: 1920, height: 1080, duration: 10, fps: 30, description: "" }),
  )) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  work = { dir: path.join(root, "projects", "work-doc"), slug: "work-doc" };
});

describe("visual.json", () => {
  it("edits layers atomically with sha256 protection", () => {
    const current = readVisual(work);
    const result = editVisual(work, {
      expectedSha256: current.sha256,
      operations: [{ op: "add", clip: { id: "flash", source: { kind: "color", color: "#ffffff" }, start: 1, duration: 0.5 } }],
    });
    expect(result.document.clips.map((clip) => clip.id)).toEqual(["title", "flash"]);
    expect(() => editVisual(work, { expectedSha256: current.sha256, operations: [{ op: "remove", id: "flash" }] })).toThrow(/已被修改/);
  });

  it("rejects clips beyond the work duration and leaves the file untouched", () => {
    const before = fs.readFileSync(path.join(work.dir, "visual.json"), "utf8");
    expect(() => editVisual(work, { operations: [{ op: "update", id: "title", patch: { duration: 30 } }] })).toThrow();
    expect(fs.readFileSync(path.join(work.dir, "visual.json"), "utf8")).toBe(before);
  });
});

describe("partial updates", () => {
  it("merges nested layer fields and removes nested ones", () => {
    const update = (patch, unset) => editVisual(work, { operations: [{ op: "update", id: "title", patch, ...(unset ? { unset } : {}) }] }).document.clips[0];
    update({ transform: { x: 0.1, opacity: [{ at: 0, value: 0 }, { at: 1, value: 1 }] } });
    expect(update({ transform: { opacity: 0.5 } }).transform).toEqual({ x: 0.1, opacity: 0.5 });
    expect(update({ source: { parameters: { speed: 2 } } }).source).toMatchObject({ kind: "scene", module: "title", parameters: { speed: 2 } });
    expect(update({}, ["transform.x", "transform.opacity"]).transform).toBeUndefined();
    // A source of another kind replaces the old one.
    expect(update({ source: { kind: "color", color: "#ff0000" } }).source).toEqual({ kind: "color", color: "#ff0000" });
    expect(() => update({ opacity: 0.5 })).toThrow(/要写在 transform 里/);
    expect(() => update({}, ["start"])).toThrow(/可以删除的字段/);
  });

  it("updates part of a mix item", () => {
    const placed = placeAudio(work, { src: "films/work-doc/a.wav", start: 1, duration: 2, trackName: "音乐" });
    const edited = editAudio(work, {
      operations: [
        { op: "update", collection: "clips", id: placed.clip.id, patch: { gain: 0.5, fadeOut: 0.5 } },
        { op: "update", collection: "tracks", id: placed.track.id, patch: { muted: true } },
        { op: "update", collection: "master", patch: { gain: 0.8 } },
      ],
    }).document;
    expect(edited.clips[0]).toMatchObject({ start: 1, duration: 2, gain: 0.5, fadeOut: 0.5 });
    expect(edited.tracks[0]).toMatchObject({ name: "音乐", muted: true });
    expect(edited.master.gain).toBe(0.8);
    const reset = editAudio(work, { operations: [{ op: "update", collection: "clips", id: placed.clip.id, patch: {}, unset: ["gain"] }] }).document;
    expect(reset.clips[0].gain).toBe(1);
    expect(() => editAudio(work, { operations: [{ op: "update", collection: "clips", id: "nope", patch: { gain: 1 } }] })).toThrow(/没有 id 为 nope/);
    expect(() => editAudio(work, { operations: [{ op: "update", collection: "clips", id: placed.clip.id, patch: { id: "x" } }] })).toThrow(/不能修改 id/);
  });
});

describe("audio.json", () => {
  it("creates and declares the mix document on first edit", () => {
    expect(readAudio(work).declared).toBe(false);
    fs.mkdirSync(path.join(work.dir, "public"), { recursive: true });
    const placed = placeAudio(work, { src: "films/work-doc/voice.wav", start: 2, duration: 3, trackName: "配音" });
    expect(placed.clip).toMatchObject({ start: 2, duration: 3 });
    const project = readProjectDir(work.dir);
    expect(project.loads.audioDocument).toBe("./audio.json");
    expect(project.meta.audioDocument.tracks.map((track) => track.name)).toEqual(["配音"]);
  });

  it("reuses an existing track and clamps clips to the work", () => {
    placeAudio(work, { src: "films/work-doc/a.wav", start: 0, duration: 2, trackName: "录音" });
    const second = placeAudio(work, { src: "films/work-doc/b.wav", start: 8, duration: 5, trackName: "录音" });
    expect(second.clip.duration).toBe(2);
    expect(readAudio(work).document.tracks).toHaveLength(1);
  });

  it("adds loadAudio for generated sources when audio.ts exists", () => {
    fs.writeFileSync(path.join(work.dir, "audio.ts"), "export const generators = {};\n");
    editAudio(work, {
      operations: [
        { op: "put", collection: "sources", value: { id: "gen", kind: "generated", module: "pad" } },
        { op: "put", collection: "tracks", value: { id: "music", name: "音乐" } },
        { op: "put", collection: "clips", value: { id: "c1", track: "music", source: "gen", start: 0, duration: 4 } },
      ],
    });
    expect(readProjectDir(work.dir).loads.audio).toBe("./audio");
  });
});

describe("mixing rules", async () => {
  const { mixingRules } = await import("../server/checks.mjs");
  const doc = (trigger) => ({
    sources: [
      { id: "vo", kind: "file", src: "films/w/voice/line1.mp3" },
      { id: "boom", kind: "file", src: "films/w/sfx/boom.wav" },
    ],
    tracks: [
      { id: "music", name: "配乐", processors: [{ type: "duck", track: trigger }] },
      { id: "t1", name: "轨道 1" },
      { id: "fx", name: "音效" },
    ],
    clips: [
      { id: "c1", track: "t1", source: "vo", start: 0, duration: 1 },
      { id: "c2", track: "fx", source: "boom", start: 0, duration: 1 },
    ],
  });
  it("warns when sound effects push the music down, never when a voice does", () => {
    expect(mixingRules(doc("fx"))).toMatchObject([{ severity: "warning", source: "audio", message: expect.stringContaining("「配乐」的 duck 由「音效」触发") }]);
    // A track playing generated voice-over counts as voice whatever its name.
    expect(mixingRules(doc("t1"))).toEqual([]);
    expect(mixingRules({ tracks: [{ id: "narration", name: "Narration" }, { id: "m", name: "BGM", processors: [{ type: "duck", track: "narration" }] }] })).toEqual([]);
    expect(mixingRules(null)).toEqual([]);
  });
});
