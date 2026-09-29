import { describe, it, expect } from "vitest";
import {
  validateVisualDocument,
  editVisualDocument,
  clipTime,
  sampleValue,
} from "../../src/engine/visual-document.mjs";
const doc = {
  schemaVersion: 1,
  clips: [
    {
      id: "video",
      source: { kind: "video", src: "films/test/movie.webm" },
      start: 2,
      duration: 8,
      offset: 1,
      rate: 2,
      loop: 3,
      fadeIn: 1,
      fadeOut: 2,
    },
  ],
};
describe("authoritative visual timeline", () => {
  it("maps trim, speed, loop and exclusive end", () => {
    const c = validateVisualDocument(doc).clips[0];
    expect(clipTime(c, 1.9)).toBeNull();
    expect(clipTime(c, 2)).toBe(1);
    expect(clipTime(c, 4)).toBe(2);
    expect(clipTime(c, 10)).toBeNull();
  });
  it("splits without losing source phase, fades or keyframes", () => {
    const split = editVisualDocument(doc, [
      { op: "split", id: "video", at: 4.25, newId: "right" },
    ]);
    const before = validateVisualDocument(doc).clips[0],
      right = split.clips[1];
    for (const t of [4.25, 5, 7, 9.99])
      expect(clipTime(right, t)).toBeCloseTo(clipTime(before, t)!);
    expect(right.fadeOffset).toBe(2.25);
    expect(right.fadeDuration).toBe(8);
  });
  it("preserves omitted properties when editing one field", () => {
    const edited = editVisualDocument(doc, [
      { op: "update", id: "video", patch: { name: "renamed" } },
    ]);
    expect(edited.clips[0]).toMatchObject({
      rate: 2,
      offset: 1,
      loop: 3,
      duration: 8,
      name: "renamed",
    });
  });
  it("clears optional values instead of silently retaining loop or crop", () => {
    const cleared = editVisualDocument(doc, [
      {
        op: "update",
        id: "video",
        patch: {},
        unset: ["loop", "offset", "rate"],
      },
    ]);
    expect(cleared.clips[0].loop).toBeUndefined();
    expect(cleared.clips[0].offset).toBe(0);
    expect(cleared.clips[0].rate).toBe(1);
  });
  it("rejects stale shapes, duplicate ids, cross-project assets, invalid times", () => {
    expect(() =>
      validateVisualDocument({ ...doc, clips: [...doc.clips, ...doc.clips] }),
    ).toThrow();
    expect(() => validateVisualDocument(doc, { projectId: "other" })).toThrow();
    expect(() => validateVisualDocument(doc, { duration: 5 })).toThrow();
    expect(() =>
      editVisualDocument(doc, [
        { op: "split", id: "video", at: 2, newId: "right" },
      ]),
    ).toThrow();
    expect(() =>
      validateVisualDocument({
        ...doc,
        clips: [
          {
            ...doc.clips[0],
            source: { kind: "image", src: "films/test/../secret" },
          },
        ],
      }),
    ).toThrow();
  });
  it("interpolates absolute source-time keys deterministically", () => {
    expect(
      sampleValue(
        [
          { at: 0, value: 0, easing: "smooth" },
          { at: 2, value: 10 },
        ],
        1,
        0,
      ),
    ).toBe(5);
    expect(
      sampleValue(
        [
          { at: 0, value: 0, easing: "hold" },
          { at: 2, value: 10 },
        ],
        1,
        0,
      ),
    ).toBe(0);
  });
});
