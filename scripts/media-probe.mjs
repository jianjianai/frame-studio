import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { validateLottie } from "../src/engine/lottie-document.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { localAsset } from "./check-projects.mjs";
import { projectPath } from "./project-paths.mjs";
export function mediaCommand(binary, args, { signal, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let output = "",
      errors = "";
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (v) => (output = (output + v).slice(-1024 * 1024)));
    child.stderr.on("data", (v) => (errors = (errors + v).slice(-6000)));
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              expired
                ? "Media operation timed out"
                : errors || "Media command failed: " + code,
            ),
          );
    });
  });
}
export async function probeMedia(root, id, src) {
  const file = localAsset(root, src, id),
    ext = path.extname(file).toLowerCase();
  if (
    [".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".gif"].includes(ext)
  ) {
    const m = await sharp(file).metadata();
    return {
      kind: "image",
      width: m.width,
      height: m.height,
      alpha: m.hasAlpha,
      orientation: m.orientation,
      frames: m.pages ?? 1,
    };
  }
  if (ext === ".json") {
    const data = validateLottie(JSON.parse(await fs.readFile(file, "utf8")));
    return {
      kind: "lottie",
      width: data.w,
      height: data.h,
      duration: (data.op - data.ip) / data.fr,
      fps: data.fr,
    };
  }
  const data = JSON.parse(
    await mediaCommand(process.env.FFPROBE_PATH || "ffprobe", [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]),
  );
  const video = data.streams?.find((s) => s.codec_type === "video"),
    audio = data.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(
    data.format?.duration ?? video?.duration ?? audio?.duration,
  );
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("Cannot determine media duration");
  return {
    kind: video ? "video" : "audio",
    duration,
    width: video?.width,
    height: video?.height,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    hasAudio: !!audio,
    browserDecode: "probed-at-frame-load",
    compatibleCopy:
      "pnpm film media " +
      id +
      " transcode --src " +
      src +
      " --out public/imports/compatible.webm",
  };
}
/** Writes a separate compatible copy; original and existing outputs are never replaced. */
export async function transcodeMedia(root, id, { src, out, signal }) {
  const source = localAsset(root, src, id);
  if (!out?.startsWith("public/") || !out.endsWith(".webm"))
    throw new Error("Output must be public/<name>.webm within this project");
  const target = projectPath(root, id, out);
  const cache = projectPath(root, id, ".cache/media");
  await fs.mkdir(cache, { recursive: true });
  const temp = path.join(cache, randomUUID() + ".webm");
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
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libvpx-vp9",
        "-crf",
        "28",
        "-b:v",
        "0",
        "-deadline",
        "good",
        "-cpu-used",
        "4",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "libopus",
        "-n",
        temp,
      ],
      { signal, timeout: 600000 },
    );
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.link(temp, target); // atomic no-overwrite publication
    return {
      src: "films/" + id + "/" + out.slice(7),
      path: out,
      metadata: await probeMedia(root, id, "films/" + id + "/" + out.slice(7)),
    };
  } finally {
    await fs.rm(temp, { force: true });
  }
}
