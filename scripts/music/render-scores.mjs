import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  SoundBankLoader,
  SpessaSynthProcessor,
  SpessaLog,
} from "spessasynth_core";
import { allScores, scoreEvents, scoreMidi } from "./scores.mjs";
import { trainProgress } from "../../src/projects/sunny-rail/motion.mjs";
import { updateWaveforms } from "../waveforms.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
process.chdir(root);
const SR = 48000;
const REV = "684543d5e5efaef08d02be50dcda8d552478fa60";
const BANK_HASH =
  "9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe";
const source = `https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/${REV}`;
const cache = path.join(root, ".cache/soundfonts");
const archive = path.join(root, "production/music");
const exportDir = path.join(root, "exports/demo-polish/audio");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (v) => {
  const x = clamp(v);
  return x * x * (3 - 2 * x);
};
const phase = (t, a, b) => clamp((t - a) / (b - a));
function run(args) {
  const p = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 300000,
  });
  if (p.error || p.status !== 0)
    throw new Error(`FFmpeg failed: ${p.error?.message || p.stderr}`);
  return p.stderr;
}
function loudness(stderr) {
  const matches = [...stderr.matchAll(/\{\s*"input_i"[\s\S]*?\}/g)];
  if (!matches.length) throw new Error("FFmpeg returned no loudness analysis");
  return JSON.parse(matches.at(-1)[0]);
}
function pcmWave(channels, sr = SR) {
  const n = channels[0].length,
    b = Buffer.alloc(44 + n * 4);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 2; c++)
      b.writeInt16LE(
        Math.round(clamp(channels[c][i], -1, 1) * 32767),
        44 + (i * 2 + c) * 2,
      );
  return b;
}
function foley(score) {
  const n = Math.round(score.duration * SR),
    out = [new Float32Array(n), new Float32Array(n)];
  let seed =
    score.id === "paper-wings" ? 1029 : score.id === "sunny-rail" ? 2851 : 6371;
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
  if (score.id === "paper-wings") {
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
  } else if (score.id === "sunny-rail") {
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
  } else {
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
  }
  return out;
}
async function bank() {
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(archive, { recursive: true });
  const file = path.join(cache, "GeneralUser-GS.sf2");
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch {}
  if (!bytes || sha(bytes) !== BANK_HASH) {
    console.log(
      "Downloading the pinned GeneralUser GS instrument bank (build-time only).",
    );
    const response = await fetch(`${source}/GeneralUser-GS.sf2`, {
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok)
      throw new Error(`Sound bank download HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha(bytes) !== BANK_HASH)
      throw new Error("Sound bank checksum mismatch");
    await fs.writeFile(file, bytes);
  }
  let license;
  try {
    license = await fs.readFile(path.join(cache, "LICENSE.txt"), "utf8");
  } catch {
    const r = await fetch(`${source}/documentation/LICENSE.txt`);
    if (!r.ok) throw new Error("Missing sound bank license");
    license = await r.text();
  }
  await fs.writeFile(path.join(archive, "GENERALUSER-LICENSE.txt"), license);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}
SpessaLog.setLogLevel(false, false, false);
const sf = await bank();
const ids = process.argv.slice(2);
const scores = allScores().filter((s) => !ids.length || ids.includes(s.id));
if (!scores.length || ids.some((id) => !allScores().some((s) => s.id === id)))
  throw new Error(
    "Use only paper-wings, sunny-rail, tiny-seed, or no arguments.",
  );
await fs.mkdir(exportDir, { recursive: true });
const reports = [];
for (const score of scores) {
  console.log(
    `Scoring ${score.id}: ${score.notes.length} notes / ${score.instruments.length} instruments`,
  );
  const synth = new SpessaSynthProcessor(SR, {
    eventsEnabled: false,
    maxBufferSize: 128,
  });
  // Each processor owns and destroys its bank; never reuse a destroyed sample cache.
  synth.soundBankManager.addSoundBank(
    SoundBankLoader.fromArrayBuffer(sf.slice(0)),
    "GeneralUser GS",
  );
  await synth.processorInitialized;
  synth.setSystemParameter("autoAllocateVoices", true);
  const events = scoreEvents(score).map((e) => ({
    ...e,
    sample: Math.round(e.t * SR),
  }));
  const n = Math.round(score.duration * SR),
    music = [new Float32Array(n), new Float32Array(n)];
  let cursor = 0,
    event = 0;
  while (cursor < n) {
    while (event < events.length && events[event].sample <= cursor)
      synth.processMessage(events[event++].data);
    const block = Math.min(
      128,
      n - cursor,
      event < events.length ? Math.max(1, events[event].sample - cursor) : 128,
    );
    synth.process(music[0], music[1], cursor, block);
    cursor += block;
  }
  synth.destroySynthProcessor();
  let sum = 0,
    peak = 0;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 2; c++) {
      const v = music[c][i];
      if (!Number.isFinite(v)) throw new Error("Non-finite audio sample");
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
  if (peak < 0.0001) throw new Error(`Silent score: ${score.id}`);
  const scale = Math.min(0.12 / Math.sqrt(sum / (n * 2)), 0.72 / peak);
  const fx = foley(score),
    mix = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 2; c++) {
      music[c][i] *= scale;
      mix[c][i] = music[c][i] + fx[c][i];
    }
  const raw = path.join(exportDir, `${score.id}-premaster.wav`);
  await fs.writeFile(raw, pcmWave(mix));
  await fs.writeFile(
    path.join(exportDir, `${score.id}-music.wav`),
    pcmWave(music),
  );
  await fs.writeFile(
    path.join(exportDir, `${score.id}-foley.wav`),
    pcmWave(fx),
  );
  const processing = `highpass=f=38,lowpass=f=16500,equalizer=f=270:t=q:w=0.7:g=-1.0,afade=t=in:d=0.035,afade=t=out:st=${score.duration - 0.8}:d=0.8`;
  const first = loudness(
    run([
      "-hide_banner",
      "-i",
      raw,
      "-af",
      `${processing},loudnorm=I=-18:LRA=11:TP=-1.8:print_format=json`,
      "-f",
      "null",
      "-",
    ]),
  );
  const norm = `loudnorm=I=-18:LRA=11:TP=-1.8:measured_I=${first.input_i}:measured_LRA=${first.input_lra}:measured_TP=${first.input_tp}:measured_thresh=${first.input_thresh}:offset=${first.target_offset}:linear=true:print_format=json`;
  const output = path.join(root, "public/audio", `${score.id}.wav`);
  run([
    "-hide_banner",
    "-y",
    "-i",
    raw,
    "-af",
    `${processing},${norm}`,
    "-ar",
    String(SR),
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    "-map_metadata",
    "-1",
    output,
  ]);
  const actual = loudness(
    run([
      "-hide_banner",
      "-i",
      output,
      "-af",
      "loudnorm=I=-18:LRA=11:TP=-1.8:print_format=json",
      "-f",
      "null",
      "-",
    ]),
  );
  if (Number(actual.input_tp) > -1.0)
    throw new Error(`Unexpected true peak for ${score.id}: ${actual.input_tp}`);
  const pcm = await fs.readFile(output);
  await fs.writeFile(path.join(archive, `${score.id}.mid`), scoreMidi(score));
  await fs.writeFile(
    path.join(archive, `${score.id}.score.json`),
    JSON.stringify(
      {
        id: score.id,
        bpm: score.bpm,
        meter: score.meter,
        duration: score.duration,
        cues: score.cues,
        instruments: score.instruments,
        notes: score.notes,
      },
      null,
      2,
    ),
  );
  reports.push({
    id: score.id,
    duration: score.duration,
    sampleRate: SR,
    channels: 2,
    bitDepth: 16,
    notes: score.notes.length,
    instruments: score.instruments.map((i) => i.name),
    integratedLUFS: Number(actual.input_i),
    truePeakDBTP: Number(actual.input_tp),
    loudnessRangeLU: Number(actual.input_lra),
    sha256: sha(pcm),
  });
  console.log(JSON.stringify(reports.at(-1)));
}
let previous = [];
try {
  previous = JSON.parse(
    await fs.readFile(path.join(archive, "render-report.json"), "utf8"),
  ).tracks;
} catch {}
await fs.writeFile(
  path.join(archive, "render-report.json"),
  JSON.stringify(
    {
      engine: "spessasynth_core 4.3.22",
      soundBank: {
        name: "GeneralUser GS 2.0.3",
        revision: REV,
        sha256: BANK_HASH,
      },
      tracks: [
        ...previous.filter((r) => !reports.some((s) => s.id === r.id)),
        ...reports,
      ],
    },
    null,
    2,
  ),
);
let catalog = JSON.parse(await fs.readFile("public/assets.json", "utf8"));
for (const score of scores) {
  const item = catalog.find((a) => a.url === `audio/${score.id}.wav`);
  if (item) {
    item.bytes = (await fs.stat(`public/audio/${score.id}.wav`)).size;
    item.license =
      "原创作曲与音效；GeneralUser GS 乐器采样，见 production/music/GENERALUSER-LICENSE.txt";
  }
}
await fs.writeFile("public/assets.json", JSON.stringify(catalog, null, 2));
await updateWaveforms();
console.log(
  "Scores, MIDI sources, music/foley stems, 48 kHz masters and measured loudness report written.",
);
