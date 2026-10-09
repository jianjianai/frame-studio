import { spawn } from "node:child_process";
import { problem } from "./util.mjs";
import { ffmpegExecutable } from "./render.mjs";

/**
 * Sound an AI cannot hear, as numbers: loudness per window, and for music the tempo, the
 * beats and the strongest onsets, so cuts and hits can land on the music.
 */

export const ANALYSIS_RATE = 22050;
const db = (value) => (value > 0 ? Math.round(20 * Math.log10(value) * 10) / 10 : -120);
const round = (value) => Math.round(value * 100) / 100;

/** Decode `seconds` of a media file from `start` to stereo float PCM at ANALYSIS_RATE. */
export async function decodeAudio(file, { start = 0, seconds }) {
  const ffmpeg = ffmpegExecutable();
  if (!ffmpeg) throw problem(500, "分析音频文件需要 FFmpeg。安装 ffmpeg 或设置 FFMPEG_PATH。", "NO_FFMPEG");
  const args = [
    "-v",
    "error",
    "-ss",
    String(start),
    ...(seconds ? ["-t", String(seconds)] : []),
    "-i",
    file,
    "-vn",
    "-ac",
    "2",
    "-ar",
    String(ANALYSIS_RATE),
    "-f",
    "f32le",
    "-",
  ];
  const chunks = [];
  let errors = "";
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(problem(422, `无法解码音频：${errors.trim().split("\n").pop() || code}`, "DECODE_FAILED"))));
  });
  const buffer = Buffer.concat(chunks);
  const samples = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
  const left = new Float32Array(samples.length / 2);
  const right = new Float32Array(samples.length / 2);
  for (let i = 0; i < left.length; i++) {
    left[i] = samples[2 * i];
    right[i] = samples[2 * i + 1];
  }
  return { left, right, rate: ANALYSIS_RATE };
}

/** RMS and peak per window (dBFS), silent windows and clipped samples of stereo PCM. */
export function loudness(left, right, rate, { start = 0, window = 0.5 }) {
  const perWindow = Math.max(1, Math.round(window * rate));
  const windows = [];
  let sumAll = 0,
    peakAll = 0,
    clipped = 0;
  for (let from = 0; from < left.length; from += perWindow) {
    let sum = 0,
      peak = 0;
    const to = Math.min(left.length, from + perWindow);
    for (let i = from; i < to; i++) {
      const l = left[i],
        r = right[i];
      const v = Math.max(Math.abs(l), Math.abs(r));
      if (v >= 0.999) clipped++;
      if (v > peak) peak = v;
      sum += (l * l + r * r) / 2;
    }
    sumAll += sum;
    peakAll = Math.max(peakAll, peak);
    windows.push({ time: round(start + from / rate), rmsDb: db(Math.sqrt(sum / (to - from))), peakDb: db(peak) });
  }
  return {
    overall: { rmsDb: db(Math.sqrt(sumAll / Math.max(1, left.length))), peakDb: db(peakAll), clippedSamples: clipped },
    silentWindows: windows.filter((item) => item.rmsDb < -60).length,
    windows,
  };
}

const twiddles = new Map(); // size → [cos, sin] tables
/** In-place radix-2 FFT of (re, im); length is a power of two. */
function fft(re, im) {
  const n = re.length;
  if (!twiddles.has(n))
    twiddles.set(n, [
      Float64Array.from({ length: n / 2 }, (_, k) => Math.cos((-2 * Math.PI * k) / n)),
      Float64Array.from({ length: n / 2 }, (_, k) => Math.sin((-2 * Math.PI * k) / n)),
    ]);
  const [cos, sin] = twiddles.get(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size / 2,
      stride = n / size;
    for (let start = 0; start < n; start += size)
      for (let k = 0; k < half; k++) {
        const wr = cos[k * stride],
          wi = sin[k * stride];
        const a = start + k,
          b = a + half;
        const tr = re[b] * wr - im[b] * wi,
          ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
  }
}

const FRAME = 2048;
const HOP = 512;
const BANDS = 64;

/** FFT bins grouped into mel-spaced bands, so a kick drum counts as much as a cymbal. */
function melBands(rate) {
  const mel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const hz = (m) => 700 * (10 ** (m / 2595) - 1);
  const top = mel(rate / 2);
  const edges = [];
  for (let i = 0; i <= BANDS; i++) {
    const bin = Math.round((hz((top * i) / BANDS) / rate) * FRAME);
    if (!edges.length || bin > edges.at(-1)) edges.push(bin);
  }
  return edges.slice(0, -1).map((from, i) => [Math.max(1, from), Math.max(from + 1, edges[i + 1])]);
}

/** Onset strength per hop: mean positive change of the log-power mel bands (like librosa). */
export function onsetEnvelope(mono, rate) {
  const window = Float32Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const bands = melBands(rate);
  const frames = Math.max(0, Math.floor((mono.length - FRAME) / HOP) + 1);
  const spectra = new Array(frames);
  const re = new Float64Array(FRAME),
    im = new Float64Array(FRAME);
  let loudest = -Infinity;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < FRAME; i++) {
      re[i] = mono[f * HOP + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    const levels = new Float32Array(bands.length);
    bands.forEach(([from, to], band) => {
      let power = 0;
      for (let k = from; k < to; k++) power += re[k] * re[k] + im[k] * im[k];
      levels[band] = 10 * Math.log10(power / (to - from) + 1e-10);
      if (levels[band] > loudest) loudest = levels[band];
    });
    spectra[f] = levels;
  }
  // 80 dB below the loudest band is silence (power_to_db with top_db = 80).
  const floor = loudest - 80;
  const envelope = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    let flux = 0;
    for (let band = 0; band < bands.length; band++) flux += Math.max(0, Math.max(floor, spectra[f][band]) - Math.max(floor, spectra[f - 1][band]));
    envelope[f] = flux / bands.length;
  }
  return envelope;
}

/**
 * Tempo by autocorrelation of the onset envelope (weighted towards 120 BPM, as listeners
 * are), then beats by dynamic programming (Ellis 2007): onsets that keep a steady period.
 * `strength` 0–1 says how clearly periodic the music is.
 */
export function trackBeats(mono, rate, { start = 0 } = {}) {
  // The analysis (and its timing correction) is tuned for one rate.
  if (rate !== ANALYSIS_RATE) {
    mono = resample(mono, rate, ANALYSIS_RATE);
    rate = ANALYSIS_RATE;
  }
  const envelope = onsetEnvelope(mono, rate);
  const fps = rate / HOP;
  const n = envelope.length;
  const empty = { bpm: null, strength: 0, beats: [], onsets: [] };
  if (n < fps * 4) return empty;
  let mean = 0;
  for (const value of envelope) mean += value;
  mean /= n;
  let energy = 0;
  for (const value of envelope) energy += (value - mean) ** 2;
  if (energy <= 1e-9) return empty;

  // Tempo: autocorrelation between 50 and 220 BPM.
  const minLag = Math.floor((fps * 60) / 220),
    maxLag = Math.ceil((fps * 60) / 50);
  const correlation = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += (envelope[i] - mean) * (envelope[i + lag] - mean);
    correlation[lag] = sum / energy;
  }
  let best = -1,
    bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    const peak = correlation[lag] >= correlation[lag - 1] && correlation[lag] >= correlation[lag + 1];
    const score = correlation[lag] * prior * (peak ? 1 : 0.5);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Parabolic refinement of the period between frames.
  const [a, b, c] = [correlation[best - 1], correlation[best], correlation[best + 1]];
  const shift = a - 2 * b + c ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  const period = best + Math.max(-0.5, Math.min(0.5, shift));
  const strength = Math.max(0, Math.min(1, correlation[best]));

  // Beats: local score is the envelope smoothed over a fraction of the period.
  let deviation = 0;
  for (const value of envelope) deviation += value * value;
  deviation = Math.sqrt(deviation / n) || 1;
  const radius = Math.round(period);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-0.5 * (((i - radius) * 32) / period) ** 2));
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) if (t + k >= 0 && t + k < n) sum += (envelope[t + k] / deviation) * kernel[k + radius];
    local[t] = sum;
  }
  const tightness = 100;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    // Near the start a beat may be the first one: as if one more came a period earlier.
    let bestPrev = -1,
      bestValue = t < 2 * period ? 0 : -Infinity;
    for (let prev = Math.max(0, t - Math.round(2 * period)); prev <= t - Math.round(period / 2); prev++) {
      const value = score[prev] - tightness * Math.log((t - prev) / period) ** 2;
      if (value > bestValue) {
        bestValue = value;
        bestPrev = prev;
      }
    }
    score[t] = local[t] + (bestPrev >= 0 ? bestValue : 0);
    back[t] = bestPrev;
  }
  let last = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > score[last]) last = t;
  const frames = [];
  for (let t = last; t >= 0; t = back[t]) frames.unshift(t);
  // Weak beats at the ends are silence or a fade, not the music.
  const level = Math.sqrt(frames.reduce((sum, t) => sum + local[t] ** 2, 0) / Math.max(1, frames.length));
  while (frames.length && local[frames[0]] < 0.5 * level) frames.shift();
  while (frames.length && local[frames.at(-1)] < 0.5 * level) frames.pop();
  // A hit raises the flux most when it is about ¾ hop past the frame centre (measured on drum hits).
  const time = (frame) => round(start + (frame * HOP + FRAME / 2 + 0.75 * HOP) / rate);

  // Strong onsets (hits, accents): local maxima well above the typical level, ≥ 0.1 s apart.
  const sorted = Float64Array.from(envelope).sort();
  const median = sorted[Math.floor(n / 2)];
  const high = sorted[Math.floor(n * 0.98)] || 1;
  const reach = 3;
  const peaks = [];
  for (let t = reach; t < n - reach; t++) {
    const value = envelope[t];
    if (value <= median * 3 || value < high * 0.3) continue;
    let isPeak = true;
    for (let k = -reach; k <= reach && isPeak; k++) if (k && envelope[t + k] > value) isPeak = false;
    if (isPeak && (!peaks.length || t - peaks.at(-1).frame >= fps * 0.1)) peaks.push({ frame: t, value });
  }
  const onsets = peaks
    .sort((x, y) => y.value - x.value)
    .slice(0, 40)
    .sort((x, y) => x.frame - y.frame)
    .map((peak) => ({ time: time(peak.frame), strength: round(Math.min(1, peak.value / high)) }));

  return { bpm: Math.round(((60 * fps) / period) * 10) / 10, strength: round(strength), beats: frames.map(time), onsets };
}

/** Linear resampling, averaging over the source span first when going down (no aliasing to speak of). */
export function resample(input, from, to) {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  const span = Math.max(1, Math.floor(ratio));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const base = Math.floor(at);
    let sum = 0,
      count = 0;
    for (let k = 0; k < span && base + k < input.length; k++, count++)
      sum += input[base + k] + (at - base) * ((input[base + k + 1] ?? input[base + k]) - input[base + k]);
    out[i] = sum / Math.max(1, count);
  }
  return out;
}

/** Average the two channels. */
export function mixDown(left, right) {
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
  return mono;
}
