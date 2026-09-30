import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { writeProjectPoster } from "./poster-output.mjs";
import { createRenderSession, framePng } from "./render-session.mjs";
import { createExportPlan } from "../src/engine/export-plan.mjs";
import { frameDimensions, fitComposition } from "../src/engine/dimensions.mjs";
import { projectPath } from "./project-paths.mjs";
import {
  validProjectId,
  readProjectCatalog,
  readProject,
} from "./project-metadata.mjs";
const args = process.argv.slice(2);
const values = new Set([
  "--width",
  "--fps",
  "--start",
  "--end",
  "--out",
  "--preset",
  "--project",
  "--frame",
  "--time",
]);
const flags = new Set([
  "--posters",
  "--all",
  "--no-subtitles",
  "--force",
  "--frame-mode",
]);
const positional = [];
const seen = new Set();
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith("--") && seen.has(arg))
    throw new Error("Duplicate option: " + arg);
  seen.add(arg);
  if (values.has(arg)) {
    if (!args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error("Missing value for " + arg);
    i++;
  } else if (!flags.has(arg)) {
    if (arg.startsWith("--")) throw new Error("Unknown option: " + arg);
    positional.push(arg);
  }
}
const val = (key, fallback) => {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : fallback;
};
const posters = args.includes("--posters");
const posterProject = val("--project");
if (
  posters &&
  ((!posterProject && !args.includes("--all")) ||
    (posterProject && args.includes("--all")))
) {
  throw new Error(
    "Use pnpm posters --project <id>, or pnpm posters --all explicitly",
  );
}
if (posterProject && !/^[a-z][a-z0-9-]*$/.test(posterProject))
  throw new Error("Invalid poster project id");
const id = positional[0];
const root = process.cwd();
if (!posters && (!validProjectId(id) || positional.length !== 1)) {
  console.error(
    "Usage: pnpm render <id> [--width 1920] [--fps 30] [--start 0] [--end N] [--out projects/<id>/exports/name.mp4] [--no-subtitles] [--force]\n       pnpm frame <id> --frame 150 | --time 5\n       pnpm posters --project <id> | --all",
  );
  process.exit(1);
}
const catalog =
  posters && !posterProject
    ? readProjectCatalog(root)
    : [
        {
          directory: posterProject ?? id,
          ...readProject(projectPath(root, posterProject ?? id, "project.ts")),
        },
      ];
const selected = catalog.find((project) => project.meta.id === id)?.meta;
if (!posters && !selected) throw new Error("Unknown project: " + id);
if (!posters && val("--out"))
  for (const destination of [val("--out"), val("--out") + ".render.json"])
    projectPath(
      root,
      id,
      path.relative(projectPath(root, id), path.resolve(destination)),
    );
const width = Number(val("--width", posters ? "1280" : String(fitComposition(selected, 1920).width)));
const fps = Number(val("--fps", String(selected?.fps ?? 30)));
if (!Number.isInteger(width) || width < 2 || width > 3840 || width % 2 !== 0)
  throw new Error("--width must be an even integer between 2 and 3840");
if (!Number.isInteger(fps) || fps < 12 || fps > 60)
  throw new Error("--fps must be 12..60");
const height = selected ? frameDimensions(selected, width).height : undefined;
let session, encoder, temporary, audioTemporary;
let stderr = "";
try {
  session = await createRenderSession({ root, width, cacheRoot: process.env.FRAME_RENDER_CACHE_ROOT || root });
  const renderPage = (projectId, purpose = "media") => session.page(projectId, { purpose });
  if (posters) {
    const folders = (
      await fs.readdir("projects", { withFileTypes: true })
    ).filter(
      (e) =>
        e.isDirectory() && existsSync("projects/" + e.name + "/project.ts"),
    );
    if (
      posterProject &&
      !folders.some((folder) => folder.name === posterProject)
    )
      throw new Error("Unknown poster project: " + posterProject);
    for (const folder of folders.filter(
      (folder) => !posterProject || folder.name === posterProject,
    )) {
      const page = await renderPage(folder.name, "visual");
      const duration = page.metadata.duration;
      const at =
        catalog.find((entry) => entry.directory === folder.name)?.meta
          .posterTime ?? duration * 0.5;
      const data = await framePng(page,at,false);
      const output = await writeProjectPoster(
        root,
        folder.name,
        data,
      );
      console.log("[poster] " + folder.name + " at " + at + "s -> " + output);
      await page.close();
    }
  } else {
    const singleFrame =
      args.includes("--frame-mode") ||
      args.includes("--frame") ||
      args.includes("--time");
    const page = await renderPage(id, singleFrame ? "visual" : "media");
    const meta = selected;
    if (!meta) throw new Error("Unknown project: " + id);
    const scopedOutput = (fallback, extension) => {
      const output = path.resolve(val("--out", fallback));
      projectPath(root, id, path.relative(projectPath(root, id), output));
      projectPath(
        root,
        id,
        path.relative(projectPath(root, id), output + ".render.json"),
      );
      if (path.extname(output).toLowerCase() !== extension)
        throw new Error("Output must end with " + extension);
      if (existsSync(output) && !args.includes("--force"))
        throw new Error("Output exists; use --force explicitly: " + output);
      return output;
    };
    if (singleFrame) {
      if (args.includes("--frame") && args.includes("--time"))
        throw new Error("Choose either --frame or --time");
      const frame = Number(val("--frame", "0"));
      const frameFps = Number(val("--fps", String(meta.fps)));
      const time = args.includes("--time")
        ? Number(val("--time"))
        : frame / frameFps;
      if (
        !Number.isInteger(frame) ||
        frame < 0 ||
        !Number.isFinite(time) ||
        time < 0 ||
        time >= meta.duration
      )
        throw new Error("Frame/time is outside the project");
      const output = scopedOutput(
        "projects/" + id + "/exports/frame-" + time.toFixed(6) + ".png",
        ".png",
      );
      const data = await framePng(page,time,!args.includes("--no-subtitles"));
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, data, {
        flag: args.includes("--force") ? "w" : "wx",
      });
      console.log("Exported frame at " + time + "s -> " + output);
      await page.close();
    } else if(meta.renderer==="remotion") {
      const plan=createExportPlan({duration:meta.duration,composition:meta.composition,width,fps,start:Number(val("--start","0")),end:Number(val("--end",String(meta.duration)))});
      const output=scopedOutput("projects/"+id+"/exports/"+id+"-"+new Date().toISOString().replace(/[:.]/g,"-")+".mp4",".mp4");
      await fs.mkdir(path.dirname(output),{recursive:true});
      await (await import("./remotion-export.mjs")).renderRemotionVideo({page,meta,plan,output,subtitles:!args.includes("--no-subtitles"),input:session.input(id)});
      await page.close();
    } else {
      const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
      const available = spawnSync(ffmpeg, ["-version"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (available.error || available.status !== 0)
        throw new Error(
          "FFmpeg is required. Set FFMPEG_PATH or add ffmpeg to PATH.",
        );
      const start = Number(val("--start", "0")),
        end = Number(val("--end", String(meta.duration)));
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end <= start ||
        end > meta.duration
      )
        throw new Error("Invalid --start / --end range");
      const { frames, duration } = createExportPlan({
        duration: meta.duration,
    composition: meta.composition,
        fps,
        width,
        start,
        end,
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const output = scopedOutput(
        "projects/" + id + "/exports/" + id + "-" + stamp + ".mp4",
        ".mp4",
      );
      const hasAudio = Boolean(meta.audio || meta.audioTracks?.length || meta.visual?.clips?.some(c=>c.source.kind==="video"&&c.audio?.enabled&&!c.hidden));
      await fs.mkdir(path.dirname(output), { recursive: true });
      temporary = path.join(
        path.dirname(output),
        "." + path.basename(output, ".mp4") + "-" + randomUUID() + ".tmp.mp4",
      );
      const cmd = [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
      ];
      if (hasAudio) {
        audioTemporary = path.join(
          path.dirname(output),
          ".audio-" + randomUUID() + ".pcm",
        );
        const handle = await fs.open(audioTemporary, "wx");
        try {
          const samples = Math.round(duration * 48000);
          for (let sample = 0; sample < samples; sample += 480000) {
            const chunk = Math.min(480000, samples - sample);
            const data = await page.evaluate(
              ({ start, duration }) =>
                window.__FRAME_STUDIO__.audioChunk(start, duration),
              { start: start + sample / 48000, duration: chunk / 48000 },
            );
            const pcm = Buffer.from(data, "base64");
            if (pcm.length !== chunk * 4)
              throw new Error("Unexpected audio chunk length");
            await handle.writeFile(pcm);
          }
        } finally {
          await handle.close();
        }
        cmd.push(
          "-f",
          "s16le",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-i",
          audioTemporary,
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
      cmd.push(
        "-c:v",
        "libx264",
        "-preset",
        val("--preset", "medium"),
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-r",
        String(fps),
        "-t",
        String(duration),
        "-movflags",
        "+faststart",
        "-y",
        temporary,
      );
      encoder = spawn(ffmpeg, cmd, {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      let encoderFailure;
      encoder.on("error", (e) => {
        encoderFailure = e;
      });
      encoder.stdin.on("error", (e) => {
        encoderFailure = e;
      });
      encoder.stderr.on("data", (d) => {
        stderr = (stderr + d.toString()).slice(-12000);
      });
      const closed = once(encoder, "close");
      const began = Date.now();
      const subtitles = !args.includes("--no-subtitles");
      console.log(
        "Rendering " +
          id +
          ": " +
          frames +
          " frames, " +
          width +
          "x" +
          height +
          ", " +
          fps +
          " fps, audio " +
          (hasAudio ? "on" : "off"),
      );
      for (let i = 0; i < frames; i++) {
        if (encoderFailure) throw encoderFailure;
        if (encoder.exitCode !== null)
          throw new Error("FFmpeg exited early: " + stderr);
        const data = await page.evaluate(
          async ({ t, subtitles }) => {
            await window.__FRAME_STUDIO__.frame(t, subtitles);
            return window.__FRAME_STUDIO__.dataURL().split(",")[1];
          },
          { t: start + i / fps, subtitles },
        );
        const png = Buffer.from(data, "base64");
        if (!encoder.stdin.write(png))
          await Promise.race([
            once(encoder.stdin, "drain"),
            closed.then(() => {
              throw new Error("FFmpeg stopped: " + stderr);
            }),
          ]);
        if (i % Math.max(fps, 1) === 0 || i === frames - 1)
          console.log(
            "Frame " +
              (i + 1) +
              "/" +
              frames +
              " (" +
              Math.round(((i + 1) / frames) * 100) +
              "%)",
          );
      }
      encoder.stdin.end();
      const [code] = await closed;
      if (code !== 0)
        throw new Error("FFmpeg failed (" + code + "): " + stderr);
      const probe = spawnSync(
        process.env.FFPROBE_PATH || "ffprobe",
        [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          temporary,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      const inspected = probe.status === 0 ? JSON.parse(probe.stdout) : null;
      if (!inspected)
        throw new Error(
          "FFprobe verification failed: " +
            (probe.stderr || probe.error?.message),
        );
      if (inspected) {
        const video = inspected.streams.find((s) => s.codec_type === "video");
        if (
          Number(video?.nb_frames) !== frames ||
          video?.width !== width ||
          video?.height !== height
        )
          throw new Error(
            "Output verification failed: unexpected video dimensions/frame count",
          );
        if (
          hasAudio &&
          !inspected.streams.some((s) => s.codec_type === "audio")
        )
          throw new Error("Output verification failed: missing audio");
      }
      await fs.rename(temporary, output);
      temporary = undefined;
      const report = {
        input: session.input(id),
        diagnostics: page.frameDiagnostics(),
        project: id,
        title: meta.title,
        output,
        width,
        height,
        fps,
        frames,
        start,
        end,
        duration,
        subtitles,
        audio: meta.audioTracks ?? meta.audio ?? null,
        elapsedSeconds: (Date.now() - began) / 1000,
        ffprobe: inspected,
        warnings: stderr,
      };
      await fs.writeFile(
        output + ".render.json",
        JSON.stringify(report, null, 2),
      );
      console.log("Verified output: " + output);
      console.log("Render report: " + output + ".render.json");
      await page.close();
    }
  }
} catch (e) {
  console.error(e.stack || String(e));
  process.exitCode = 1;
} finally {
  if (encoder && encoder.exitCode === null) encoder.kill();
  if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
  if (audioTemporary)
    await fs.rm(audioTemporary, { force: true }).catch(() => {});
  await session?.close();
}
