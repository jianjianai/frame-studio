import { describe, expect, it } from "vitest";
import {
  MIN_TIMELINE_SPAN,
  moveTimelineWindow,
  snapTimelineTime,
  timelineTicks,
  timelineWheel,
  timelineWindow,
} from "../../src/ui/timeline-layout";
describe("timeline viewport geometry", () => {
  it("pans within bounds without changing its zoom", () => {
    const right = moveTimelineWindow({ start: 0.2, end: 0.6 }, "pan", 2);
    expect(right.start).toBeCloseTo(0.6);
    expect(right.end).toBe(1);
    const left = moveTimelineWindow({ start: 0.2, end: 0.6 }, "pan", -2);
    expect(left.start).toBe(0);
    expect(left.end).toBeCloseTo(0.4);
  });
  it("zooms either edge without moving the other and prevents edge crossover", () => {
    const a = moveTimelineWindow({ start: 0.2, end: 0.8 }, "start", 0.15);
    expect(a.start).toBeCloseTo(0.35);
    expect(a.end).toBe(0.8);
    const b = moveTimelineWindow(a, "end", -0.2);
    expect(b.start).toBe(a.start);
    expect(b.end).toBeCloseTo(0.6);
    expect(moveTimelineWindow(a, "start", 10).start).toBeCloseTo(
      0.8 - MIN_TIMELINE_SPAN,
    );
    expect(moveTimelineWindow(a, "end", -10).end).toBeCloseTo(
      0.35 + MIN_TIMELINE_SPAN,
    );
  });
  it("keeps enough draggable width at mobile maximum zoom", () => {
    const result = moveTimelineWindow(
      { start: 0, end: 1 },
      "end",
      -1,
      36 / 300,
    );
    expect((result.end - result.start) * 300).toBeCloseTo(36);
  });
  it("normalizes invalid windows without NaN", () => {
    expect(timelineWindow(NaN, Infinity)).toEqual({ start: 0, end: 1 });
    expect(timelineWindow(1, -2)).toEqual({
      start: 1 - MIN_TIMELINE_SPAN,
      end: 1,
    });
    expect(moveTimelineWindow({ start: 0, end: 1 }, "pan", NaN)).toEqual({
      start: 0,
      end: 1,
    });
  });
  it("spaced ticks cover different frame rates, durations and zoom widths", () => {
    for (const duration of [2, 60, 480, 3600])
      for (const width of [180, 640, 1200, 45000])
        for (const fps of [12, 24, 30, 60]) {
          const result = timelineTicks(duration, width, fps);
          expect(result.times[0]).toBe(0);
          expect((result.interval / duration) * width).toBeGreaterThanOrEqual(
            87.9,
          );
          expect(result.times.at(-1)).toBeLessThanOrEqual(duration);
          expect(result.times.length).toBeLessThan(4001);
          expect(result.interval * fps).toBeCloseTo(
            Math.round(result.interval * fps),
          );
        }
  });
  it("snaps to frames and nearby clip edges but Alt permits precise off-edge scrubbing", () => {
    expect(snapTimelineTime(2.099, 10, 30, [2.1], 0.05)).toBe(2.1);
    expect(snapTimelineTime(2.067, 10, 30, [2.1], 0)).toBeCloseTo(62 / 30);
    expect(snapTimelineTime(-1, 10, 30, [], 0.01)).toBe(0);
    expect(snapTimelineTime(12, 10, 30, [], 0.01)).toBe(10);
  });
  it("wheel defaults to horizontal and Shift explicitly accesses vertical tracks", () => {
    expect(timelineWheel(0, 100, 0, false, 500)).toEqual({ left: 100, top: 0 });
    expect(timelineWheel(1, 100, 0, false, 500)).toEqual({ left: 100, top: 0 });
    expect(timelineWheel(-90, -10, 0, false, 500)).toEqual({
      left: -90,
      top: 0,
    });
    expect(timelineWheel(0, 3, 1, false, 500)).toEqual({ left: 48, top: 0 });
    expect(timelineWheel(0, 1, 2, false, 500)).toEqual({ left: 500, top: 0 });
    expect(timelineWheel(0, 100, 0, true, 500)).toEqual({ left: 0, top: 100 });
  });
});
