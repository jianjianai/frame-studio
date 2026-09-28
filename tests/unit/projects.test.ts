import { describe, it, expect } from "vitest";
import { projectSchema } from "../../src/engine/types";
import { activeSubtitle, toSrt } from "../../src/engine/subtitles";
import paper from "../helpers/project";
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
