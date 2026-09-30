import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { projectPath } from "./project-paths.mjs";
import { readProject } from "./project-metadata.mjs";
import {
  captureInput,
  inputManifest,
  fileSha256 as digest,
} from "./production-input.mjs";
import { createRenderSession, framePng } from "./render-session.mjs";
import { runProcess } from "./project-execution.mjs";

const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = () => process.env.FFPROBE_PATH || "ffprobe";
const json = (file, data) =>
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
export async function checkedProcess(command, args, options = {}) {
  const result = await runProcess(command, args, options);
  if (result.status !== "passed")
    throw new Error(result.output || `${command} failed: ${result.exitCode}`);
  return result.output;
}
export async function probeMedia(file) {
  return JSON.parse(
    await checkedProcess(ffprobe(), [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]),
  );
}
export async function analyzeAudio(file) {
  const output = await checkedProcess(ffmpeg(), [
    "-hide_banner",
    "-nostats",
    "-i",
    file,
    "-vn",
    "-af",
    "loudnorm=print_format=json,silencedetect=noise=-60dB:d=0.3",
    "-f",
    "null",
    "-",
  ]);
  const match = output.match(/\{\s*"input_i"[\s\S]*?\}/);
  const loudness = match ? JSON.parse(match[0]) : null;
  return {
    status: "passed",
    integratedLufs: loudness?.input_i ?? null,
    truePeakDb: loudness?.input_tp ?? null,
    loudnessRange: loudness?.input_lra ?? null,
    silence: output.split("\n").filter((line) => line.includes("silence_")),
    raw: output,
    listening: "not_run",
  };
}
function ownFile(root, id, file) {
  const folder = projectPath(root, id);
  return projectPath(root, id, path.relative(folder, path.resolve(root, file)));
}
export async function verifyDelivery(
  root,
  id,
  { file, outputDirectory, expected } = {},
) {
  const input = ownFile(root, id, file);
  const directory =
    outputDirectory ??
    projectPath(root, id, "exports/verification-" + randomUUID());
  ownFile(root, id, directory);
  fs.mkdirSync(directory, { recursive: true });
  const report = {
    schemaVersion: 1,
    project: id,
    file: input,
    sha256: digest(input),
    engineering: { status: "not_run" },
    runtime: { status: "not_run" },
    media: { status: "failed" },
    contentReview: { visual: "not_run", listening: "not_run" },
  };
  try {
    const probe = await probeMedia(input);
    const video = probe.streams.find((s) => s.codec_type === "video");
    const audio = probe.streams.find((s) => s.codec_type === "audio");
    if (!video) throw new Error("No video stream");
    const render = fs.existsSync(input + ".render.json")
      ? JSON.parse(fs.readFileSync(input + ".render.json", "utf8"))
      : null;
    const spec = expected ?? render;
    const failures = [];
    for (const [key, value] of [
      ["width", video.width],
      ["height", video.height],
      ["frames", Number(video.nb_read_frames)],
    ])
      if (spec?.[key] !== undefined && spec[key] !== value)
        failures.push(`Unexpected ${key}: ${value} != ${spec[key]}`);
    const duration = Number(video.duration ?? probe.format.duration);
    const frameRate = video.avg_frame_rate
      .split("/")
      .map(Number)
      .reduce((a, b) => a / b);
    if (spec?.fps && Math.abs(frameRate - spec.fps) > 0.001)
      failures.push("Unexpected frame rate");
    if (
      spec?.duration &&
      Math.abs(duration - spec.duration) > Math.max(0.05, 1 / frameRate)
    )
      failures.push("Unexpected video duration");
    if (
      spec?.audio &&
      (!Array.isArray(spec.audio) || spec.audio.length) &&
      !audio
    )
      failures.push("Missing audio stream");
    if (audio?.duration && Math.abs(Number(audio.duration) - duration) > 0.12)
      failures.push("Audio/video duration mismatch");
    await checkedProcess(ffmpeg(), [
      "-v",
      "error",
      "-xerror",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-f",
      "null",
      "-",
    ]);
    report.media = {
      status: failures.length ? "failed" : "passed",
      probe,
      failures,
      decodedFrames: Number(video.nb_read_frames),
      fullDecode: "passed",
      audio: audio ? await analyzeAudio(input) : { status: "not_applicable" },
    };
    report.version = render?.input
      ? {
          recorded: render.input.fingerprint,
          current: inputManifest(root, id).fingerprint,
          matches:
            render.input.fingerprint === inputManifest(root, id).fingerprint,
        }
      : { matches: null, reason: "No input manifest accompanies this media" };
    report.frames = [];
    for (const [index, time] of [
      0,
      duration / 2,
      Math.max(0, duration - 1 / frameRate),
    ].entries()) {
      const image = path.join(directory, `final-${index}.png`);
      await checkedProcess(ffmpeg(), [
        "-v",
        "error",
        "-i",
        input,
        "-ss",
        String(time),
        "-frames:v",
        "1",
        "-y",
        image,
      ]);
      report.frames.push({ time, file: image });
    }
    report.status = failures.length ? "failed" : "passed";
  } catch (error) {
    report.status = "failed";
    report.media.error = error.message;
  }
  json(path.join(directory, "verification.json"), report);
  return { ...report, report: path.join(directory, "verification.json") };
}

export async function writeAudio(page, file, start, duration, trackId, format="pcm16") {
  const stride=format==="float32"?8:4;
  const samples = Math.round(duration * 48000);
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + samples * stride, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format==="float32"?3:1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000*stride, 28);
  header.writeUInt16LE(stride, 32);
  header.writeUInt16LE(format==="float32"?32:16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples * stride, 40);
  const handle = fs.openSync(file, "wx");
  try {
    fs.writeSync(handle, header);
    for (let sample = 0; sample < samples; sample += 480000) {
      const count = Math.min(480000, samples - sample);
      const data = await page.evaluate(
        ({ at, seconds, track,format }) =>
          window.__FRAME_STUDIO__.audioChunk(at, seconds, track,format),
        { at: start + sample / 48000, seconds: count / 48000, track: trackId,format },
      );
      const bytes = Buffer.from(data, "base64");
      if (bytes.length !== count * stride) throw new Error("Unexpected PCM length");
      fs.writeSync(handle, bytes);
    }
  } finally {
    fs.closeSync(handle);
  }
}

export async function reviewSegment(root, id, options = {}) {
  const snapshot = captureInput(root, id);
  const { meta } = readProject(projectPath(snapshot.root, id, "project.ts"));
  const start = options.start ?? 0,
    end = options.end ?? Math.min(meta.duration, start + 6);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > meta.duration
  ) {
    snapshot.close();
    throw new Error("Invalid review range");
  }
  const reviewId = randomUUID();
  const directory = projectPath(root, id, "exports/reviews/" + reviewId);
  fs.mkdirSync(directory, { recursive: true });
  let session;
  try {
    const width = options.width ?? 640,
      fps = options.fps ?? meta.fps;
    const temporaryVideo = projectPath(snapshot.root, id, "exports/clip.mp4");
    await checkedProcess(
      process.execPath,
      [
        path.join(snapshot.root, "scripts/render.mjs"),
        id,
        "--width",
        String(width),
        "--fps",
        String(fps),
        "--start",
        String(start),
        "--end",
        String(end),
        "--out",
        temporaryVideo,
      ],
      { root: snapshot.root, onLog: options.onLog },
    );
    fs.copyFileSync(temporaryVideo, path.join(directory, "clip.mp4"));
    const render = JSON.parse(
      fs.readFileSync(temporaryVideo + ".render.json", "utf8"),
    );
    render.input = snapshot.manifest;
    render.output = path.join(directory, "clip.mp4");
    json(path.join(directory, "clip.mp4.render.json"), render);
    session = await createRenderSession({ root: snapshot.root, width });
    const page = await session.page(id);
    const count = Math.min(24, Math.max(2, Math.ceil((end - start) * 2)));
    const images = [],
      frames = [];
    for (let i = 0; i < count; i++) {
      const time =
        start + (i * Math.max(0, end - start - 1 / fps)) / (count - 1);
      const image = await framePng(page, time, options.subtitles !== false);
      images.push(image);
      frames.push({
        time,
        frame: Math.floor(time * fps),
        file: `frame-${i}.png`,
      });
      fs.writeFileSync(path.join(directory, `frame-${i}.png`), image);
    }
    const layers = [];
    const thumbnailWidth = 320,
      thumbnailHeight = 180,
      label = 28;
    for (const [index, image] of images.entries()) {
      const left = (index % 3) * thumbnailWidth,
        top = Math.floor(index / 3) * (thumbnailHeight + label);
      layers.push({
        input: await sharp(image)
          .resize(thumbnailWidth, thumbnailHeight)
          .toBuffer(),
        left,
        top,
      });
      layers.push({
        input: Buffer.from(
          `<svg width="320" height="28"><text x="8" y="20" fill="white" font-size="16">${frames[index].time.toFixed(3)} s</text></svg>`,
        ),
        left,
        top: top + thumbnailHeight,
      });
    }
    await sharp({
      create: {
        width: 960,
        height: Math.ceil(count / 3) * 208,
        channels: 3,
        background: "#202725",
      },
    })
      .composite(layers)
      .png()
      .toFile(path.join(directory, "storyboard.png"));
    // Revisit the same time after seeking elsewhere; tolerate only tiny GPU rounding.
    const repeated = await framePng(
      page,
      frames[0].time,
      options.subtitles !== false,
    );
    const a = await sharp(images[0]).raw().toBuffer(),
      b = await sharp(repeated).raw().toBuffer();
    let maxDelta = 0,
      changed = 0;
    for (let i = 0; i < a.length; i++) {
      const delta = Math.abs(a[i] - b[i]);
      maxDelta = Math.max(maxDelta, delta);
      if (delta) changed++;
    }
    const runtime = {
      status:
        maxDelta <= 1 && changed / a.length < 0.0001 ? "passed" : "failed",
      repeatFrame: {
        maxDelta,
        changedChannels: changed,
        totalChannels: a.length,
      },
      diagnostics: page.frameDiagnostics(),
    };
    const tracks =
      meta.audioDocument?.tracks ?? meta.audioTracks ?? (meta.audio ? [{ id: "main", name: "main" }] : []);
    const audio = [];
    for (const track of [{ id: null, name: "mix" }, ...tracks]) {
      const name = track.id ? `track-${track.id}.wav` : "mix.wav";
      await writeAudio(
        page,
        path.join(directory, name),
        start,
        end - start,
        track.id ?? undefined,
      );
      audio.push({
        track: track.id,
        name,
        analysis: await analyzeAudio(path.join(directory, name)),
      });
    }
    const stamp = (seconds) => {
      const ms = Math.round(seconds * 1000);
      return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
    };
    const subtitles = meta.subtitles
      .filter((cue) => cue.end > start && cue.start < end)
      .map((cue) => ({
        ...cue,
        start: Math.max(0, cue.start - start),
        end: Math.min(end - start, cue.end - start),
      }));
    fs.writeFileSync(
      path.join(directory, "captions.srt"),
      subtitles
        .map(
          (cue, i) =>
            `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}`,
        )
        .join("\n\n"),
    );
    const report = {
      schemaVersion: 1,
      reviewId,
      project: id,
      input: snapshot.manifest,
      start,
      end,
      width,
      fps,
      frames,
      audio,
      runtime,
      contentReview: { visual: "not_run", listening: "not_run", notes: [] },
    };
    json(path.join(directory, "review.json"), report);
    fs.writeFileSync(
      path.join(directory, "index.html"),
      `<!doctype html><meta charset="utf-8"><title>片段审阅</title><style>body{background:#111;color:#eee;font:16px system-ui;margin:24px}video,img{max-width:100%}section{margin:24px 0}</style><h1>${escape(meta.title)} · ${start}–${end} 秒</h1><p>输入 ${snapshot.manifest.fingerprint.slice(0, 12)} · 技术检查不代表内容已审阅</p><video controls loop src="clip.mp4"></video><section>${audio.map((t) => `<p>${escape(t.track ?? "混音")}</p><audio controls src="${escape(t.name)}"></audio>`).join("")}</section><img src="storyboard.png"><p><a href="review.json">审片信息</a> · <a href="captions.srt">字幕</a></p>`,
    );
    return {
      status: runtime.status,
      reviewId,
      directory,
      input: snapshot.manifest.fingerprint,
      page: path.join(directory, "index.html"),
      report: path.join(directory, "review.json"),
    };
  } catch (error) {
    json(path.join(directory, "failure.json"), {
      status: "failed",
      error: error.message,
      input: snapshot.manifest.fingerprint,
    });
    throw error;
  } finally {
    try {
      await session?.close();
    } finally {
      snapshot.close();
    }
  }
}

export function compareReviews(root, id, a, b) {
  const read = (key) => {
    if (!/^[\da-f-]{36}$/.test(key)) throw new Error("Invalid review id");
    return JSON.parse(
      fs.readFileSync(
        projectPath(root, id, "exports/reviews/" + key + "/review.json"),
        "utf8",
      ),
    );
  };
  const left = read(a),
    right = read(b);
  if (left.start !== right.start || left.end !== right.end)
    throw new Error("A/B reviews must cover the same time range");
  const directory = projectPath(
    root,
    id,
    "exports/comparisons/" + randomUUID(),
  );
  fs.mkdirSync(directory, { recursive: true });
  const html = `<!doctype html><meta charset="utf-8"><title>A/B 片段比较</title><style>body{background:#111;color:white;font:16px system-ui;margin:24px}main{display:flex;gap:16px}section{width:50%}video{width:100%}</style><h1>同一片段 A/B 比较 · ${left.start}–${left.end}s</h1><button id="play">同步循环播放</button><button id="pause">暂停</button><main>${[a, b].map((key, i) => `<section><h2>${i ? "B" : "A"} · ${[left, right][i].input.fingerprint.slice(0, 12)}</h2><video controls loop src="../../reviews/${key}/clip.mp4" ${i ? "muted" : ""}></video></section>`).join("")}</main><p>默认只播放 A 的声音，使用播放器控制切换试听。内容结论需实际审阅后记录。</p><script>const v=[...document.querySelectorAll('video')];document.querySelector('#play').onclick=()=>{v.forEach(x=>{x.currentTime=0;x.play()})};document.querySelector('#pause').onclick=()=>v.forEach(x=>x.pause());</script>`;
  fs.writeFileSync(path.join(directory, "index.html"), html);
  return {
    status: "passed",
    page: path.join(directory, "index.html"),
    a: left.input.fingerprint,
    b: right.input.fingerprint,
  };
}
export function recordReview(
  root,
  id,
  reviewId,
  { reviewer, visual = false, listening = false, time, note },
) {
  if (!/^[\da-f-]{36}$/.test(reviewId) || !reviewer || !note)
    throw new Error("Review id, reviewer and note are required");
  const file = projectPath(
    root,
    id,
    "exports/reviews/" + reviewId + "/review.json",
  );
  const review = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Number.isFinite(time) || time < review.start || time > review.end)
    throw new Error("Note time must be inside this review");
  const record = {
    reviewId,
    input: review.input.fingerprint,
    reviewer,
    time,
    note,
    visual,
    listening,
    recordedAt: new Date().toISOString(),
  };
  const target = projectPath(
    root,
    id,
    "records/reviews/" + randomUUID() + ".json",
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  json(target, record);
  return { status: "recorded", record: target, ...record };
}
