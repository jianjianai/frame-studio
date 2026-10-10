import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import sharp from "sharp";
import { createExportPlan } from "../src/engine/export-plan.mjs";
import { frameDimensions, fitComposition } from "../src/engine/dimensions.mjs";
import { appRoot } from "./config.mjs";
import { problem } from "./util.mjs";
import { cleanBrowserError, mergeTimedErrors } from "./stack.mjs";

const require = createRequire(import.meta.url);

export function browserExecutable() {
  const candidates = [process.env.FRAME_BROWSER];
  try {
    candidates.push(require("playwright-core").chromium.executablePath());
  } catch {}
  candidates.push(
    ...(process.platform === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]),
  );
  return candidates.find((file) => file && fs.existsSync(file)) || null;
}

export function ffmpegExecutable() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const probe = spawnSync("ffmpeg", ["-version"], { windowsHide: true });
  if (!probe.error && probe.status === 0) return "ffmpeg";
  try {
    const bundled = require("ffmpeg-static");
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {}
  return null;
}

/**
 * Headless Chromium that loads works through the same Vite server as the
 * studio. Pages are kept warm per work and dropped when the work changes.
 */
export class Renderer {
  constructor(services) {
    this.services = services;
    this.pages = new Map();
    this.browserPromise = null;
    this.openPages = 0; // every page from openPage (warm, check, export) until closed
    this.lastUse = 0;
    this.token = services.auth.issueInternal({ purpose: "render" });
    services.events.subscribe((event) => {
      if (event.type === "preview-update") this.invalidate(`${event.repo}/${event.work}`);
      if (event.type === "materials" && event.repo) this.invalidateResources(event.repo);
    });
    this.sweeper = setInterval(() => this.sweep(), 30000);
    this.sweeper.unref();
  }

  async browser() {
    if (!this.browserPromise) {
      const executablePath = browserExecutable();
      if (!executablePath) throw problem(500, "没有找到 Chromium/Chrome。安装 Chrome，或设置 FRAME_BROWSER 指向浏览器程序。", "NO_BROWSER");
      const { chromium } = require("playwright-core");
      this.browserPromise = chromium
        .launch({
          executablePath,
          headless: true,
          args: [
            "--enable-webgl",
            "--ignore-gpu-blocklist",
            "--enable-unsafe-swiftshader",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--autoplay-policy=no-user-gesture-required",
          ],
        })
        .then((browser) => {
          browser.on("disconnected", () => {
            this.browserPromise = null;
            for (const entry of this.pages.values())
              entry.handle.then(
                (handle) => handle.close(),
                () => {},
              );
            this.pages.clear();
          });
          return browser;
        })
        .catch((error) => {
          this.browserPromise = null;
          throw error;
        });
    }
    return this.browserPromise;
  }

  /** Copy a work's project folder so a long export is not affected by later edits. */
  snapshot(work) {
    const id = randomUUID();
    const root = path.join(this.services.config.dirs.tmp, "snapshots", id);
    const target = path.join(root, "projects", work.slug);
    fs.cpSync(work.dir, target, {
      recursive: true,
      filter: (source) => !/[\\/](exports|\.cache|node_modules|\.git)([\\/]|$)/.test(path.relative(work.dir, source)),
    });
    for (const name of ["src", "node_modules"])
      fs.symlinkSync(path.join(appRoot, name), path.join(root, name), process.platform === "win32" ? "junction" : "dir");
    // Material libraries are served from the work's repository at the versions its lock file names.
    fs.writeFileSync(path.join(root, ".frame-snapshot.json"), JSON.stringify({ repo: work.repo, id: work.id, slug: work.slug }));
    return {
      id,
      root,
      dir: target,
      source: { module: this.services.preview.moduleUrl(path.join(target, "project.ts")), assetBase: `/files/snapshot/${id}/` },
      dispose: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  }

  sourceOf(work) {
    return { module: this.services.preview.moduleUrl(path.join(work.dir, "project.ts")), assetBase: `/files/${work.repo}/${work.id}/` };
  }

  /** Open the headless render page for a work source at an output width. */
  async openPage(source, { width, project, timeoutMs = 90000 }) {
    const browser = await this.browser();
    const size = frameDimensions(project, width);
    this.openPages++;
    let closed = false;
    const closeContext = () => {
      if (!closed) {
        closed = true;
        this.openPages--;
        this.lastUse = Date.now();
      }
      return context.close().catch(() => {});
    };
    let context;
    try {
      context = await browser.newContext({
        viewport: size,
        deviceScaleFactor: 1,
        extraHTTPHeaders: { Authorization: "Bearer " + this.token },
      });
    } catch (error) {
      this.openPages--;
      throw error;
    }
    const page = await context.newPage();
    const errors = [];
    const logs = [];
    // The stack carries the location; cleanBrowserError maps it back to the work's source.
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) logs.push(`[${message.type()}] ${message.text()}`.slice(0, 500));
      if (logs.length > 50) logs.shift();
    });
    page.on("response", (response) => {
      // Requests marked X-Frame-Optional probe for files that may legitimately be missing.
      if (response.status() >= 400 && !response.url().endsWith("/favicon.ico") && !response.request().headers()["x-frame-optional"]) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    });
    const query = new URLSearchParams({ module: source.module, assetBase: source.assetBase, width: String(size.width), live: "0" });
    // The first load of a work can make Vite discover new dependencies (e.g. three/addons/*);
    // it then re-optimizes and reloads the page. Such loads are retried.
    const reoptimized = () => logs.some((line) => line.includes("Outdated Optimize Dep")) || errors.some((line) => line.startsWith("HTTP 504 "));
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await page.goto(`${this.services.baseUrl}/preview/render.html?${query}`, { waitUntil: "load", timeout: timeoutMs });
          await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready || window.__FRAME_RENDER_ERRORS__?.length, null, { timeout: timeoutMs, polling: 50 });
          const loadErrors = await page.evaluate(() => window.__FRAME_RENDER_ERRORS__ || []);
          if (!(await page.evaluate(() => Boolean(window.__FRAME_STUDIO__?.ready))))
            throw problem(422, "作品无法加载：" + [...loadErrors, ...errors].join("\n"), "WORK_LOAD_FAILED", { console: logs });
          break;
        } catch (error) {
          if (attempt >= 3 || !(reoptimized() || /Execution context was destroyed|navigation/i.test(error.message))) throw error;
          errors.length = 0;
          logs.length = 0;
        }
      }
    } catch (error) {
      await closeContext();
      if (error.status) throw error;
      throw problem(422, "作品加载超时或失败：" + [error.message, ...errors].join("\n"), "WORK_LOAD_FAILED", { console: logs });
    }
    return { page, context, size, errors, logs, close: closeContext };
  }

  /** Warm page for interactive tools (frames, contact sheets, audio analysis). */
  async warmPage(work, width) {
    const meta = this.services.works.meta(work);
    if (!meta.ok) throw problem(422, "project.ts 无法读取：" + meta.error, "WORK_INVALID");
    width = width || fitComposition(meta.meta, 1280).width;
    const key = `${work.repo}/${work.id}`;
    const existing = this.pages.get(key);
    if (existing && existing.width === width && !existing.stale) {
      existing.usedAt = Date.now();
      return existing.handle;
    }
    if (existing) {
      this.pages.delete(key);
      existing.handle.then(
        (handle) => handle.close(),
        () => {},
      );
    }
    const entry = { width, usedAt: Date.now(), stale: false };
    entry.handle = this.openPage(this.sourceOf(work), { width, project: meta.meta });
    this.pages.set(key, entry);
    entry.handle.catch(() => this.pages.get(key) === entry && this.pages.delete(key));
    const handle = await entry.handle;
    handle.project = meta.meta;
    return handle;
  }

  invalidate(key) {
    const entry = this.pages.get(key);
    if (!entry) return;
    entry.stale = true;
  }

  sweep() {
    for (const [key, entry] of this.pages)
      if (Date.now() - entry.usedAt > 120000) {
        this.pages.delete(key);
        entry.handle.then(
          (handle) => handle.close(),
          () => {},
        );
      }
    // Close the idle browser only when no page at all is open (checks and exports hold pages too).
    if (!this.pages.size && !this.openPages && this.browserPromise && Date.now() - this.lastUse > 300000) {
      const pending = this.browserPromise;
      this.browserPromise = null;
      pending.then(
        (browser) => browser.close(),
        () => {},
      );
    }
  }

  /** Render frames at absolute times. Returns PNG buffers. */
  async frames(work, { times, width, subtitles = true }) {
    this.lastUse = Date.now();
    let handle;
    try {
      handle = await this.warmPage(work, width);
    } catch (error) {
      error.message = this.clean(work, error.message);
      throw error;
    }
    const duration = handle.project.duration;
    const errorsBefore = handle.errors.length;
    const result = [];
    const failed = [];
    for (const raw of times) {
      const time = Math.max(0, Math.min(duration - 1e-3, Number(raw)));
      try {
        const data = await handle.page.evaluate(
          async ({ time, subtitles }) => {
            await window.__FRAME_STUDIO__.frame(time, subtitles);
            return (await window.__FRAME_STUDIO__.capture()).split(",")[1];
          },
          { time, subtitles },
        );
        result.push({ time, png: Buffer.from(data, "base64") });
      } catch (error) {
        // Keep the frames that did render; one broken moment should not hide the rest.
        failed.push(`${formatTime(time)} 渲染失败：${error.message}`);
      }
    }
    const errors = mergeTimedErrors([...new Set([...failed, ...handle.errors.slice(errorsBefore)].map((text) => this.clean(work, text)))]);
    if (!result.length) throw problem(422, errors.join("\n") || "没有渲染出画面", "RENDER_FAILED");
    return { frames: result, width: handle.size.width, height: handle.size.height, errors, console: [...handle.logs] };
  }

  clean(work, text) {
    return cleanBrowserError(text, { work, vite: this.services.preview?.vite });
  }

  /**
   * The frame for a work's cover, without subtitles: at `time`, or else the fullest of a few
   * moments (by entropy), since a fade to black or an empty frame makes a poor cover.
   */
  async cover(work, { time, width = 640 }) {
    this.lastUse = Date.now();
    const meta = this.services.works.meta(work);
    if (!meta.ok) throw problem(422, "project.ts 无法读取：" + meta.error, "WORK_INVALID");
    const duration = meta.meta.duration;
    const times = typeof time === "number" ? [time] : [0.35, 0.2, 0.5, 0.65].map((share) => share * duration);
    let handle;
    try {
      handle = await this.openPage(this.sourceOf(work), { width, project: meta.meta, timeoutMs: 60000 });
      let best = null;
      let failure = null;
      for (const at of times) {
        try {
          const data = await handle.page.evaluate(
            async (t) => {
              await window.__FRAME_STUDIO__.frame(t, false);
              return (await window.__FRAME_STUDIO__.capture()).split(",")[1];
            },
            Math.max(0, Math.min(duration - 1e-3, at)),
          );
          const png = Buffer.from(data, "base64");
          const { entropy } = await sharp(png).stats();
          // Earlier candidates win ties: 35% in is usually past the opening and still representative.
          if (!best || entropy > best.entropy + 0.25) best = { png, time: at, entropy };
        } catch (error) {
          failure = error;
        }
      }
      if (!best) throw problem(422, this.clean(work, failure?.message || "没有渲染出画面"), "RENDER_FAILED");
      return { png: best.png, time: best.time };
    } finally {
      await handle?.close();
    }
  }

  /** One labelled contact sheet; much cheaper for AI context than many images. */
  async storyboard(work, { times, columns, width = 480, subtitles = true }) {
    const { frames, width: w, height: h, errors } = await this.frames(work, { times, width, subtitles });
    return { image: await contactSheet(frames, w, h, columns), times: frames.map((frame) => frame.time), errors };
  }

  /** A segment of the work's mix as stereo float PCM (48 kHz), rendered offline in the page. */
  async audioPcm(work, { start = 0, duration = 10 }) {
    this.lastUse = Date.now();
    const handle = await this.warmPage(work);
    const total = handle.project.duration;
    start = Math.max(0, Math.min(total, start));
    duration = Math.max(0.05, Math.min(total - start, duration, 60));
    const chunks = [];
    for (let offset = 0; offset < duration - 1e-6; offset += 10) {
      const chunk = Math.min(10, duration - offset);
      const data = await handle.page.evaluate(({ start, chunk }) => window.__FRAME_STUDIO__.audioChunk(start, chunk), { start: start + offset, chunk });
      const pcm = Buffer.from(data, "base64");
      chunks.push(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2));
    }
    const frames = chunks.reduce((sum, chunk) => sum + chunk.length / 2, 0);
    const left = new Float32Array(frames),
      right = new Float32Array(frames);
    let at = 0;
    for (const chunk of chunks)
      for (let i = 0; i < chunk.length; i += 2, at++) {
        left[at] = chunk[i] / 32768;
        right[at] = chunk[i + 1] / 32768;
      }
    return { left, right, rate: 48000, start, duration };
  }

  /** Load the work in a fresh page and render a few times; report every error. */
  /** `frames`: also return the moments it renders as one contact sheet (`sheet`), for the AI to look at. */
  async check(work, { frames = false } = {}) {
    const result = await this.checkOnce(work, { frames });
    // A late dependency re-optimization reloads the page mid-check; the second run finds it optimized.
    if (result.errors.some((error) => /Execution context was destroyed/.test(error))) return this.checkOnce(work, { frames });
    return result;
  }

  async checkOnce(work, { frames = false } = {}) {
    const meta = this.services.works.meta(work);
    if (!meta.ok) return { ok: false, errors: ["project.ts：" + meta.error], console: [] };
    let handle;
    try {
      handle = await this.openPage(this.sourceOf(work), { width: 640, project: meta.meta, timeoutMs: 60000 });
      const duration = meta.meta.duration;
      const times = [0, duration * 0.25, duration * 0.5, duration * 0.75, Math.max(0, duration - 0.05)];
      const shots = [];
      for (const time of times) {
        try {
          const data = await handle.page.evaluate(
            async ({ t, capture }) => {
              await window.__FRAME_STUDIO__.frame(t, true);
              return capture ? (await window.__FRAME_STUDIO__.capture()).split(",")[1] : null;
            },
            { t: time, capture: frames },
          );
          if (data) shots.push({ time, png: Buffer.from(data, "base64") });
        } catch (error) {
          handle.errors.push(`${formatTime(time)} 渲染失败：${error.message}`);
        }
      }
      try {
        await handle.page.evaluate((t) => window.__FRAME_STUDIO__.audioChunk(t, 0.5), Math.min(1, duration / 2));
      } catch (error) {
        handle.errors.push("音频生成失败：" + error.message);
      }
      const errors = mergeTimedErrors([...new Set(handle.errors.map((text) => this.clean(work, text)))]);
      // Small frames: the sheet is for spotting what is wrong, preview_frames shows details.
      const w = 360;
      const h = Math.round((handle.size.height / handle.size.width) * w);
      const small = await Promise.all(shots.map(async (shot) => ({ time: shot.time, png: await sharp(shot.png).resize(w, h).png().toBuffer() })));
      const sheet = small.length ? await contactSheet(small, w, h, 3) : null;
      return { ok: !errors.length, errors, console: handle.logs, checkedTimes: times, sheet };
    } catch (error) {
      return { ok: false, errors: [this.clean(work, error.message)], console: error.details?.console || [] };
    } finally {
      await handle?.close();
    }
  }

  /** Render an MP4 (H.264 + AAC) from a frozen snapshot of the work. */
  async exportVideo(work, { start, end, width, fps, subtitles = true, output, signal, progress }) {
    const ffmpeg = ffmpegExecutable();
    if (!ffmpeg) throw problem(500, "导出需要 FFmpeg。安装 ffmpeg 或设置 FFMPEG_PATH。", "NO_FFMPEG");
    const meta = this.services.works.meta(work);
    if (!meta.ok) throw problem(422, "project.ts 无法读取：" + meta.error);
    const project = meta.meta;
    const plan = createExportPlan({
      duration: project.duration,
      composition: project.composition,
      fps: fps || project.fps,
      width: width || fitComposition(project, 1920).width,
      start: start ?? 0,
      end: end ?? project.duration,
    });
    const snapshot = this.snapshot(work);
    let handle, encoder, audioFile;
    const temp = output + ".partial.mp4";
    try {
      progress?.(0, "准备画面");
      handle = await this.openPage(snapshot.source, { width: plan.width, project });
      const hasAudio = await handle.page.evaluate(async (start) => {
        try {
          const data = await window.__FRAME_STUDIO__.audioChunk(start, 0.05);
          return Boolean(data);
        } catch {
          return false;
        }
      }, plan.start);
      if (hasAudio) {
        audioFile = output + ".pcm";
        const out = fs.openSync(audioFile, "w");
        try {
          const total = Math.round(plan.duration * 48000);
          for (let sample = 0; sample < total; sample += 480000) {
            signal?.throwIfAborted();
            const chunk = Math.min(480000, total - sample);
            const data = await handle.page.evaluate(({ start, duration }) => window.__FRAME_STUDIO__.audioChunk(start, duration), {
              start: plan.start + sample / 48000,
              duration: chunk / 48000,
            });
            fs.writeSync(out, Buffer.from(data, "base64"));
            progress?.(0.15 * (sample / total), "生成音频");
          }
        } finally {
          fs.closeSync(out);
        }
      }
      const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-vcodec", "png", "-framerate", String(plan.fps), "-i", "pipe:0"];
      if (audioFile) args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "-i", audioFile);
      args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
      if (audioFile) args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
      args.push(temp);
      encoder = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      encoder.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4000)));
      encoder.stdin.on("error", () => {});
      const closed = once(encoder, "close");
      for (let index = 0; index < plan.frames; index++) {
        signal?.throwIfAborted();
        if (encoder.exitCode !== null) throw new Error("FFmpeg 提前退出：" + stderr);
        const data = await handle.page.evaluate(
          async ({ t, subtitles }) => {
            await window.__FRAME_STUDIO__.frame(t, subtitles);
            return (await window.__FRAME_STUDIO__.capture()).split(",")[1];
          },
          { t: plan.start + index / plan.fps, subtitles },
        );
        if (!encoder.stdin.write(Buffer.from(data, "base64"))) await once(encoder.stdin, "drain");
        if (index % 10 === 0) progress?.(0.15 + 0.85 * (index / plan.frames), `渲染画面 ${index + 1}/${plan.frames}`);
      }
      encoder.stdin.end();
      const [code] = await closed;
      if (code !== 0) throw new Error("FFmpeg 失败：" + stderr);
      // Snapshot paths read as the work's own files.
      if (handle.errors.length)
        throw new Error("渲染过程中出现错误：" + [...new Set(handle.errors.map((text) => this.clean({ dir: snapshot.dir }, text)))].join("\n"));
      fs.renameSync(temp, output);
      return { file: output, frames: plan.frames, width: plan.width, height: plan.height, fps: plan.fps, duration: plan.duration, audio: Boolean(audioFile) };
    } catch (error) {
      encoder?.kill();
      fs.rmSync(temp, { force: true });
      throw error;
    } finally {
      if (audioFile) fs.rmSync(audioFile, { force: true });
      await handle?.close();
      snapshot.dispose();
    }
  }

  /**
   * The preview page of a library code module (src/preview/resource.ts): the library as it is
   * now (not a work's locked versions), with the work's tempo. Kept warm per module and tempo.
   */
  async resourcePage(work, ref) {
    const meta = this.services.works.meta(work);
    const tempo = JSON.stringify((meta.ok && meta.meta.tempo) || null);
    const key = `resource:${work.repo}|${tempo}|${ref}`;
    const existing = this.pages.get(key);
    if (existing && !existing.stale) {
      existing.usedAt = Date.now();
      return existing.handle;
    }
    if (existing) {
      this.pages.delete(key);
      existing.handle.then(
        (handle) => handle.close(),
        () => {},
      );
    }
    const query = new URLSearchParams({ material: ref, ...this.services.materials.libraryBases(work.repo), tempo });
    const entry = { usedAt: Date.now(), stale: false };
    entry.handle = this.openResourcePage(`${this.services.baseUrl}/preview/resource.html?${query}`);
    this.pages.set(key, entry);
    entry.handle.catch(() => this.pages.get(key) === entry && this.pages.delete(key));
    return entry.handle;
  }

  async openResourcePage(url, timeoutMs = 60000) {
    const browser = await this.browser();
    this.openPages++;
    let closed = false;
    let context;
    const close = () => {
      if (!closed) {
        closed = true;
        this.openPages--;
        this.lastUse = Date.now();
      }
      return context?.close().catch(() => {});
    };
    try {
      context = await browser.newContext({ viewport: { width: 800, height: 800 }, deviceScaleFactor: 1, extraHTTPHeaders: { Authorization: "Bearer " + this.token } });
      const page = await context.newPage();
      const errors = [];
      const logs = [];
      page.on("pageerror", (error) => errors.push(error.stack || error.message));
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type())) logs.push(`[${message.type()}] ${message.text()}`.slice(0, 500));
        if (logs.length > 50) logs.shift();
      });
      const reoptimized = () => logs.some((line) => line.includes("Outdated Optimize Dep")) || errors.some((line) => line.startsWith("HTTP 504 "));
      for (let attempt = 1; ; attempt++) {
        try {
          await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
          await page.waitForFunction(() => window.__FRAME_RESOURCE__?.ready || window.__FRAME_RESOURCE__?.error, null, { timeout: timeoutMs, polling: 50 });
          break;
        } catch (error) {
          if (attempt >= 3 || !(reoptimized() || /Execution context was destroyed|navigation/i.test(error.message))) throw error;
          errors.length = 0;
          logs.length = 0;
        }
      }
      const failure = await page.evaluate(() => window.__FRAME_RESOURCE__?.error);
      if (failure) throw problem(422, [failure, ...errors].join("\n"), "RESOURCE_LOAD_FAILED");
      return { page, errors, logs, close };
    } catch (error) {
      await close();
      throw error.status ? error : problem(422, "资源预览无法加载：" + error.message, "RESOURCE_LOAD_FAILED");
    }
  }

  /** Frames of one resource (`key` of library module `ref`) as PNG buffers, `width` pixels wide. */
  async resourceFrames(work, { ref, key, preset, values, times, width = 640 }) {
    this.lastUse = Date.now();
    let handle;
    try {
      handle = await this.resourcePage(work, ref);
    } catch (error) {
      error.message = this.clean(work, error.message);
      throw error;
    }
    const info = await handle.page.evaluate((key) => window.__FRAME_RESOURCE__.resources.find((item) => item.key === key) ?? null, key);
    if (!info) throw problem(404, `materials/${ref} 里没有资源 ${key}`, "NOT_FOUND");
    const moments = times?.length ? times : [info.time];
    const frames = [];
    const before = handle.errors.length;
    for (const time of moments) {
      try {
        const data = await handle.page.evaluate(({ key, options }) => window.__FRAME_RESOURCE__.render(key, options), { key, options: { preset, values, time, width } });
        frames.push({ time, png: Buffer.from(data.split(",")[1], "base64") });
      } catch (error) {
        throw problem(422, this.clean(work, [error.message, ...handle.errors.slice(before)].join("\n")), "RENDER_FAILED");
      }
    }
    return { frames, info };
  }

  /** Library code changed: drop warm resource pages of the repository. */
  invalidateResources(repo) {
    for (const [key, entry] of this.pages) if (key.startsWith(`resource:${repo}|`)) entry.stale = true;
  }

  async close() {
    clearInterval(this.sweeper);
    const pending = this.browserPromise;
    this.browserPromise = null;
    if (pending)
      await pending.then(
        (browser) => browser.close(),
        () => {},
      );
  }
}

export const formatTime = (seconds) => {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
};


/** Frames ({ time, png }) of one size as one labelled grid (JPEG): cheap for an AI to look at. */
const escapeXml = (text) => String(text).replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Frames of equal size w×h in a grid, each under a label (default "#n  time"). */
export async function contactSheet(frames, w, h, columns) {
  columns = columns || Math.min(4, Math.ceil(Math.sqrt(frames.length)));
  const rows = Math.ceil(frames.length / columns);
  const gap = 8,
    label = 26;
  const composites = [];
  frames.forEach((frame, index) => {
    const x = gap + (index % columns) * (w + gap);
    const y = gap + Math.floor(index / columns) * (h + label + gap);
    composites.push({ input: frame.png, left: x, top: y + label });
    composites.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${label}"><text x="2" y="19" font-family="sans-serif" font-size="16" fill="#e8edf2">${escapeXml(frame.label ?? `#${index + 1}  ${formatTime(frame.time)}`)}</text></svg>`,
      ),
      left: x,
      top: y,
    });
  });
  return sharp({ create: { width: columns * w + (columns + 1) * gap, height: rows * (h + label) + (rows + 1) * gap, channels: 3, background: "#16191d" } })
    .composite(composites)
    .jpeg({ quality: 82 })
    .toBuffer();
}
