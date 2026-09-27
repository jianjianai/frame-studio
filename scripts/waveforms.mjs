import fs from "node:fs/promises";
import { projectPath, assetPath } from "./project-paths.mjs";
/** Read actual RIFF chunks. FFmpeg WAV files often contain LIST metadata before the PCM data. */
export function waveformFromWav(buffer, bins = 180) {
  if (
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("Not a RIFF WAVE file");
  let format, data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) throw new Error("Truncated WAV chunk");
    if (id === "fmt ")
      format = {
        encoding: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        bits: buffer.readUInt16LE(start + 14),
      };
    if (id === "data") data = { start, size };
    offset = start + size + (size % 2);
  }
  if (
    !format ||
    !data ||
    format.encoding !== 1 ||
    format.bits !== 16 ||
    format.channels < 1
  )
    throw new Error("Waveform indexing currently expects PCM 16-bit WAV");
  const stride = format.channels * 2,
    frames = Math.floor(data.size / stride);
  const output = [];
  for (let b = 0; b < bins; b++) {
    let peak = 0;
    const start = Math.floor((b / bins) * frames),
      end = Math.floor(((b + 1) / bins) * frames),
      step = Math.max(1, Math.floor((end - start) / 2000));
    for (let i = start; i < end; i += step)
      for (let channel = 0; channel < format.channels; channel++)
        peak = Math.max(
          peak,
          Math.abs(buffer.readInt16LE(data.start + i * stride + channel * 2)) /
            32768,
        );
    output.push(peak);
  }
  return output;
}
export async function updateWaveforms(id) {
  const entries = JSON.parse(
    await fs.readFile(
      projectPath(process.cwd(), id, "public/assets.json"),
      "utf8",
    ),
  );
  const result = {};
  for (const item of entries) {
    if (item.type !== "audio" || !item.url.toLowerCase().endsWith(".wav"))
      continue;
    try {
      result[item.url] = waveformFromWav(
        await fs.readFile(assetPath(process.cwd(), item.url, id)),
      );
    } catch (e) {
      throw new Error("[waveform] " + item.url + ": " + e.message);
    }
  }
  await fs.writeFile(
    projectPath(process.cwd(), id, "public/waveforms.json"),
    JSON.stringify(result),
  );
  return result;
}
