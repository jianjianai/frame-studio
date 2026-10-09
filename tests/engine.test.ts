import { describe, expect, it } from "vitest";
import { createExportPlan } from "../src/engine/export-plan.mjs";
import { frameDimensions, fitComposition } from "../src/engine/dimensions.mjs";
import { validateVisualDocument, editVisualDocument, clipTime } from "../src/engine/visual-document.mjs";
import { validateAudioDocument, compileAudioTracks, editAudioDocument } from "../src/engine/audio-document.mjs";
import { activeSubtitle } from "../src/engine/subtitles";
import { setTempo, beatAt, barAt, beatIndex, sinceBeat, pulse, beatLength } from "../src/engine/tempo";
import { materialBaseOf, MATERIAL_MODULE } from "../src/engine/materials";

describe("engine contracts", () => {
  it("plans exports on an integer frame grid", () => {
    expect(createExportPlan({ duration: 2.01, fps: 30, width: 640 })).toMatchObject({ frames: 61, width: 640, height: 360 });
    expect(() => createExportPlan({ duration: 2, fps: 30, start: 2, end: 1 })).toThrow();
  });
  it("keeps aspect ratio on even pixel grids", () => {
    expect(frameDimensions({ composition: { width: 1080, height: 1920 } }, 720)).toEqual({ width: 720, height: 1280 });
    expect(fitComposition({ composition: { width: 1080, height: 1920 } }, 1280)).toEqual({ width: 720, height: 1280 });
  });
  it("maps layer time with offset, rate and loop", () => {
    const doc = validateVisualDocument({
      schemaVersion: 1,
      clips: [{ id: "a", source: { kind: "color", color: "#000000" }, start: 2, duration: 4, offset: 1, rate: 2, loop: 3 }],
    });
    expect(clipTime(doc.clips[0], 1)).toBeNull();
    expect(clipTime(doc.clips[0], 2.5)).toBe(2);
    expect(clipTime(doc.clips[0], 3.5)).toBe(1 + (3 % 3));
    const split = editVisualDocument(doc, [{ op: "split", id: "a", at: 4, newId: "b" }]);
    expect(split.clips.map((clip) => [clip.id, clip.start, clip.duration])).toEqual([
      ["a", 2, 2],
      ["b", 4, 2],
    ]);
  });
  it("compiles the audio mix and validates routing", () => {
    const doc = {
      schemaVersion: 1,
      sources: [{ id: "s", kind: "file", src: "films/x/a.wav" }],
      tracks: [{ id: "t", name: "T" }],
      clips: [{ id: "c", track: "t", source: "s", start: 1, duration: 2 }],
    };
    expect(compileAudioTracks(doc)[0]).toMatchObject({ id: "audio:c", src: "films/x/a.wav", start: 1, duration: 2 });
    expect(() => validateAudioDocument({ ...doc, tracks: [{ id: "t", name: "T", output: "missing" }] })).toThrow(/不存在的总线：missing/);
    expect(editAudioDocument(doc, [{ op: "split", id: "c", at: 2, newId: "d" }]).clips).toHaveLength(2);
  });
  it("lets generated sources name a sound module of a material library", () => {
    const doc = {
      schemaVersion: 1,
      sources: [{ id: "s", kind: "generated", module: "materials/s0rrow/code/sfx.ts", trackId: "slam" }],
      tracks: [{ id: "t", name: "音效" }],
      clips: [{ id: "c", track: "t", source: "s", start: 1, duration: 0.5 }],
    };
    expect(compileAudioTracks(doc)[0]).toMatchObject({ kind: "generated", module: "materials/s0rrow/code/sfx.ts", sourceTrackId: "slam" });
    expect(() => validateAudioDocument({ ...doc, sources: [{ ...doc.sources[0], module: "materials/s0rrow/sfx.json" }] })).toThrow();
    expect(() => validateAudioDocument({ ...doc, sources: [{ ...doc.sources[0], module: "../sfx.ts" }] })).toThrow();
    expect(MATERIAL_MODULE.test("materials/共享素材/a/b.ts")).toBe(true);
    expect(materialBaseOf("/@fs/home/w/local/abc/projects/work-abc/project.ts?t=1")).toBe("/@fs/home/w/local/abc/.materials/");
  });
  it("follows the work's beat grid", () => {
    setTempo({ bpm: 120, firstBeat: 0.5 });
    expect(beatLength()).toBe(0.5);
    expect(beatAt(2)).toBe(1.5);
    expect(beatAt(2.5)).toBe(1.75);
    expect(barAt(1)).toBe(2.5);
    expect(beatIndex(1.75)).toBe(2.5);
    expect(sinceBeat(1.6)).toBeCloseTo(0.1);
    expect(sinceBeat(0.2)).toBeCloseTo(0.2); // before the first beat: from the beat before it
    expect(pulse(1.5)).toBe(1);
    setTempo({ bpm: 60, beatsPerBar: 3 });
    expect(barAt(2)).toBe(6);
    setTempo();
    expect(beatAt(1)).toBe(0.5);
  });
  it("finds the active subtitle", () => {
    expect(activeSubtitle([{ start: 1, end: 2, text: "hi" }], 1.5)).toBe("hi");
    expect(activeSubtitle([{ start: 1, end: 2, text: "hi" }], 2.5)).toBe("");
  });
});
