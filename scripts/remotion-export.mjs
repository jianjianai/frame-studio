import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { checkedProcess, writeAudio, probeMedia } from "./production-media.mjs";

const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg";
const hasFrameAudio = (meta) =>
  Boolean(
    meta.audio ||
    meta.audioTracks?.length ||
    meta.audioDocument ||
    meta.visual?.clips?.some(
      (c) => c.source.kind === "video" && c.audio?.enabled && !c.hidden,
    ),
  );
/** Preserve Remotion's native media audio and mix the existing Frame graph exactly once. */
export async function writeRemotionAudio(
  page,
  file,
  start,
  duration,
  meta,
  format = "pcm16",
  nativeOnly = false,
) {
  const native = file + "." + randomUUID() + ".native.wav",
    frame = file + "." + randomUUID() + ".frame.wav";
  const reservation = await fs.open(file, "wx");
  await reservation.close();
  let success = false;
  try {
    const rendered = await page.remotion.audio({
      output: native,
      start,
      end: Math.min(meta.duration, start + duration),
    });
    const args = [
      "-v",
      "error",
      "-ss",
      String(Math.max(0, start - rendered.start)),
      "-i",
      native,
    ];
    if (!nativeOnly && hasFrameAudio(meta)) {
      await writeAudio(
        page,
        frame,
        start,
        duration,
        undefined,
        "float32",
        true,
      );
      args.push(
        "-i",
        frame,
        "-filter_complex",
        "[0:a][1:a]amix=inputs=2:normalize=0:duration=longest,apad[a]",
        "-map",
        "[a]",
      );
    } else args.push("-af", "apad");
    args.push(
      "-t",
      String(duration),
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      format === "float32" ? "pcm_f32le" : "pcm_s16le",
      "-y",
      file,
    );
    await checkedProcess(ffmpeg(), args);
    success = true;
  } finally {
    await fs.rm(native, { force: true });
    await fs.rm(frame, { force: true });
    if (!success) await fs.rm(file, { force: true });
  }
}
export async function renderRemotionVideo({
  page,
  meta,
  plan,
  output,
  subtitles,
  input,
}) {
  const native = path.join(
    path.dirname(output),
    ".remotion-" + randomUUID() + ".mp4",
  );
  const audio = native + ".wav",
    frame = native + ".frame.wav",
    temporary = native + ".final.mp4";
  const began = Date.now();
  try {
    const rendered = await page.remotion.video({
      output: native,
      start: plan.start,
      end: plan.end,
      subtitles,
      onProgress: ({ renderedFrames }) => {
        if (renderedFrames % meta.fps === 0)
          console.log("Remotion frame " + renderedFrames);
      },
    });
    const offset = Math.max(0, plan.start - rendered.start);
    const args = [
      "-v",
      "error",
      "-i",
      native,
      "-ss",
      String(offset),
      "-i",
      audio,
    ];
    if (hasFrameAudio(meta)) {
      await writeAudio(
        page,
        frame,
        plan.start,
        plan.duration,
        undefined,
        "pcm16",
        true,
      );
      args.push(
        "-i",
        frame,
        "-filter_complex",
        "[1:a][2:a]amix=inputs=2:normalize=0:duration=longest,apad[a]",
        "-map",
        "0:v:0",
        "-map",
        "[a]",
      );
    } else args.push("-map", "0:v:0", "-map", "1:a:0", "-af", "apad");
    args.push(
      "-vf",
      "setpts=PTS-STARTPTS-" +
        offset +
        "/TB,fps=" +
        plan.fps +
        ":round=up:start_time=0,tpad=stop_mode=clone:stop_duration=1",
      "-frames:v",
      String(plan.frames),
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-t",
      String(plan.duration),
      "-movflags",
      "+faststart",
      "-y",
      temporary,
    );
    await checkedProcess(ffmpeg(), args);
    const probe = await probeMedia(temporary),
      video = probe.streams.find((s) => s.codec_type === "video");
    if (
      Number(video?.nb_read_frames) !== plan.frames ||
      video.width !== plan.width ||
      video.height !== plan.height ||
      !probe.streams.some((s) => s.codec_type === "audio")
    )
      throw Error(
        "Remotion output verification failed: dimensions, frame count or audio",
      );
    await fs.rename(temporary, output);
    await fs.writeFile(
      output + ".render.json",
      JSON.stringify(
        {
          project: meta.id,
          renderer: "remotion",
          ...plan,
          input,
          output,
          subtitles,
          audio: "remotion+frame",
          ffprobe: probe,
          elapsedSeconds: (Date.now() - began) / 1000,
        },
        null,
        2,
      ),
    );
    console.log("Verified Remotion output: " + output);
  } finally {
    for (const file of [native, audio, frame, temporary])
      await fs.rm(file, { force: true });
  }
}
