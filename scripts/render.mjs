import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import sharp from "sharp";
import { launchBrowser } from "./browser.mjs";
const args = process.argv.slice(2);
const val = (key, fallback) => {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : fallback;
};
const posters = args.includes("--posters");
const id = args.find((a) => !a.startsWith("--"));
const root = process.cwd();
if (!posters && (!id || !/^[a-z][a-z0-9-]*$/.test(id))) {
  console.error(
    "Usage: pnpm render <id> [--width 1920] [--fps 30] [--start 0] [--end N] [--out exports/name.mp4] [--no-subtitles] [--force]\n       pnpm render --posters",
  );
  process.exit(1);
}
let width = Number(val("--width", posters ? "1280" : "1920"));
const fps = Number(val("--fps", "30"));
if (!Number.isInteger(width) || width < 320 || width > 3840 || width % 16 !== 0)
  throw new Error("--width must be a multiple of 16, between 320 and 3840");
if (!Number.isInteger(fps) || fps < 12 || fps > 60)
  throw new Error("--fps must be 12..60");
const height = (width * 9) / 16;
let server, browser, encoder, temporary;
let stderr = "";
try {
  server = await createServer({
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  });
  await server.listen();
  const port = server.httpServer.address().port;
  const origin = "http://127.0.0.1:" + port;
  browser = await launchBrowser();
  const renderPage = async (projectId) => {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (e) => console.error("[browser]", e.message));
    await page.goto(
      origin + "/?render=" + encodeURIComponent(projectId) + "&width=" + width,
      { waitUntil: "networkidle" },
    );
    await page.waitForFunction(
      () => window.__FRAME_STUDIO__?.ready,
      {},
      { timeout: 60000 },
    );
    return page;
  };
  if (posters) {
    await fs.mkdir("public/posters", { recursive: true });
    const folders = (
      await fs.readdir("src/projects", { withFileTypes: true })
    ).filter(
      (e) =>
        e.isDirectory() && existsSync("src/projects/" + e.name + "/project.ts"),
    );
    for (const folder of folders) {
      const page = await renderPage(folder.name);
      const duration = await page.evaluate(
        () => window.__FRAME_STUDIO__.duration,
      );
      const at =
        { "paper-wings": 25, "sunny-rail": 10.5, "tiny-seed": 26.8 }[
          folder.name
        ] ?? duration * 0.5;
      const data = await page.evaluate((t) => {
        window.__FRAME_STUDIO__.frame(t, false);
        return window.__FRAME_STUDIO__.dataURL().split(",")[1];
      }, at);
      await sharp(Buffer.from(data, "base64"))
        .webp({ quality: 92 })
        .toFile("public/posters/" + folder.name + ".webp");
      console.log("[poster] " + folder.name + " at " + at + "s");
      await page.close();
    }
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
    const page = await renderPage(id);
    const meta = await page.evaluate(async (projectId) => {
      const { projects } = await import("/src/projects/index.ts");
      const p = projects.find((p) => p.id === projectId);
      return p
        ? { duration: p.duration, audio: p.audio, title: p.title }
        : null;
    }, id);
    if (!meta) throw new Error("Unknown project: " + id);
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
    const frames = Math.ceil((end - start) * fps),
      duration = frames / fps;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = path.resolve(
      val("--out", "exports/" + id + "-" + stamp + ".mp4"),
    );
    if (existsSync(output) && !args.includes("--force"))
      throw new Error("Output exists; use --force explicitly: " + output);
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
    if (meta.audio) {
      const audio = path.resolve("public", meta.audio);
      const relative = path.relative(path.resolve("public"), audio);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !existsSync(audio)
      )
        throw new Error("Missing or non-local soundtrack: " + meta.audio);
      cmd.push(
        "-ss",
        String(start),
        "-i",
        audio,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-af",
        "apad",
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
        (meta.audio ? "on" : "off"),
    );
    for (let i = 0; i < frames; i++) {
      if (encoderFailure) throw encoderFailure;
      if (encoder.exitCode !== null)
        throw new Error("FFmpeg exited early: " + stderr);
      const data = await page.evaluate(
        ({ t, subtitles }) => {
          window.__FRAME_STUDIO__.frame(t, subtitles);
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
    if (code !== 0) throw new Error("FFmpeg failed (" + code + "): " + stderr);
    await fs.rename(temporary, output);
    temporary = undefined;
    const probe = spawnSync(
      process.env.FFPROBE_PATH || "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", output],
      { encoding: "utf8", windowsHide: true },
    );
    const inspected = probe.status === 0 ? JSON.parse(probe.stdout) : null;
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
        meta.audio &&
        !inspected.streams.some((s) => s.codec_type === "audio")
      )
        throw new Error("Output verification failed: missing audio");
    }
    const report = {
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
      audio: meta.audio ?? null,
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
} catch (e) {
  console.error(e.stack || String(e));
  process.exitCode = 1;
} finally {
  if (encoder && encoder.exitCode === null) encoder.kill();
  if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
  await browser?.close();
  await server?.close();
}
