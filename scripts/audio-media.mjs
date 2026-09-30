import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { localAsset } from "./check-projects.mjs";
import { projectPath } from "./project-paths.mjs";
import { mediaCommand, probeMedia } from "./media-probe.mjs";
export async function transcodeAudio(root, id, { src, out, signal }) {
  const source = localAsset(root, src, id),
    ext = path.extname(out ?? "").toLowerCase();
  const codecs = {
    ".wav": ["pcm_s24le"],
    ".flac": ["flac"],
    ".mp3": ["libmp3lame", "-b:a", "192k"],
    ".ogg": ["libopus", "-b:a", "160k"],
    ".m4a": ["aac", "-b:a", "192k"],
  };
  if (!out?.startsWith("public/") || !codecs[ext])
    throw Error("Choose public/<file>.wav|flac|mp3|ogg|m4a");
  const target = projectPath(root, id, out),
    cache = projectPath(root, id, ".cache/audio-media");
  await fs.mkdir(cache, { recursive: true });
  const temp = path.join(cache, randomUUID() + ext);
  try {
    await mediaCommand(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        source,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-c:a",
        ...codecs[ext],
        "-n",
        temp,
      ],
      { signal, timeout: 600000 },
    );
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.link(temp, target);
    const url = "films/" + id + "/" + out.slice(7);
    return { src: url, path: out, metadata: await probeMedia(root, id, url) };
  } finally {
    await fs.rm(temp, { force: true });
  }
}
