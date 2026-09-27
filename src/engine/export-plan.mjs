/** Shared frame grid for browser and command exports. No wall-clock time. */
export function createExportPlan({
  duration,
  fps = 30,
  width = 1920,
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
  if (!Number.isInteger(width) || width < 320 || width > 3840 || width % 32)
    throw new Error("width must be a multiple of 32 from 320 to 3840");
  const frames = Math.max(1, Math.ceil((end - start) * fps - 1e-9));
  return {
    start,
    end,
    fps,
    width,
    height: (width * 9) / 16,
    frames,
    duration: frames / fps,
  };
}
