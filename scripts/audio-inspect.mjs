import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { localAsset } from "./check-projects.mjs";
import { probeMedia } from "./media-probe.mjs";
const cache = new Map();
/** Streaming full-band stereo peaks; no complete PCM recording is retained. */
export async function inspectAudio(root, id, src, { signal } = {}) {
  const file = localAsset(root, src, id),
    stat = await fs.stat(file),
    key = file + ":" + stat.size + ":" + stat.mtimeMs;
  if (cache.has(key)) return cache.get(key);
  const metadata = await probeMedia(root, id, src);
  if (!metadata.hasAudio || metadata.duration > 3600)
    throw Error(
      "Audio inspection requires a source between 0 and 3600 seconds",
    );
  const bins = 512,
    peaks = new Float32Array(bins),
    frames = Math.ceil(metadata.duration * 48000);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { signal, stdio: ["ignore", "pipe", "pipe"] },
    );
    let leftover = Buffer.alloc(0),
      samples = 0,
      sum = 0,
      peak = 0,
      clipped = 0,
      errors = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.stdout.on("data", (chunk) => {
      const b = leftover.length ? Buffer.concat([leftover, chunk]) : chunk,
        end = b.length - (b.length % 4);
      for (let i = 0; i < end; i += 4) {
        const value = b.readFloatLE(i),
          a = Math.abs(value),
          bin = Math.min(bins - 1, Math.floor((samples / 2 / frames) * bins));
        peaks[bin] = Math.max(peaks[bin], a);
        peak = Math.max(peak, a);
        sum += value * value;
        if (a >= 1) clipped++;
        samples++;
      }
      leftover = Buffer.from(b.subarray(end));
    });
    child.stderr.on("data", (d) => (errors = (errors + d).slice(-4000)));
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(Error(errors || "Audio inspection timed out"));
      resolve({
        ...metadata,
        peaks: Array.from(peaks),
        samplePeak: peak,
        peakDb: peak ? 20 * Math.log10(peak) : null,
        rmsDb: sum ? 10 * Math.log10(sum / samples) : null,
        clippedSamples: clipped,
      });
    });
  });
  cache.set(key, result);
  while (cache.size > 32) cache.delete(cache.keys().next().value);
  return result;
}
