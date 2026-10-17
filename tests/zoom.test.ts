import { describe, expect, it } from "vitest";
import { clampView, zoomAround } from "../src/preview/zoom";

/** Where a point of the picture (from its middle, unzoomed) shows, relative to its fitted middle. */
const shown = (view: { scale: number; x: number; y: number }, point: { x: number; y: number }) => ({
  x: view.x + point.x * view.scale,
  y: view.y + point.y * view.scale,
});

describe("preview zoom", () => {
  it("keeps the point under the pointer in place", () => {
    const start = { scale: 1.5, x: 30, y: -20 };
    const at = { x: 120, y: -45 };
    const point = { x: (at.x - start.x) / start.scale, y: (at.y - start.y) / start.scale };
    for (const scale of [1, 2, 7.25]) {
      const view = zoomAround(start, scale, at);
      expect(view.scale).toBe(scale);
      expect(shown(view, point).x).toBeCloseTo(at.x);
      expect(shown(view, point).y).toBeCloseTo(at.y);
    }
  });

  it("moves a zoomed picture only until its edges meet the box", () => {
    // A 400×225 picture fitted in the middle of a 400×300 box, zoomed in twice.
    const size = { width: 400, height: 225 };
    const box = { left: 200, right: 200, top: 150, bottom: 150 };
    expect(clampView({ scale: 2, x: 1000, y: 1000 }, size, box)).toEqual({ scale: 2, x: 200, y: 75 });
    expect(clampView({ scale: 2, x: -1000, y: -1000 }, size, box)).toEqual({ scale: 2, x: -200, y: -75 });
    expect(clampView({ scale: 2, x: 50, y: 10 }, size, box)).toEqual({ scale: 2, x: 50, y: 10 });
  });

  it("keeps a picture smaller than the box where it was fitted", () => {
    // Tall picture: 150 wide in a 400 wide box; zoomed 1.5× it is still narrower.
    const view = clampView({ scale: 1.5, x: 80, y: 0 }, { width: 150, height: 300 }, { left: 200, right: 200, top: 150, bottom: 150 });
    expect(view.x).toBe(0);
    // Off-centre fitting (more room on the right): it still stays put while it fits.
    expect(clampView({ scale: 1.2, x: 40, y: 0 }, { width: 100, height: 100 }, { left: 60, right: 300, top: 100, bottom: 100 }).x).toBe(0);
  });

  it("is not zoomed at or below the fitted size", () => {
    expect(clampView({ scale: 0.5, x: 40, y: 12 }, { width: 100, height: 100 }, { left: 50, right: 50, top: 50, bottom: 50 })).toEqual({ scale: 1, x: 0, y: 0 });
  });
});
