import { describe, it, expect } from "vitest";
import {
  frameDimensions,
  fitComposition,
} from "../../src/engine/dimensions.mjs";
import { createExportPlan } from "../../src/engine/export-plan.mjs";
describe("composition dimensions", () => {
  it("keeps legacy work at 16:9", () => {
    expect(frameDimensions({}, 1920)).toEqual({ width: 1920, height: 1080 });
    expect(createExportPlan({ duration: 2 })).toMatchObject({
      width: 1920,
      height: 1080,
    });
  });
  it("never rounds the fitted long edge past the codec limit", () => {
    expect(
      fitComposition({ composition: { width: 101, height: 1000 } }, 3840),
    ).toEqual({ width: 386, height: 3822 });
  });
  it("shares portrait and square frame dimensions across all exports", () => {
    const portrait = { composition: { width: 1080, height: 1920 } };
    expect(fitComposition(portrait, 1920)).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(createExportPlan({ duration: 2, ...portrait })).toMatchObject({
      width: 1080,
      height: 1920,
    });
    expect(
      frameDimensions({ composition: { width: 1024, height: 1024 } }, 1280),
    ).toEqual({ width: 1280, height: 1280 });
    expect(() => frameDimensions(portrait, 3840)).toThrow(/height/);
  });
});
