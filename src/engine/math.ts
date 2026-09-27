export const clamp = (x: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, Number.isFinite(x) ? x : min));
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const phase = (t: number, start: number, end: number): number =>
  clamp((t - start) / (end - start));
export const smooth = (t: number): number => {
  const v = clamp(t);
  return v * v * (3 - 2 * v);
};
export const easeInOut = (t: number): number => {
  const v = clamp(t);
  return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
};
export const seeded =
  (seed: number): (() => number) =>
  () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
export const formatTime = (seconds: number): string => {
  const n = Math.max(0, Math.floor(seconds));
  return (
    String(Math.floor(n / 60)).padStart(2, "0") +
    ":" +
    String(n % 60).padStart(2, "0")
  );
};
export function sampleKeys(
  t: number,
  keys: readonly (readonly [number, number])[],
): number {
  if (!keys.length) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++)
    if (t < keys[i][0])
      return mix(
        keys[i - 1][1],
        keys[i][1],
        smooth(phase(t, keys[i - 1][0], keys[i][0])),
      );
  return keys[keys.length - 1][1];
}
