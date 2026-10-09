import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { problem } from "./util.mjs";
import { ffmpegExecutable } from "./render.mjs";

/**
 * Sound an AI cannot hear, as numbers: loudness per window, and for music the tempo, the
 * beats and the bars (Beat This!), so cuts and changes can land on the music.
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

let queue = Promise.resolve(); // one model run at a time: each takes several cores

/**
 * Beats and downbeats (first beat of each bar) of mono PCM, by the Beat This! model run in
 * Python (server/beat-this/analyze.py). Times are shifted by `start`. `modelsDir` is where
 * the model is downloaded on first use, unless TORCH_HOME says otherwise (the image has it).
 */
export function beatThis(mono, rate, { start = 0, modelsDir } = {}) {
  const run = queue.then(() => runBeatThis(mono, rate, modelsDir));
  queue = run.catch(() => {});
  return run.then(({ beats, downbeats }) =>
    describeRhythm(
      beats.map((t) => round(t + start)),
      downbeats.map((t) => round(t + start)),
    ),
  );
}

function runBeatThis(mono, rate, modelsDir) {
  const python = process.env.FRAME_BEAT_PYTHON || "python3";
  const script = fileURLToPath(new URL("./beat-this/analyze.py", import.meta.url));
  const missing = () =>
    problem(
      503,
      "节拍分析需要 Beat This!（Python + PyTorch）。Docker 镜像里已经装好；在本机运行时按 server/beat-this/requirements.txt 装进一个 Python 环境，再用 FRAME_BEAT_PYTHON 指向它的 python。",
      "NO_BEAT_THIS",
    );
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, String(rate)], {
      windowsHide: true,
      env: { ...process.env, TORCH_HOME: process.env.TORCH_HOME || modelsDir, PYTHONUNBUFFERED: "1" },
    });
    const out = [];
    let errors = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60 * 1000);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.stdin.on("error", () => {}); // the process may end before reading everything
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? missing() : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          return resolve(JSON.parse(Buffer.concat(out).toString("utf8")));
        } catch {}
      }
      if (/No module named '?(beat_this|torch|torchaudio|numpy|soxr)/.test(errors)) return reject(missing());
      // The last line that is not a download progress figure.
      const reason = errors
        .split(/[\r\n]+/)
        .filter((line) => line.trim() && !/^\s*[\d.]+%\s*$/.test(line))
        .pop();
      reject(problem(500, `节拍分析失败：${reason || `退出码 ${code}`}`, "BEAT_ANALYSIS_FAILED"));
    });
    child.stdin.end(Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength));
  });
}

/** Tempo from the median beat interval; beats per bar from the beats between downbeats. */
export function describeRhythm(beats, downbeats) {
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const intervals = beats.slice(1).map((time, index) => time - beats[index]);
  const counts = downbeats.slice(1).map((end, index) => beats.filter((time) => time >= downbeats[index] - 0.03 && time < end - 0.03).length);
  const tally = new Map();
  for (const count of counts) tally.set(count, (tally.get(count) ?? 0) + 1);
  const beatsPerBar = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { bpm: intervals.length ? Math.round((60 / median(intervals)) * 10) / 10 : null, beatsPerBar, beats, downbeats };
}

/** Average the two channels. */
export function mixDown(left, right) {
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
  return mono;
}
