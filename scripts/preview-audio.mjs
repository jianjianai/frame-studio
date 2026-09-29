import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { launchBrowser } from "./browser.mjs";

export function servePreview(directory) {
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".mp3": "audio/mpeg",
  };
  const server = http.createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      const file = path.resolve(
        directory,
        "." + (pathname === "/" ? "/index.html" : pathname),
      );
      if (
        !file.startsWith(path.resolve(directory) + path.sep) ||
        !fs.statSync(file).isFile()
      )
        throw Error();
      res.setHeader(
        "Content-Type",
        types[path.extname(file)] || "application/octet-stream",
      );
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      }),
    ),
  );
}

async function encode(pcm, output, signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-i",
        "pipe:0",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        "-write_xing",
        "1",
        output,
      ],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
    );
    let error = "";
    child.stderr.on("data", (s) => {
      error = (error + s).slice(-2000);
    });
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, 30000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      code === 0
        ? resolve()
        : reject(new Error("Preview encoding failed: " + error));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(pcm);
  });
}

export async function buildPreviewAudio(output, { signal, onLog } = {}) {
  const server = await servePreview(output);
  let browser;
  const directory = path.join(output, "preview-audio");
  fs.mkdirSync(directory, { recursive: true });
  try {
    browser = await launchBrowser();
    const stop = () => void browser.close();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(120000);
      await page.goto(server.url + "/?prepare-audio=1");
      await page.waitForFunction(() => window.__FRAME_PREPARE_AUDIO__);
      const meta = await page.evaluate(() => ({
        duration: window.__FRAME_PREPARE_AUDIO__.duration,
        tracks: window.__FRAME_PREPARE_AUDIO__.tracks,
      }));
      const manifest = { version: 1, duration: meta.duration, tracks: [] };
      let complete = 0;
      const total = meta.tracks.length * Math.ceil(meta.duration / 2);
      for (const id of meta.tracks) {
        const track = { id, chunks: [] };
        for (let start = 0; start < meta.duration; start += 2) {
          signal?.throwIfAborted();
          const duration = Math.min(2, meta.duration - start);
          const pcm = Buffer.from(
            await page.evaluate(
              ({ id, start, duration }) =>
                window.__FRAME_PREPARE_AUDIO__.pcm(id, start, duration),
              { id, start, duration },
            ),
            "base64",
          );
          const temporary = path.join(directory, "encoding.mp3");
          await encode(pcm, temporary, signal);
          const bytes = fs.readFileSync(temporary);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const file = `preview-audio/${sha256}.mp3`;
          fs.renameSync(temporary, path.join(output, file));
          track.chunks.push({
            start,
            duration,
            file,
            sha256,
            bytes: bytes.length,
          });
          onLog?.(`Preview audio ${++complete}/${total}\n`);
          previewProgress("准备轻量预览音频", complete, total);
        }
        manifest.tracks.push(track);
      }
      await page.evaluate(() => window.__FRAME_PREPARE_AUDIO__.dispose());
      fs.writeFileSync(
        path.join(output, "preview-audio.json"),
        JSON.stringify(manifest),
      );
      return manifest;
    } finally {
      signal?.removeEventListener("abort", stop);
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}
export function previewProgress(stage, completed, total) {
  const file = process.env.FRAME_TASK_PROGRESS_FILE;
  if (!file) return;
  fs.writeFileSync(
    file + ".tmp",
    JSON.stringify({ stage, ...(total ? { completed, total } : {}) }),
  );
  fs.renameSync(file + ".tmp", file);
}
