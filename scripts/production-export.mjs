import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectPath } from "./project-paths.mjs";
import {
  captureInput,
  inputManifest,
  fileSha256 as sha,
} from "./production-input.mjs";
import { readProject } from "./project-metadata.mjs";
import { createExportPlan } from "../src/engine/export-plan.mjs";
import {
  checkedProcess,
  probeMedia,
  writeAudio,
  verifyDelivery,
} from "./production-media.mjs";
import { createRenderSession } from "./render-session.mjs";
import { runtimeIdentity } from "./runtime-identity.mjs";
import { browserOptions } from "./browser.mjs";

/** Durable segment files are reusable only with the same complete input and parameters. */
export async function exportProduction(root, id, options = {}) {
  const renderId = options.resume ?? randomUUID();
  if (!/^[a-f\d-]{36}$/.test(renderId)) throw new Error("Invalid resume id");
  const directory = projectPath(root, id, "exports/renders/" + renderId);
  if (options.resume && !fs.existsSync(path.join(directory, "manifest.json")))
    throw new Error("Unknown render to resume");
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, "render.lock"),
    token = randomUUID();
  let handle;
  try {
    handle = fs.openSync(lock, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      "Render is already active or has a crash lock; inspect before recovery: " +
        lock,
    );
  }
  try {
    fs.writeFileSync(
      handle,
      JSON.stringify({
        pid: process.pid,
        token,
        task: process.env.FRAME_TASK_ID ?? null,
      }),
    );
    fs.closeSync(handle);
    handle = undefined;
    return await runExport(root, id, options, renderId);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (
      fs.existsSync(lock) &&
      JSON.parse(fs.readFileSync(lock, "utf8")).token === token
    )
      fs.unlinkSync(lock);
  }
}

async function runExport(root, id, options, renderId) {
  const { meta } = readProject(projectPath(root, id, "project.ts"));
  const input = inputManifest(root, id);
  const runtime = { ...(await runtimeIdentity(root)), browserExecutableSha256: sha(browserOptions().executablePath), image: process.env.FRAME_RUNTIME_IMAGE || null,
    ffmpeg: (await checkedProcess(process.env.FFMPEG_PATH || "ffmpeg", ["-version"])).split("\n")[0] };
  const plan = createExportPlan({
    duration: meta.duration,
    width: options.width ?? 1920,
    fps: options.fps ?? meta.fps,
    start: options.start ?? 0,
    end: options.end ?? meta.duration,
  });
  const segmentSeconds = options.segmentSeconds ?? 10;
  if (
    !Number.isFinite(segmentSeconds) ||
    segmentSeconds < 0.25 ||
    segmentSeconds > 60
  )
    throw new Error("Segment duration must be 0.25..60 seconds");
  const directory = projectPath(root, id, "exports/renders/" + renderId);
  const manifestFile = path.join(directory, "manifest.json");
  const config = {
    ...plan,
    segmentFrames: Math.max(1, Math.round(segmentSeconds * plan.fps)),
    subtitles: options.subtitles !== false,
  };
  let manifest;
  if (options.resume) {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (
      manifest.input.fingerprint !== input.fingerprint ||
      JSON.stringify(manifest.runtime) !== JSON.stringify(runtime) ||
      JSON.stringify(manifest.config) !== JSON.stringify(config)
    )
      throw new Error(
        "Resume input or export parameters changed; start a new render",
      );
  } else {
    fs.mkdirSync(directory, { recursive: true });
    manifest = {
      schemaVersion: 1,
      renderId,
      project: id,
      input,
      runtime,
      config,
      segments: [],
      status: "preparing",
      preflight: "not_run",
    };
  }
  const save = () => {
    const temporary = manifestFile + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2));
    fs.renameSync(temporary, manifestFile);
  };
  save();
  let snapshot, session;
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const render = async (start, end, name) => {
    const file = projectPath(snapshot.root, id, "exports/" + name + ".mp4");
    await checkedProcess(
      process.execPath,
      [
        path.join(snapshot.root, "scripts/render.mjs"),
        id,
        "--start",
        String(start),
        "--end",
        String(end),
        "--width",
        String(plan.width),
        "--fps",
        String(plan.fps),
        "--out",
        file,
        ...(!config.subtitles ? ["--no-subtitles"] : []),
      ],
      { root: snapshot.root, onLog: options.onLog },
    );
    return file;
  };
  try {
    snapshot = captureInput(root, id);
    if (snapshot.manifest.fingerprint !== input.fingerprint)
      throw new Error("Input changed before capture; start a new render");
    if (
      JSON.stringify(
        readProject(projectPath(snapshot.root, id, "project.ts")).meta,
      ) !== JSON.stringify(meta)
    )
      throw new Error(
        "Project metadata changed before capture; start a new render",
      );
    // Encode and mux real target-size scene/audio before the long render starts.
    if (manifest.preflight !== "passed") {
      const file = await render(
        plan.start,
        Math.min(plan.end, plan.start + 3 / plan.fps),
        "preflight",
      );
      const probe = await probeMedia(file);
      if (
        !probe.streams.some(
          (stream) =>
            stream.codec_type === "video" && stream.nb_read_frames > 0,
        )
      )
        throw new Error("Trial encoding produced no frames");
      manifest.preflight = "passed";
      manifest.preflightProbe = probe;
      save();
    }
    manifest.status = "rendering";
    save();
    for (
      let frame = 0, index = 0;
      frame < plan.frames;
      frame += config.segmentFrames, index++
    ) {
      const count = Math.min(config.segmentFrames, plan.frames - frame);
      const name = "segment-" + index + ".mp4",
        file = path.join(directory, name);
      const prior = manifest.segments[index];
      if (
        prior &&
        fs.existsSync(file) &&
        sha(file) === prior.sha256 &&
        Number(
          (await probeMedia(file)).streams.find((s) => s.codec_type === "video")
            ?.nb_read_frames,
        ) === count
      )
        continue;
      const clip = await render(
        plan.start + frame / plan.fps,
        Math.min(plan.end, plan.start + (frame + count) / plan.fps),
        "segment-" + index,
      );
      const temporary = file + ".tmp.mp4";
      await checkedProcess(ffmpeg, [
        "-v",
        "error",
        "-i",
        clip,
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        "copy",
        "-y",
        temporary,
      ]);
      fs.renameSync(temporary, file);
      manifest.segments[index] = {
        name,
        startFrame: frame,
        frames: count,
        sha256: sha(file),
      };
      manifest.progress = { completed: frame + count, total: plan.frames };
      save();
      options.onLog?.(`Frame ${frame + count}/${plan.frames}\n`);
    }
    manifest.status = "finalizing";
    save();
    const concat = path.join(directory, "segments.txt");
    fs.writeFileSync(
      concat,
      manifest.segments.map((segment) => `file '${segment.name}'`).join("\n"),
    );
    const temp = path.join(directory, ".assembling.mp4"),
      final = path.join(directory, "film.mp4");
    const args = ["-v", "error", "-f", "concat", "-safe", "1", "-i", concat];
    const hasAudio = Boolean(meta.audio || meta.audioTracks?.length);
    if (hasAudio) {
      session = await createRenderSession({ root: snapshot.root, width: 320 });
      const page = await session.page(id),
        audio = path.join(directory, ".mix.wav");
      if (fs.existsSync(audio)) fs.unlinkSync(audio);
      await writeAudio(page, audio, plan.start, plan.duration);
      args.push(
        "-i",
        audio,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
      );
    }
    args.push(
      "-c:v",
      "copy",
      "-t",
      String(plan.duration),
      "-movflags",
      "+faststart",
      "-y",
      temp,
    );
    await checkedProcess(ffmpeg, args);
    const verification = await verifyDelivery(root, id, {
      file: temp,
      expected: { ...plan, audio: hasAudio },
      outputDirectory: path.join(directory, "verification"),
    });
    if (verification.status !== "passed")
      throw new Error(
        "Final media verification failed: " +
          JSON.stringify(verification.media),
      );
    fs.renameSync(temp, final);
    const report = {
      ...plan,
      input,
      output: final,
      audio: meta.audioTracks ?? meta.audio ?? null,
      renderId,
      backend: "software-libx264",
      preflight: manifest.preflight,
      subtitles: config.subtitles,
    };
    fs.writeFileSync(final + ".render.json", JSON.stringify(report, null, 2));
    verification.file = final;
    verification.version = {
      recorded: input.fingerprint,
      current: inputManifest(root, id).fingerprint,
      matches: input.fingerprint === inputManifest(root, id).fingerprint,
    };
    fs.writeFileSync(
      path.join(directory, "verification/verification.json"),
      JSON.stringify(verification, null, 2),
    );
    manifest.status = "succeeded";
    manifest.output = final;
    manifest.sha256 = sha(final);
    save();
    return {
      status: "passed",
      renderId,
      output: final,
      manifest: manifestFile,
      verification: path.join(directory, "verification/verification.json"),
    };
  } catch (error) {
    manifest.status = "failed";
    manifest.error = error.message;
    save();
    throw new Error(
      `Render ${renderId} failed; verified segments retained for --resume. ${error.message}`,
    );
  } finally {
    try {
      await session?.close();
    } finally {
      try {
        snapshot?.close();
      } finally {
        for (const name of [".mix.wav", ".assembling.mp4"])
          fs.rmSync(path.join(directory, name), { force: true });
      }
    }
  }
}
