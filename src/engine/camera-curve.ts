export type CameraKey = readonly [time: number, value: number];
/** Shape-preserving cubic Hermite curve. C1 at every knot; no chord cuts or stop/start easing at each key. */
export function cameraCurve(time: number, keys: readonly CameraKey[]): number {
  if (keys.length < 2) return keys[0]?.[1] ?? 0;
  if (time <= keys[0][0]) return keys[0][1];
  if (time >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];
  const slope = (i: number) =>
    (keys[i + 1][1] - keys[i][1]) / (keys[i + 1][0] - keys[i][0]);
  const tangent = (i: number): number => {
    if (i === 0 || i === keys.length - 1) return 0;
    const a = slope(i - 1),
      b = slope(i);
    if (a * b <= 0) return 0;
    const ha = keys[i][0] - keys[i - 1][0],
      hb = keys[i + 1][0] - keys[i][0];
    return (3 * (ha + hb)) / ((2 * hb + ha) / a + (hb + 2 * ha) / b);
  };
  let i = 0;
  while (time >= keys[i + 1][0]) i++;
  const h = keys[i + 1][0] - keys[i][0],
    u = (time - keys[i][0]) / h;
  return (
    (2 * u * u * u - 3 * u * u + 1) * keys[i][1] +
    (u * u * u - 2 * u * u + u) * h * tangent(i) +
    (-2 * u * u * u + 3 * u * u) * keys[i + 1][1] +
    (u * u * u - u * u) * h * tangent(i + 1)
  );
}
