import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { launchBrowser } from "./browser.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { audioCacheKeys, restoreAudioTrack, saveAudioCache } from "./preview-audio-cache.mjs";
import { projectPath } from "./project-paths.mjs";

export function servePreview(directory) {
  const root = fs.realpathSync(directory);
  const types = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".wasm": "application/wasm",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
    ".ogg": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4",
    ".mp4": "video/mp4", ".webm": "video/webm",
  };
  const server = http.createServer((req, res) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const file = fs.realpathSync(path.resolve(root, "." + (pathname === "/" ? "/index.html" : pathname)));
      const stat = fs.statSync(file);
      if (!file.startsWith(root + path.sep) || !stat.isFile()) throw Error();
      const size = stat.size;
      res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
      res.setHeader("Accept-Ranges", "bytes");
      let start = 0, end = size - 1;
      // Bounded media decoders must be able to seek backwards after cache eviction.
      // Serve exact ranges rather than buffering complete audio/video files.
      if (req.method === "GET" && req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (match?.[1]) {
          start = Number(match[1]);
          const requestedEnd = match[2] ? Number(match[2]) : end;
          end = Number.isSafeInteger(requestedEnd) ? Math.min(requestedEnd, end) : NaN;
        } else if (match?.[2]) {
          const suffix = Number(match[2]);
          start = Number.isSafeInteger(suffix) && suffix > 0 ? Math.max(0, size - suffix) : NaN;
        } else start = NaN;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            start < 0 || start > end || start >= size) {
          res.writeHead(416, { "Content-Range": "bytes */" + size, "Content-Length": 0 }).end();
          return;
        }
        res.statusCode = 206;
        res.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + size);
      }
      res.setHeader("Content-Length", size ? end - start + 1 : 0);
      if (req.method === "HEAD" || !size) { res.end(); return; }
      const stream = fs.createReadStream(file, { start, end });
      res.once("close", () => stream.destroy());
      stream.once("error", () => res.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => {
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
      process.env.FFMPEG_PATH || "ffmpeg",
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
        "192k",
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
    if (signal?.aborted) stop();
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(error);
    });
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

export async function buildPreviewAudio(output, { signal, onLog, root, project } = {}) {
  const started = performance.now();
  const metrics = { generatedChunks: 0, reusedChunks: 0, encodedChunks: 0 };
  const server = await servePreview(output);
  let browser;
  const directory = path.join(output, "preview-audio");
  fs.mkdirSync(directory, { recursive: true });
  try {
    browser = await launchBrowser();
    const encoder = await promisify(execFile)(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { timeout: 10000, maxBuffer: 65536, windowsHide: true });
    const cache = root && project ? projectPath(root, project, ".cache/preview-audio-current") : null;
    const keys = cache ? await audioCacheKeys(root, project, { browser: browser.version(), encoder: encoder.stdout, node: process.versions.node, arch: process.arch, platform: process.platform, image: process.env.FRAME_RUNTIME_IMAGE || null }) : {};
    const stop = () => void browser.close();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(120000);
      await page.goto(server.url + "/?prepare-audio=1");
      await page.waitForFunction(() => window.__FRAME_PREPARE_AUDIO__);
      const meta = await page.evaluate(() => ({
        directAudio:window.__FRAME_PREPARE_AUDIO__.directAudio,
        duration: window.__FRAME_PREPARE_AUDIO__.duration,
        tracks: window.__FRAME_PREPARE_AUDIO__.tracks,
      }));
      if(meta.directAudio)return {version:2,mode:"direct",tracks:[],metrics:{...metrics,totalChunks:0,totalMs:Math.round(performance.now()-started)}};
      const manifest = { version: 1, duration: meta.duration, tracks: [], reusedTracks: 0 };
      let complete = 0;
      const encoded = new Map();
      const total = meta.tracks.length * Math.ceil(meta.duration / 2);
      for (const id of meta.tracks) {
        signal?.throwIfAborted();
        const cached = await restoreAudioTrack(cache, output, id, keys[id], meta.duration);
        if (cached) {
          manifest.tracks.push(cached);
          manifest.reusedTracks++;
          metrics.reusedChunks += cached.chunks.length;
          complete += cached.chunks.length;
          previewProgress("复用已验证音轨", complete, total);
          onLog?.(`Preview audio reused track ${id} (${complete}/${total})\n`);
          continue;
        }
        const track = { id, cacheKey: keys[id] || null, chunks: [] };
        for (let start = 0; start < meta.duration; start += 2) {
          signal?.throwIfAborted();
          const duration = Math.min(2, meta.duration - start);
          metrics.generatedChunks++;
          const pcm = Buffer.from(
            await page.evaluate(
              ({ id, start, duration }) =>
                window.__FRAME_PREPARE_AUDIO__.pcm(id, start, duration),
              { id, start, duration },
            ),
            "base64",
          );
          const pcmSha256 = createHash("sha256").update(pcm).digest("hex");
          let encodedChunk = encoded.get(pcmSha256);
          if (!encodedChunk) {
            metrics.encodedChunks++;
            const temporary = path.join(directory, "encoding.mp3");
            await encode(pcm, temporary, signal);
            const bytes = fs.readFileSync(temporary);
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const file = `preview-audio/${sha256}.mp3`;
            fs.renameSync(temporary, path.join(output, file));
            encodedChunk = { file, sha256, bytes: bytes.length };
            encoded.set(pcmSha256, encodedChunk);
          }
          track.chunks.push({ start, duration, ...encodedChunk });
          complete++;
          onLog?.(`Preview audio ${complete}/${total}\n`);
          previewProgress("准备轻量预览音频", complete, total);
        }
        manifest.tracks.push(track);
      }
      await page.evaluate(() => window.__FRAME_PREPARE_AUDIO__.dispose());
      fs.writeFileSync(
        path.join(output, "preview-audio.json"),
        JSON.stringify(manifest),
      );
      if (cache) {
        // Do not retain a cache when local files changed during generation.
        const current = await audioCacheKeys(root, project, { browser: browser.version(), encoder: encoder.stdout, node: process.versions.node, arch: process.arch, platform: process.platform, image: process.env.FRAME_RUNTIME_IMAGE || null });
        if (JSON.stringify(current) !== JSON.stringify(keys)) throw Error("Audio inputs changed while preparing preview; rebuild this work");
        await saveAudioCache(output, cache, manifest);
      }
      return { ...manifest, metrics: { ...metrics, totalChunks: total, totalMs: Math.round(performance.now() - started) } };
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
