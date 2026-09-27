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
  let seed = 6371;
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

    let low = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR,
        rain = smooth(phase(t, 5.0, 6.4)) * (1 - smooth(phase(t, 10.5, 12)));
      low += (rnd() - low) * 0.19;
      pan(i, low * 0.042 * rain, (i % 2) * 0.12 - 0.06);
      const landed =
        smooth(phase(t, 26.1, 26.7)) * (1 - smooth(phase(t, 28.2, 29.2)));
      const bee =
        smooth(phase(t, 24, 25.5)) *
        (1 - smooth(phase(t, 29.5, 32))) *
        (1 - landed * 0.88);
      const buzz =
        (Math.sin(2 * Math.PI * (182 * t + 0.4 * Math.sin(t * 3))) +
          0.25 * Math.sin(2 * Math.PI * 364 * t)) *
        0.0038 *
        bee;
      pan(i, buzz, Math.sin((t - 24) * 0.73) * 0.65);
    }
    for (let k = 0; k < 68; k++) {
      const at = 5.4 + k * 0.087 + (rnd() + 1) * 0.03;
      tap(
        at,
        0.007 + (rnd() + 1) * 0.004,
        rnd() * 0.65,
        1400 + (rnd() + 1) * 900,
      );
    }
    tap(5.8, 0.05, -0.06, 170);
    burst(14.4, 0.75, 0.045, -0.12, 700);
    burst(19.9, 0.6, 0.06, 0.08, 1300);
    burst(30.6, 1.4, 0.09, 0.55, 1700);

  return out;
}
