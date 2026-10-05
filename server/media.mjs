import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Input, FilePathSource, ALL_FORMATS } from "mediabunny";
import { mediaKind, mimeType } from "./util.mjs";

const cache = new Map();

/** Duration, dimensions and codecs of a media file; cached by size+mtime. */
export async function probe(file) {
  const stat = fs.statSync(file);
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  const kind = mediaKind(file);
  const info = { kind, mime: mimeType(file), size: stat.size };
  try {
    if (kind === "image" && path.extname(file).toLowerCase() !== ".svg") {
      const meta = await sharp(file, { animated: true }).metadata();
      Object.assign(info, { width: meta.width, height: meta.pageHeight || meta.height, frames: meta.pages || 1 });
    } else if (kind === "audio" || kind === "video") {
      const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
      try {
        info.duration = Math.round((await input.computeDuration()) * 1000) / 1000;
        const video = await input.getPrimaryVideoTrack();
        const audio = await input.getPrimaryAudioTrack();
        if (video) Object.assign(info, { width: video.displayWidth, height: video.displayHeight, videoCodec: video.codec });
        if (audio) Object.assign(info, { audioCodec: audio.codec, sampleRate: audio.sampleRate, channels: audio.numberOfChannels });
      } finally {
        input.dispose?.();
      }
    }
    // .webm/.mp4 may hold only sound (microphone recordings).
    if (info.kind === "video" && !info.width && info.audioCodec) info.kind = "audio";
  } catch (error) {
    info.probeError = error.message;
  }
  cache.set(key, info);
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return info;
}
