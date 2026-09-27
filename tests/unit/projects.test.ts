import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { projectSchema } from "../../src/engine/types";
import { activeSubtitle, toSrt } from "../../src/engine/subtitles";
import paper from "../../src/projects/paper-wings/project";
import rail from "../../src/projects/sunny-rail/project";
import seed from "../../src/projects/tiny-seed/project";
for (const p of [paper, rail, seed])
  describe(p.id, () => {
    it("has valid metadata and timeline markers", () => {
      expect(projectSchema.safeParse(p).success).toBe(true);
      expect(new Set(p.beats.map((b) => b.at)).size).toBe(p.beats.length);
      expect(p.beats.every((b, i) => i === 0 || b.at > p.beats[i - 1].at)).toBe(
        true,
      );
    });
    it("has a complete local audio track matching its duration", () => {
      const b = fs.readFileSync(path.join("public", p.audio!));
      expect(b.toString("ascii", 0, 4)).toBe("RIFF");
      expect(b.readUInt16LE(22)).toBe(2);
      const duration = b.readUInt32LE(40) / b.readUInt32LE(28);
      expect(duration).toBe(p.duration);
      let peak = 0;
      for (let i = 44; i < b.length; i += 128)
        peak = Math.max(peak, Math.abs(b.readInt16LE(i)));
      expect(peak).toBeGreaterThan(1000);
      expect(peak).toBeLessThan(32767);
    });
    it("exports subtitles that retain every cue", () => {
      const srt = toSrt(p.subtitles);
      expect(srt.match(/-->/g)?.length).toBe(p.subtitles.length);
      expect(srt).toContain(p.subtitles[0].text);
    });
  });
describe("subtitle boundaries and schema", () => {
  const cues = [
    { start: 1, end: 3.125, text: "一颗种子。" },
    { start: 4, end: 5, text: "开始生长。" },
  ];
  it("selects half-open intervals without stale captions", () => {
    expect(activeSubtitle(cues, 0.99)).toBe("");
    expect(activeSubtitle(cues, 1)).toBe("一颗种子。");
    expect(activeSubtitle(cues, 3.125)).toBe("");
    expect(activeSubtitle(cues, 4)).toBe("开始生长。");
  });
  it("writes valid millisecond SRT stamps", () => {
    expect(toSrt(cues)).toContain("00:00:01,000 --> 00:00:03,125");
  });
  it("rejects out-of-range captions", () => {
    expect(
      projectSchema.safeParse({
        ...paper,
        subtitles: [{ start: 30, end: 40, text: "bad" }],
      }).success,
    ).toBe(false);
  });
  it("rejects invalid identifiers and rates", () => {
    expect(projectSchema.safeParse({ ...paper, id: "../escape" }).success).toBe(
      false,
    );
    expect(projectSchema.safeParse({ ...paper, fps: 0 }).success).toBe(false);
  });
});
