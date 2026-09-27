import { trainProgress } from "../motion.mjs";
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
  let seed = 2851;
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

    const progress = trainProgress;
    let old = 0,
      low = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR,
        q = progress(t),
        speed = (q - progress(Math.max(0, t - 0.01))) * 100;
      low += (rnd() - low) * 0.1;
      pan(
        i,
        low *
          0.028 *
          clamp(speed / 0.0348) *
          smooth(phase(t, 0, 2)) *
          (1 - smooth(phase(t, 33, 36))),
        Math.sin(q * Math.PI * 2) * 0.3,
      );
      const count = Math.floor(q * 124);
      if (count > old) {
        tap(
          t,
          0.012 + clamp(speed / 0.0348) * 0.012,
          Math.sin(q * 6.283) * 0.3,
          470,
        );
        old = count;
      }
    }
    burst(0.72, 0.9, 0.085, -0.18, 1600);
    burst(31.4, 1.0, 0.07, 0.2, 1450);
    // A two-pipe steam whistle, breath envelope and a slight settling pitch, not a sustained sine beep.
    for (const at of [0.72, 1.36])
      for (let j = 0; j < SR * 0.42; j++) {
        const t = j / SR,
          env = smooth(t / 0.065) * smooth((0.42 - t) / 0.12),
          f = 392 * t - 1.6 * (1 - Math.exp(-t * 12));
        pan(
          Math.round(at * SR) + j,
          (Math.sin(2 * Math.PI * f) +
            0.48 * Math.sin(2 * Math.PI * f * 1.5) +
            0.14 * rnd()) *
            env *
            0.018,
          -0.1,
        );
      }

  return out;
}
