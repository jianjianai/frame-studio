import { updateWaveforms } from "./waveforms.mjs";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
const manifest = args[0];
if (!manifest || manifest.startsWith("--")) {
  console.error("Usage: pnpm audio:mix path/to/mix.json [--force]");
  process.exit(1);
}
let temporary;
try {
  const base = path.dirname(path.resolve(manifest));
  const spec = JSON.parse(await fs.readFile(manifest, "utf8"));
  const numeric = (value, min, max, name) => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max
    )
      throw new Error("Invalid " + name);
    return value;
  };
  const duration = numeric(spec.duration, 0.1, 3600, "duration");
  if (typeof spec.output !== "string" || !spec.output.endsWith(".wav"))
    throw new Error(
      "output must name a WAV file, relative to the mix manifest",
    );
  if (
    !Array.isArray(spec.tracks) ||
    spec.tracks.length < 1 ||
    spec.tracks.length > 32
  )
    throw new Error("Use 1..32 audio tracks");
  const output = path.resolve(base, spec.output);
  if (existsSync(output) && !args.includes("--force"))
    throw new Error("Output already exists. Use --force explicitly.");
  await fs.mkdir(path.dirname(output), { recursive: true });
  temporary = path.join(path.dirname(output), ".mix-" + randomUUID() + ".wav");
  const command = ["-hide_banner", "-loglevel", "warning"];
  const filters = [];
  for (let i = 0; i < spec.tracks.length; i++) {
    const track = spec.tracks[i];
    if (typeof track.file !== "string")
      throw new Error("track.file is required");
    const file = path.resolve(base, track.file);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("Not a regular audio file: " + file);
    command.push("-i", file);
    const start = numeric(track.start ?? 0, 0, duration, "track.start");
    const trim = numeric(track.trimStart ?? 0, 0, 3600, "track.trimStart");
    const gain = numeric(track.gain ?? 1, 0, 4, "track.gain");
    const length = numeric(
      track.duration ?? duration - start,
      0.01,
      duration - start,
      "track.duration",
    );
    const fadeIn = numeric(track.fadeIn ?? 0, 0, length, "track.fadeIn");
    const fadeOut = numeric(track.fadeOut ?? 0, 0, length, "track.fadeOut");
    let chain =
      "[" +
      i +
      ":a]atrim=start=" +
      trim +
      ":duration=" +
      length +
      ",asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=" +
      gain;
    if (fadeIn > 0) chain += ",afade=t=in:st=0:d=" + fadeIn;
    if (fadeOut > 0)
      chain += ",afade=t=out:st=" + (length - fadeOut) + ":d=" + fadeOut;
    chain += ",adelay=" + Math.round(start * 1000) + ":all=1[a" + i + "]";
    filters.push(chain);
  }
  filters.push(
    spec.tracks.map((_, i) => "[a" + i + "]").join("") +
      "amix=inputs=" +
      spec.tracks.length +
      ":duration=longest:normalize=0,alimiter=limit=0.95:level=0:latency=1,apad=whole_dur=" +
      duration +
      ",atrim=duration=" +
      duration +
      "[mix]",
  );
  command.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[mix]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-t",
    String(duration),
    "-y",
    temporary,
  );
  let stderr = "";
  await new Promise((resolve, reject) => {
    const process = spawn(
      globalThis.process.env.FFMPEG_PATH || "ffmpeg",
      command,
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    process.stderr.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    process.on("error", reject);
    process.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("FFmpeg audio mix failed: " + stderr)),
    );
  });
  await fs.rename(temporary, output);
  temporary = undefined;
  const relative = path.relative(path.resolve("public"), output);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    const index = "public/assets.json";
    let items = [];
    try {
      items = JSON.parse(await fs.readFile(index, "utf8"));
    } catch {}
    const url = relative.replaceAll(path.sep, "/");
    items = items.filter((a) => a.url !== url);
    items.push({
      name: path.basename(output),
      url,
      type: "audio",
      bytes: (await fs.stat(output)).size,
      license:
        typeof spec.license === "string"
          ? spec.license
          : "混音：发布前核实所有源音轨的授权",
    });
    await fs.writeFile(index, JSON.stringify(items, null, 2));
  }
  await updateWaveforms();
  await fs.writeFile(
    output + ".mix.json",
    JSON.stringify(
      {
        duration,
        tracks: spec.tracks,
        output,
        createdAt: new Date().toISOString(),
        warnings: stderr,
      },
      null,
      2,
    ),
  );
  console.log(
    "Mixed " +
      spec.tracks.length +
      " tracks -> " +
      output +
      " (" +
      duration +
      "s, stereo 48 kHz WAV)",
  );
} catch (e) {
  console.error(e.stack || String(e));
  process.exitCode = 1;
} finally {
  if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
}
