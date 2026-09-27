import { describe, it, expect } from "vitest";
import { Clock } from "../../src/engine/clock";
import { clamp, easeInOut, sampleKeys, seeded } from "../../src/engine/math";
describe("the shared animation clock", () => {
  it("starts paused and does not advance", () => {
    let now = 0;
    const c = new Clock(10, () => now);
    now = 20;
    expect(c.time()).toBe(0);
  });
  it("pauses without losing the exact position", () => {
    let now = 0;
    const c = new Clock(10, () => now);
    c.play();
    now = 3.25;
    c.pause();
    now = 9;
    expect(c.time()).toBe(3.25);
    c.play();
    now = 10;
    expect(c.time()).toBe(4.25);
  });
  it("can seek backwards while playing", () => {
    let now = 0;
    const c = new Clock(10, () => now);
    c.play();
    now = 7;
    c.seek(2);
    now = 8;
    expect(c.time()).toBe(3);
  });
  it("changes rate continuously", () => {
    let now = 0;
    const c = new Clock(20, () => now);
    c.play();
    now = 4;
    c.setRate(2);
    expect(c.time()).toBe(4);
    now = 7;
    expect(c.time()).toBe(10);
    c.setRate(0.5);
    now = 9;
    expect(c.time()).toBe(11);
  });
  it("clamps invalid seek positions", () => {
    const c = new Clock(10, () => 0);
    c.seek(-4);
    expect(c.time()).toBe(0);
    c.seek(999);
    expect(c.time()).toBe(10);
    c.seek(NaN);
    expect(c.time()).toBe(0);
  });
  it("finishes at the exact duration and replays from zero", () => {
    let now = 0;
    const c = new Clock(10, () => now);
    c.play();
    now = 15;
    expect(c.time()).toBe(10);
    c.pause();
    c.play();
    expect(c.time()).toBe(0);
  });
  it("loops without depending on the rendering frame rate", () => {
    let now = 0;
    const c = new Clock(10, () => now);
    c.loop = true;
    c.play();
    now = 31.5;
    expect(c.time()).toBe(1.5);
    c.pause();
    now = 90;
    expect(c.time()).toBe(1.5);
  });
  it("rejects invalid rates and durations", () => {
    expect(() => new Clock(0, () => 0)).toThrow();
    expect(() => new Clock(Infinity, () => 0)).toThrow();
    const c = new Clock(10, () => 0);
    expect(() => c.setRate(-1)).toThrow();
    expect(() => c.setRate(NaN)).toThrow();
  });
  it("does not reset already playing transport", () => {
    let now = 0;
    const c = new Clock(10, () => now);
    c.play();
    now = 3;
    c.play();
    expect(c.time()).toBe(3);
  });
});
describe("deterministic scene math", () => {
  it("clamps and eases endpoints", () => {
    expect(clamp(NaN)).toBe(0);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBe(0.5);
  });
  it("recreates the same seeded scene", () => {
    const a = seeded(23),
      b = seeded(23);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });
  it("samples exact keys and bounds", () => {
    const keys = [
      [0, 10],
      [5, 40],
      [10, 20],
    ] as const;
    expect(sampleKeys(-1, keys)).toBe(10);
    expect(sampleKeys(5, keys)).toBe(40);
    expect(sampleKeys(15, keys)).toBe(20);
    expect(sampleKeys(3, keys)).toBeGreaterThan(10);
  });
});
