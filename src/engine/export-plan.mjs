import { frameDimensions, fitComposition } from "./dimensions.mjs";
/** Shared frame grid for browser and command exports. No wall-clock time. */
export function createExportPlan({
  duration,
  fps = 30,
  width,
  composition,
  start = 0,
  end = duration,
}) {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > duration
  )
    throw new Error("Invalid export time range");
  if (!Number.isInteger(fps) || fps < 12 || fps > 60)
    throw new Error("fps must be 12..60");
  width ??= fitComposition({ composition }, 1920).width;
  const dimensions = frameDimensions({ composition }, width);
  const frames = Math.max(1, Math.ceil((end - start) * fps - 1e-9));
  return {
    start,
    end,
    fps,
    ...dimensions,
    frames,
    duration: frames / fps,
  };
}
