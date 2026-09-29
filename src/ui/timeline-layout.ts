/** Fractions of the whole composition, independent of the fixed track-header gutter. */
export interface TimelineWindow {
  start: number;
  end: number;
}
export const MIN_TIMELINE_SPAN = 1 / 64;
const bound = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
export function timelineWindow(start: number, end: number): TimelineWindow {
  if (!Number.isFinite(start) || !Number.isFinite(end))
    return { start: 0, end: 1 };
  const span = bound(end - start, MIN_TIMELINE_SPAN, 1);
  const left = bound(start, 0, 1 - span);
  return { start: left, end: left + span };
}
export function moveTimelineWindow(
  view: TimelineWindow,
  mode: "pan" | "start" | "end",
  delta: number,
  minimumSpan = MIN_TIMELINE_SPAN,
): TimelineWindow {
  if (!Number.isFinite(delta)) return view;
  const minimum = bound(minimumSpan, MIN_TIMELINE_SPAN, 1);
  if (mode === "start")
    return {
      start: bound(view.start + delta, 0, view.end - minimum),
      end: view.end,
    };
  if (mode === "end")
    return {
      start: view.start,
      end: bound(view.end + delta, view.start + minimum, 1),
    };
  return timelineWindow(view.start + delta, view.end + delta);
}
export function timelineTicks(duration: number, width: number, fps: number) {
  if (
    ![duration, width, fps].every(Number.isFinite) ||
    duration <= 0 ||
    width <= 0 ||
    fps <= 0
  )
    return { interval: 1, times: [0] };
  const nice = (value: number) => {
    const power = 10 ** Math.floor(Math.log10(value));
    return ([1, 2, 5, 10].find((n) => n * power >= value - 1e-9) ?? 10) * power;
  };
  const target = (duration * 88) / width;
  const interval =
    target < 1
      ? Math.max(1, Math.ceil(nice(Math.max(1, target * fps)))) / fps
      : nice(target);
  const times = Array.from(
    { length: Math.min(4000, Math.floor(duration / interval) + 1) },
    (_, i) => i * interval,
  );
  return { interval, times };
}
export function snapTimelineTime(
  time: number,
  duration: number,
  fps: number,
  boundaries: number[],
  tolerance: number,
) {
  const rounded = bound(Math.round(time * fps) / fps, 0, duration);
  let result = rounded,
    distance = tolerance;
  for (const point of boundaries) {
    const next = Math.abs(rounded - point);
    if (point >= 0 && point <= duration && next < distance) {
      result = point;
      distance = next;
    }
  }
  return result;
}
/** Wheel deltas in pixels: ordinary wheel pans; Shift accesses overflowing track rows. */
export function timelineWheel(
  deltaX: number,
  deltaY: number,
  mode: number,
  shift: boolean,
  page: number,
) {
  const factor = mode === 1 ? 16 : mode === 2 ? page : 1;
  const horizontal = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  return {
    left: shift ? 0 : horizontal * factor,
    top: shift ? (deltaY || deltaX) * factor : 0,
  };
}
