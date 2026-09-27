import type { StereoPcm } from "./procedural-audio";

type Coefficients = [number, number, number, number, number];
const sampleRate = 48000;
function filter(samples: Float32Array, [b0, b1, b2, a1, a2]: Coefficients) {
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i],
      y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    samples[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
}
function biquad(
  kind: "highpass" | "lowpass" | "peaking",
  frequency: number,
  q: number,
  db = 0,
): Coefficients {
  const omega = (2 * Math.PI * frequency) / sampleRate,
    c = Math.cos(omega),
    alpha = Math.sin(omega) / (2 * q),
    a = 10 ** (db / 40);
  if (kind === "peaking") {
    const a0 = 1 + alpha / a;
    return [
      (1 + alpha * a) / a0,
      (-2 * c) / a0,
      (1 - alpha * a) / a0,
      (-2 * c) / a0,
      (1 - alpha / a) / a0,
    ];
  }
  const a0 = 1 + alpha,
    sign = kind === "highpass" ? 1 : -1;
  return [
    (1 + sign * c) / (2 * a0),
    (-sign * (1 + sign * c)) / a0,
    (1 + sign * c) / (2 * a0),
    (-2 * c) / a0,
    (1 - alpha) / a0,
  ];
}

/** BS.1770 K weighting and gated 400 ms blocks, at the original 48 kHz rate. */
function integratedLoudness(channels: StereoPcm) {
  const sums = new Float64Array(channels[0].length + 1);
  for (const original of channels) {
    const samples = original.slice();
    filter(
      samples,
      [
        1.53512485958697, -2.69169618940638, 1.19839281085285,
        -1.69065929318241, 0.73248077421585,
      ],
    );
    filter(samples, [1, -2, 1, -1.99004745483398, 0.99007225036621]);
    for (let i = 0; i < samples.length; i++) sums[i + 1] += samples[i] ** 2;
  }
  for (let i = 1; i < sums.length; i++) sums[i] += sums[i - 1];
  const energies: number[] = [],
    block = 19200,
    hop = 4800;
  const absolute = 10 ** ((-70 + 0.691) / 10);
  for (let start = 0; start + block < sums.length; start += hop) {
    const energy = (sums[start + block] - sums[start]) / block;
    if (energy > absolute) energies.push(energy);
  }
  if (!energies.length) return -Infinity;
  const relative =
    energies.reduce((sum, e) => sum + e, 0) / energies.length / 10;
  const gated = energies.filter((e) => e > relative);
  return (
    -0.691 +
    10 * Math.log10(gated.reduce((sum, e) => sum + e, 0) / gated.length)
  );
}

/** Preserve the original EQ, short fades, music/foley balance and -18 LUFS target. */
export function masterScoreTracks(music: StereoPcm, foley: StereoPcm) {
  const length = music[0].length;
  for (const track of [music, foley])
    for (const channel of track) {
      filter(channel, biquad("highpass", 38, 0.707));
      filter(channel, biquad("lowpass", 16500, 0.707));
      filter(channel, biquad("peaking", 270, 0.7, -1));
      for (let i = 0; i < length; i++)
        channel[i] *= Math.min(
          1,
          i / (sampleRate * 0.035),
          (length - 1 - i) / (sampleRate * 0.8),
        );
    }
  const mix: StereoPcm = [new Float32Array(length), new Float32Array(length)];
  let peak = 0;
  for (let channel = 0; channel < 2; channel++)
    for (let i = 0; i < length; i++) {
      mix[channel][i] = music[channel][i] + foley[channel][i];
      peak = Math.max(peak, Math.abs(mix[channel][i]));
    }
  const loudness = integratedLoudness(mix);
  const gain = Number.isFinite(loudness)
    ? Math.min(10 ** ((-18 - loudness) / 20), 10 ** (-1.8 / 20) / peak)
    : 1;
  for (const track of [music, foley])
    for (const channel of track)
      for (let i = 0; i < length; i++) channel[i] *= gain;
}
