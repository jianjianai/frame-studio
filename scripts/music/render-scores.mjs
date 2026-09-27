import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  SoundBankLoader,
  SpessaSynthProcessor,
  SpessaLog,
} from "spessasynth_core";
import { scoreEvents, scoreMidi } from "../../src/engine/score.mjs";
import { projectPath } from "../project-paths.mjs";

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
const [id, ...extra] = process.argv.slice(2);
if (!["paper-wings", "sunny-rail", "tiny-seed"].includes(id) || extra.length)
  throw new Error("Usage: pnpm music:build <id>");
const folder = projectPath(root, id);
const cache = projectPath(root, id, ".cache/soundfonts");
const archive = projectPath(root, id, "production/music");
const exportDir = projectPath(root, id, "exports/audio");
const scoreModule = await import(
  pathToFileURL(path.join(folder, "score.mjs")).href
);
const scores = [Object.values(scoreModule)[0]()];
const { foley } = await import(
  pathToFileURL(path.join(folder, "scripts/foley.mjs")).href
);
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
  const output = projectPath(root, id, `public/audio/${score.id}.wav`);
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
let catalog = JSON.parse(
  await fs.readFile(projectPath(root, id, "public/assets.json"), "utf8"),
);
for (const score of scores) {
  const item = catalog.find(
    (a) => a.url === `films/${score.id}/audio/${score.id}.wav`,
  );
  if (item) {
    item.bytes = (
      await fs.stat(projectPath(root, id, `public/audio/${score.id}.wav`))
    ).size;
    item.license =
      "原创作曲与音效；GeneralUser GS 乐器采样，见各项目 production/music/GENERALUSER-LICENSE.txt";
  }
}
await fs.writeFile(
  projectPath(root, id, "public/assets.json"),
  JSON.stringify(catalog, null, 2),
);
await updateWaveforms(id);
console.log(
  "Scores, MIDI sources, music/foley stems, 48 kHz masters and measured loudness report written.",
);
