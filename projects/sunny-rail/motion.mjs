// Shared by the shot and the offline wheel-joint foley. One distance curve, one clock.
export function trainProgress(time) {
  const start = 1.25,
    end = 33.2,
    ramp = 3.2,
    duration = end - start;
  const x = Math.max(0, Math.min(duration, time - start));
  const integral = (u) => u * u * u - 0.5 * u * u * u * u;
  const travelled =
    x < ramp
      ? ramp * integral(x / ramp)
      : x > duration - ramp
        ? duration - ramp - ramp * integral((duration - x) / ramp)
        : x - ramp / 2;
  return travelled / (duration - ramp);
}
export function arcLengthLookup(point, samples = 2048) {
  const lengths = new Float64Array(samples + 1);
  let previous = point(0);
  for (let i = 1; i <= samples; i++) {
    const p = point((i / samples) * Math.PI * 2);
    lengths[i] =
      lengths[i - 1] +
      Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z);
    previous = p;
  }
  const total = lengths[samples];
  return {
    total,
    parameter(distance) {
      const d = ((distance % total) + total) % total;
      let lo = 0,
        hi = samples;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (lengths[mid] > d) hi = mid;
        else lo = mid;
      }
      return (
        ((lo + (d - lengths[lo]) / (lengths[hi] - lengths[lo])) / samples) *
        Math.PI *
        2
      );
    },
  };
}
