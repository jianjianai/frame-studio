const SR=48000;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (v) => {
  const x = clamp(v);
  return x * x * (3 - 2 * x);
};
const phase = (t, a, b) => clamp((t - a) / (b - a));
export function foley(score) {
  const n = Math.round(score.duration * SR),
    out = [new Float32Array(n), new Float32Array(n)];
  let seed = 1029;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  const pan = (i, v, p) => {
    if (i < 0 || i >= n) return;
    out[0][i] += v * Math.sqrt((1 - clamp(p, -1, 1)) / 2);
    out[1][i] += v * Math.sqrt((1 + clamp(p, -1, 1)) / 2);
  };
  const burst = (at, duration, gain, p = 0, cutoff = 1100) => {
    let low = 0;
    const alpha = 1 - Math.exp((-2 * Math.PI * cutoff) / SR),
      start = Math.round(at * SR),
      count = Math.round(duration * SR);
    for (let j = 0; j < count; j++) {
      const x = j / count;
      low += alpha * (rnd() - low);
      pan(start + j, low * gain * Math.sin(Math.PI * x) ** 1.5, p);
    }
  };
  const tap = (at, gain = 0.04, p = 0, pitch = 620) => {
    const start = Math.round(at * SR);
    for (let j = 0; j < SR * 0.065; j++) {
      const t = j / SR;
      const v =
        (Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t * 95) +
          rnd() * 0.23 * Math.exp(-t * 150)) *
        gain *
        (1 - Math.exp(-t * 1800));
      pan(start + j, v, p);
    }
  };

    let lp = 0,
      lp2 = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      lp += (rnd() - lp) * 0.019;
      lp2 += (lp - lp2) * 0.07;
      const wind =
        (0.022 + 0.02 * Math.sin(t * 0.42) ** 2) *
        smooth(t) *
        smooth((32 - t) / 2);
      const sea =
        smooth(phase(t, 16.4, 19)) *
        (1 - smooth(phase(t, 28.7, 32))) *
        (0.018 + 0.025 * Math.sin(t * 0.85) ** 2);
      pan(i, lp2 * (wind + sea), 0.22 * Math.sin(t * 0.2));
    }
    [
      [1.1, 0.6, 0.1, -0.6],
      [7.5, 0.8, 0.13, -0.2],
      [17.4, 1.1, 0.15, 0.6],
      [23.1, 0.7, 0.09, 0.5],
      [27.8, 0.35, 0.07, 0.15],
    ].forEach((a) => burst(...a));
    [0, 1, 2, 3].forEach((i) =>
      tap(28.4 + i * 0.026, 0.012, 0.12, 800 + i * 380),
    );
    // Short original bird calls, quiet and distant; no sampled field recording is implied.
    for (const at of [3.3, 3.58, 19.6, 20.0])
      for (let j = 0; j < SR * 0.16; j++) {
        const t = j / SR,
          f = 1700 * t + 900 * t * t,
          env = Math.sin((Math.PI * t) / 0.16) ** 2;
        pan(
          Math.round(at * SR) + j,
          Math.sin(2 * Math.PI * f) * env * 0.014,
          at < 10 ? -0.55 : 0.55,
        );
      }

  return out;
}
