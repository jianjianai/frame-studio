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
import { problem, sha256, Locks } from "./util.mjs";
import { cleanBrowserError, mergeTimedErrors } from "./stack.mjs";
import { GpuBrowsers, isGone } from "./render-gpu.mjs";

const require = createRequire(import.meta.url);

/**
 * Page warnings and errors worth keeping. Not Chrome's GL performance notes ("GPU stall due
 * to ReadPixels"): rendering reads every frame back on purpose, and the AI would chase them.
 */
/**
 * Vite reloads every open page when it re-optimizes dependencies (a page imported one it had
 * not bundled yet): a call running on another page then fails with "Execution context was
 * destroyed". Such a call waits for its page to be ready again and runs once more.
 */
const reloaded = (error) => /Execution context was destroyed|navigation/i.test(String(error?.message));
export async function again(page, ready, run) {
  try {
    return await run();
  } catch (error) {
    if (!reloaded(error)) throw error;
    await page.waitForLoadState("load", { timeout: 60000 });
    await page.waitForFunction(ready, null, { timeout: 60000, polling: 50 });
    return run();
  }
}
const READY = {
  work: () => window.__FRAME_STUDIO__?.ready || window.__FRAME_RENDER_ERRORS__?.length,
  resource: () => window.__FRAME_RESOURCE__?.ready || window.__FRAME_RESOURCE__?.error,
  asset: () => window.__FRAME_ASSET__?.ready || window.__FRAME_ASSET__?.error,
};

const worthLogging = (message) => ["error", "warning"].includes(message.type()) && !/GL Driver Message \([^)]*Performance/.test(message.text());

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
    this.stamps = new Map(); // "repo/id" → the work's files when its compiled modules were last known fresh
    this.browserPromise = null;
    this.openPages = 0; // every page from openPage (warm, check, export) until closed
    this.lastUse = 0;
    this.token = services.auth.issueInternal({ purpose: "render" });
    this.assetQueue = new Locks();
    this.analysis = new Locks();
    this.gpu = new GpuBrowsers(services);
    services.events.subscribe((event) => {
      if (event.type === "preview-update") this.invalidate(`${event.repo}/${event.work}`, event.files?.some((file) => String(file).includes("/.materials/")));
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

  /** `scene`: a module of the work (path inside its folder) drawn instead of the film. */
  sourceOf(work, scene) {
    return {
      module: this.services.preview.moduleUrl(path.join(work.dir, "project.ts")),
      assetBase: `/files/${work.repo}/${work.id}/`,
      ...(scene ? { scene: this.services.preview.moduleUrl(path.join(work.dir, scene)) } : {}),
    };
  }

  /**
   * Open the headless render page for a work source at an output width. `on`: a studio page in
   * the user's browser that opens it instead and draws on its GPU (see GpuBrowsers).
   */
  async openPage(source, { width, project, timeoutMs = 90000, quality, on }) {
    const browser = on ?? (await this.browser());
    const size = frameDimensions(project, width);
    // Only pages here keep the headless browser from closing.
    const here = on ? 0 : 1;
    this.openPages += here;
    let closed = false;
    const closeContext = () => {
      if (!closed) {
        closed = true;
        this.openPages -= here;
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
      this.openPages -= here;
      throw error;
    }
    const page = await context.newPage();
    const errors = [];
    const logs = [];
    // The stack carries the location; cleanBrowserError maps it back to the work's source.
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    page.on("console", (message) => {
      if (worthLogging(message)) logs.push(`[${message.type()}] ${message.text()}`.slice(0, 500));
      if (logs.length > 50) logs.shift();
    });
    page.on("response", (response) => {
      // Requests marked X-Frame-Optional probe for files that may legitimately be missing.
      if (response.status() >= 400 && !response.url().endsWith("/favicon.ico") && !response.request().headers()["x-frame-optional"]) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    });
    const query = new URLSearchParams({ module: source.module, assetBase: source.assetBase, width: String(size.width), live: "0" });
    if (source.scene) query.set("scene", source.scene);
    if (quality) query.set("quality", quality);
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
    // A module drawn on its own decides its length (and sound) itself.
    const { duration, sample } = source.scene ? await page.evaluate(() => ({ duration: window.__FRAME_STUDIO__.duration, sample: window.__FRAME_STUDIO__.sample ?? null })) : {};
    return { page, context, size, errors, logs, close: closeContext, fresh: true, duration, sample, on: on ?? null };
  }

  /**
   * Draw on a studio page open on the user's computer when there is one (`who`: the work's
   * `repo` and `work`, drawn where it is open, and `login`, who writes in the AI's conversation;
   * see GpuBrowsers.pick): its GPU draws a 3D frame in milliseconds, the server's software
   * renderer in seconds. `run(on)` gets that page, or null to draw here; when the page goes
   * away halfway (closed, asleep), it runs again here.
   */
  async anywhere(run, who) {
    const on = await this.gpu.pick(who);
    if (on)
      try {
        return await run(on);
      } catch (error) {
        if (!isGone(error)) throw error;
      }
    return run(null);
  }

  /** How long a module drawn on its own is, and what it declared as a sample (null: nothing). */
  async sceneInfo(work, scene, login) {
    // Where its frames will be drawn next, so that page is loaded once.
    return this.anywhere(async (on) => {
      const lease = await this.lease(work, { scene, on }).catch((error) => {
        error.message = this.clean(work, error.message);
        throw error;
      });
      try {
        return { duration: lease.handle.project.duration, sample: lease.handle.sample ?? null };
      } finally {
        lease.release();
      }
    }, { login, repo: work.repo, work: work.id });
  }

  /**
   * Warm page for interactive tools (frames, contact sheets, audio analysis): one per work, and
   * one per module of it drawn on its own (`scene`). Leased: an AI calls several tools at once,
   * and a page one of them replaces (the work changed) stays open until the others are done
   * with it. Drawing goes through `exclusive(width, task)`: one drawing task at a time (two
   * would take each other's frames), at the width it asks for — the page changes size in
   * place instead of loading the work again. Call `release()` when done.
   */
  async lease(work, { width, scene, on } = {}, retried = false) {
    const meta = this.services.works.meta(work);
    if (!meta.ok) throw problem(422, "project.ts 无法读取：" + meta.error, "WORK_INVALID");
    const key = `${work.repo}/${work.id}` + (scene ? `|scene:${scene}` : "") + (on ? `|gpu:${on.id}` : "");
    const stamp = this.freshen(work);
    let entry = this.pages.get(key);
    if (entry && (entry.stale || entry.stamp !== stamp)) {
      // The work changed: the page takes it again in place, as the stage does, instead of a new
      // page loading everything again (seconds here, more over the network for a page in the
      // user's browser). Drawing on it waits for that.
      const page = entry;
      const materials = page.materials;
      Object.assign(page, { stale: false, materials: false, stamp });
      page.updated = page.tail.then(async () => {
        const handle = await page.handle;
        const timestamp = Date.now();
        const update = ({ timestamp, materials }) => window.__FRAME_STUDIO__.update(timestamp, materials);
        handle.size = await handle.page.evaluate(update, { timestamp, materials: materials ? timestamp : undefined });
        handle.fresh = true;
        if (scene) Object.assign(handle, await handle.page.evaluate(() => ({ duration: window.__FRAME_STUDIO__.duration, sample: window.__FRAME_STUDIO__.sample ?? null })));
      });
      page.tail = page.updated.catch(() => {});
    }
    if (!entry) {
      const first = width || fitComposition(meta.meta, 1280).width;
      entry = { usedAt: Date.now(), stale: false, stamp, users: 0, tail: Promise.resolve() };
      entry.handle = this.openPage(this.sourceOf(work, scene), { width: first, project: meta.meta, on });
      this.pages.set(key, entry);
      entry.handle.catch(() => this.pages.get(key) === entry && this.pages.delete(key));
    }
    entry.usedAt = Date.now();
    entry.users = (entry.users ?? 0) + 1;
    const release = () => {
      entry.users--;
      if (entry.retired && !entry.users) this.retire(entry);
    };
    try {
      const handle = await entry.handle;
      await entry.updated;
      // A module on its own is as long as its page says (its sample's duration, else the work's).
      handle.project = scene && handle.duration ? { ...meta.meta, duration: handle.duration } : meta.meta;
      const exclusive = (size, task) => {
        const run = entry.tail.then(async () => {
          if (size) await this.sized(handle, size);
          return task(handle);
        });
        entry.tail = run.catch(() => {});
        return run;
      };
      return { handle, release, exclusive };
    } catch (error) {
      release();
      // A page that could not take the change in place (an older page, a reload meanwhile, the
      // new code failing) is replaced by a new one, which says what is wrong if anything is.
      if (entry.updated && !retried && !isGone(error)) {
        if (this.pages.get(key) === entry) this.pages.delete(key);
        this.retire(entry);
        return this.lease(work, { width, scene, on }, true);
      }
      throw error;
    }
  }

  /** Draw at `width` from now on. Asked every time: a page Vite reloaded is back at its first size. */
  async sized(handle, width) {
    const size = await again(handle.page, READY.work, () => handle.page.evaluate((width) => window.__FRAME_STUDIO__.resize(width), width));
    // A new scene: its first frame loads what it needs again.
    if (size.width !== handle.size.width || size.height !== handle.size.height) handle.fresh = true;
    handle.size = size;
  }

  /** Close a page no longer wanted, once nobody is using it (else when the last user releases it). */
  retire(entry) {
    entry.retired = true;
    if (entry.users) return;
    entry.handle.then(
      (handle) => handle.close(),
      () => {},
    );
  }

  /**
   * A tool that renders right after a change (the AI's own write, a document edit) must not
   * see the work as it was: the file watcher reports changes a moment later. Every file of
   * the work by size and time; when that moved, the work's compiled modules are dropped now.
   * Returns the stamp a warm page is valid for.
   */
  freshen(work) {
    const stamp = contentStamp(work.dir);
    const key = `${work.repo}/${work.id}`;
    if (this.stamps.get(key) !== stamp) {
      this.stamps.set(key, stamp);
      this.services.preview?.invalidateWork?.(work);
    }
    return stamp;
  }

  /** The work changed: its pages (the film and modules drawn on their own) load it again. */
  invalidate(key, materials = false) {
    for (const [name, entry] of this.pages)
      if (name === key || name.startsWith(key + "|")) {
        entry.stale = true;
        // Library code copies changed: the page imports them again too.
        if (materials) entry.materials = true;
      }
  }

  sweep() {
    for (const [key, entry] of this.pages)
      // A page in the user's browser costs a load over the network: kept while the AI is likely to come back.
      if (Date.now() - entry.usedAt > (key.includes("|gpu:") ? 600000 : 120000) && !entry.users) {
        this.pages.delete(key);
        this.retire(entry);
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

  /**
   * Render frames at absolute times. Returns PNG buffers and how long each frame took to draw
   * (`ms`, without capturing; `loading` when it was the first frame of a new scene). `scene`
   * draws a module of the work instead of the film; `crop` ({x, y, width, height} in pixels of
   * the `width`-wide frame) returns only that part.
   */
  /** `login`: who writes in the AI's conversation (see `anywhere`). */
  async frames(work, { login, ...options }) {
    this.lastUse = Date.now();
    return this.anywhere((on) => this.framesWith(work, options, on), { login, repo: work.repo, work: work.id });
  }
  async framesWith(work, { times, width, subtitles = true, scene, crop, format }, on) {
    let lease;
    try {
      lease = await this.lease(work, { width, scene, on });
    } catch (error) {
      error.message = this.clean(work, error.message);
      throw error;
    }
    try {
      return await lease.exclusive(width, (handle) => this.framesOn(work, handle, { times, subtitles: subtitles && !scene, crop, format }));
    } catch (error) {
      error.message = this.clean(work, error.message);
      throw error;
    } finally {
      lease.release();
    }
  }
  /**
   * `format`: the answer's image type. Drawn in the user's browser, a few frames travel in one
   * round trip, as JPEG when the answer is JPEG (a PNG is ten times the bytes on the user's
   * upload); then `png` holds a JPEG.
   */
  async framesOn(work, handle, { times, subtitles, crop, format }) {
    const duration = handle.project.duration;
    const errorsBefore = handle.errors.length;
    const result = [];
    const failed = [];
    const each = handle.on ? 4 : 1;
    const encoding = handle.on && format !== "png" ? { type: "image/jpeg", quality: 0.92 } : null;
    const clamped = times.map((raw) => Math.max(0, Math.min(duration - 1e-3, Number(raw))));
    for (let index = 0; index < clamped.length; index += each) {
      const batch = clamped.slice(index, index + each);
      let drawn;
      try {
        drawn = await again(handle.page, READY.work, () =>
          handle.page.evaluate(
            async ({ batch, subtitles, crop, encoding }) => {
              const studio = window.__FRAME_STUDIO__;
              const out = [];
              for (const time of batch)
                try {
                  await studio.frame(time, subtitles);
                  const ms = studio.getDiagnostics().renderMs;
                  out.push({ time, ms, data: (await studio.capture(crop ?? undefined, encoding ?? undefined)).split(",")[1] });
                } catch (error) {
                  out.push({ time, error: String(error?.stack || error?.message || error).replace(/^Error: /, "") });
                }
              return out;
            },
            { batch, subtitles, crop: crop ?? null, encoding },
          ),
        );
      } catch (error) {
        if (isGone(error)) throw error;
        drawn = batch.map((time) => ({ time, error: error.message }));
      }
      for (const item of drawn) {
        // Keep the frames that did render; one broken moment should not hide the rest.
        if (item.error) {
          failed.push(`${formatTime(item.time)} 渲染失败：${item.error}`);
          continue;
        }
        result.push({ time: item.time, png: Buffer.from(item.data, "base64"), ms: Math.round(item.ms), ...(handle.fresh ? { loading: true } : {}) });
        handle.fresh = false;
      }
    }
    const errors = mergeTimedErrors([...new Set([...failed, ...handle.errors.slice(errorsBefore)].map((text) => this.clean(work, text)))]);
    if (!result.length) throw problem(422, errors.join("\n") || "没有渲染出画面", "RENDER_FAILED");
    const size = crop ?? handle.size;
    return { frames: result, width: size.width, height: size.height, errors, console: [...handle.logs], gpu: handle.on?.gpu ?? null };
  }

  /**
   * One heavy job (motion analysis, timing a whole film) at a time where it is drawn: they draw
   * hundreds of frames, and several at once would slow every studio page and export down.
   * `task(on)` draws on that page on the user's computer (`who`, null: here, see `anywhere`);
   * resolves with the task's result and how long it waited for its turn.
   */
  async heavy(task, who) {
    return this.anywhere((on) => {
      const queued = Date.now();
      return this.analysis.run(on ? `heavy:${on.id}` : "heavy", async () => ({ waited: Date.now() - queued, result: await task(on) }));
    }, who);
  }

  /**
   * Consecutive frames for motion analysis: small (`width`), as luma, handed to `consume`
   * batch by batch while the page draws the next batch. Frames named in `thumbs` (indexes) also
   * come as PNG. `budgetMs` counts from the call (loading the work included): drawing stops
   * when it is used up and says so (`cut`), rather than hold the server for minutes.
   */
  async motionFrames(work, { times, width, thumbs = [], budgetMs = 45000, consume, on }) {
    this.lastUse = Date.now();
    const began = Date.now();
    let lease;
    try {
      lease = await this.lease(work, { width, on });
    } catch (error) {
      error.message = this.clean(work, error.message);
      throw error;
    }
    try {
      return await lease.exclusive(width, async (handle) => {
        const started = Date.now();
        const errorsBefore = handle.errors.length;
        const wanted = new Set(thumbs);
        const batches = [];
        for (let index = 0; index < times.length; index += 6) batches.push(times.slice(index, index + 6).map((time, offset) => ({ time, thumb: wanted.has(index + offset) })));
        // Pictures from the user's browser travel as JPEG (the chart they go into is one).
        const encoding = handle.on ? { type: "image/jpeg", quality: 0.92 } : null;
        const draw = (batch) =>
          again(handle.page, READY.work, () =>
            handle.page.evaluate(
              async ({ batch, encoding }) => {
                const studio = window.__FRAME_STUDIO__;
                const out = [];
                for (const { time, thumb } of batch) {
                  try {
                    await studio.frame(time, false);
                  } catch (error) {
                    out.push({ time, error: String(error?.message ?? error) });
                    break;
                  }
                  out.push({ time, ms: studio.getDiagnostics().renderMs, luma: await studio.luma(), png: thumb ? (await studio.capture(undefined, encoding ?? undefined)).split(",")[1] : null });
                }
                return out;
              },
              { batch, encoding },
            ),
          );
        let drawn = 0;
        let failure = null;
        let pending = draw(batches[0]);
        for (let index = 0; index < batches.length; index++) {
          const batch = await pending;
          const failed = batch.find((item) => item.error);
          const over = Date.now() - began > budgetMs;
          // The page draws the next batch while this one is analysed.
          pending = index + 1 < batches.length && !over && !failed ? draw(batches[index + 1]) : null;
          pending?.catch(() => {});
          for (const item of batch) {
            if (item.error) {
              failure = `${formatTime(item.time)} 渲染失败：${item.error}`;
              break;
            }
            await consume({ time: item.time, ms: item.ms, luma: Buffer.from(item.luma, "base64"), png: item.png ? Buffer.from(item.png, "base64") : null });
            drawn++;
          }
          if (!pending) break;
        }
        if (drawn) handle.fresh = false;
        const errors = mergeTimedErrors([...new Set([...(failure ? [failure] : []), ...handle.errors.slice(errorsBefore)].map((text) => this.clean(work, text)))]);
        const drawing = Date.now() - started;
        return { drawn, cut: drawn < times.length && !failure, ms: Date.now() - began, loadMs: started - began, perFrame: drawn ? drawing / drawn : null, width: handle.size.width, height: handle.size.height, errors, gpu: handle.on?.gpu ?? null };
      });
    } finally {
      lease.release();
    }
  }

  /**
   * How long frames take to draw over the whole film, the way the studio preview draws them
   * ("standard" quality, 1280 on the long side, subtitles on), in a page of its own, then the
   * slowest moments once more (a first visit that also loaded pictures or a layer is fast the
   * second time). Every `step` seconds; when drawing is slower than `budgetMs` (counted from
   * the call, loading included) allows, the moments still to come spread out so the
   * measurement reaches the end of the film.
   */
  async timing(work, { step, budgetMs = 45000, on } = {}) {
    this.lastUse = Date.now();
    const began = Date.now();
    const meta = this.services.works.meta(work);
    if (!meta.ok) throw problem(422, "project.ts 无法读取：" + meta.error, "WORK_INVALID");
    const project = meta.meta;
    const size = fitComposition(project, 1280);
    let handle;
    try {
      this.freshen(work);
      handle = await this.openPage(this.sourceOf(work), { width: size.width, project, quality: "standard", timeoutMs: 60000, on });
      const started = Date.now();
      const draw = (batch) =>
        again(handle.page, READY.work, () =>
          handle.page.evaluate(async (batch) => {
            const studio = window.__FRAME_STUDIO__;
            const out = [];
            for (const time of batch) {
              await studio.frame(time, true);
              out.push({ time, ms: studio.getDiagnostics().renderMs });
            }
            return out;
          }, batch),
        );
      // Most of the budget for the pass over the film, the rest for drawing the slowest again.
      const passEnd = began + 0.85 * budgetMs;
      const samples = [];
      let time = 0,
        used = step;
      while (time < project.duration - 1e-3 && Date.now() < passEnd) {
        const batch = [];
        // Small batches here: a slow work (seconds a frame) learns that after one frame, not eight.
        // In the user's browser frames take milliseconds and each batch a round trip: more at once.
        for (; batch.length < (on ? 8 : 2) && time < project.duration - 1e-3; time += used) batch.push(Math.round(time * 1000) / 1000);
        samples.push(...(await draw(batch)));
        const each = (Date.now() - started) / samples.length;
        const room = Math.floor((passEnd - Date.now()) / each);
        if (room > 0 && (project.duration - time) / used > room) used = Math.ceil(((project.duration - time) / room) * 10) / 10;
      }
      const slowest = [...samples].sort((a, b) => b.ms - a.ms).slice(0, 8);
      for (const sample of slowest) {
        if (Date.now() > began + budgetMs) break;
        const [repeat] = await draw([sample.time]);
        sample.again = repeat.ms;
      }
      // How long creating each layer took and held the main thread (playback stops for that, GPU or not).
      const layers = await handle.page.evaluate(() => window.__FRAME_STUDIO__.getDiagnostics().scene?.layerLoads ?? []).catch(() => []);
      return {
        width: size.width,
        height: size.height,
        step,
        lastStep: used,
        complete: time >= project.duration - 1e-3,
        samples: samples.map((sample) => ({ time: sample.time, ms: Math.round(sample.ms * 10) / 10, ...(sample.again !== undefined ? { again: Math.round(sample.again * 10) / 10 } : {}) })),
        ms: Date.now() - began,
        loadMs: started - began,
        errors: mergeTimedErrors([...new Set(handle.errors.map((text) => this.clean(work, text)))]),
        layers,
        gpu: on?.gpu ?? null,
        // A tab in the background may be given less time to draw.
        background: Boolean(on && !on.visible),
      };
    } catch (error) {
      error.message = this.clean(work, error.message);
      throw error;
    } finally {
      await handle?.close();
    }
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
  /** `cell`: the width of each picture in the sheet when the frames come bigger (crops). */
  async storyboard(work, { times, columns, width = 480, subtitles = true, format = "jpeg", scene, crop, cell, login }) {
    const { frames, width: w, height: h, errors, gpu } = await this.frames(work, { times, width, subtitles, scene, crop, login, format });
    let cells = frames,
      cw = w,
      ch = h;
    if (cell && w > cell) {
      cw = cell;
      ch = Math.max(2, Math.round((h * cell) / w));
      cells = await Promise.all(frames.map(async (frame) => ({ ...frame, png: await sharp(frame.png).resize(cw, ch).png().toBuffer() })));
    }
    return {
      image: await contactSheet(cells, cw, ch, columns, format),
      times: frames.map((frame) => frame.time),
      errors,
      digests: frames.map((frame) => digest(frame.png)),
      ms: frames.map((frame) => frame.ms),
      loading: frames.map((frame) => Boolean(frame.loading)),
      gpu,
    };
  }

  /** A segment of the work's mix as stereo float PCM (48 kHz), rendered offline in the page. */
  /** The work's mix as PCM (or one track alone: `track` is an audio.json track id or a layer's "visual:<id>"). */
  async audioPcm(work, { start = 0, duration = 10, track }) {
    this.lastUse = Date.now();
    const lease = await this.lease(work);
    try {
      return await this.pcmOn(lease.handle, { start, duration, track });
    } finally {
      lease.release();
    }
  }
  async pcmOn(handle, { start, duration, track }) {
    const total = handle.project.duration;
    start = Math.max(0, Math.min(total, start));
    duration = Math.max(0.05, Math.min(total - start, duration, 60));
    const chunks = [];
    for (let offset = 0; offset < duration - 1e-6; offset += 10) {
      const chunk = Math.min(10, duration - offset);
      const data = await handle.page.evaluate(({ start, chunk, track }) => window.__FRAME_STUDIO__.audioChunk(start, chunk, track), { start: start + offset, chunk, track });
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
      this.freshen(work);
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

  /** Render an MP4 (H.264 + AAC) from a frozen snapshot of the work; `scene`: a module of it played on its own. */
  async exportVideo(work, { start, end, width, fps, subtitles = true, scene, output, signal, progress }) {
    const ffmpeg = ffmpegExecutable();
    if (!ffmpeg) throw problem(500, "导出需要 FFmpeg。安装 ffmpeg 或设置 FFMPEG_PATH。", "NO_FFMPEG");
    const meta = this.services.works.meta(work);
    if (!meta.ok) throw problem(422, "project.ts 无法读取：" + meta.error);
    const project = meta.meta;
    const size = frameDimensions(project, width || fitComposition(project, 1920).width);
    const snapshot = this.snapshot(work);
    const source = scene ? { ...snapshot.source, scene: this.services.preview.moduleUrl(path.join(snapshot.dir, scene)) } : snapshot.source;
    let handle, encoder, audioFile, plan;
    const temp = output + ".partial.mp4";
    try {
      progress?.(0, "准备画面");
      handle = await this.openPage(source, { width: size.width, project });
      const duration = handle.duration ?? project.duration;
      if ((end ?? 0) > duration + 1e-6) throw problem(400, `end ${end} 秒超出了${scene ? `样片 ${scene}` : "作品"}的时长 ${duration} 秒（导出到结尾时不写 end）`);
      plan = createExportPlan({
        duration,
        composition: project.composition,
        fps: fps || project.fps,
        width: size.width,
        start: start ?? 0,
        end: end ?? duration,
      });
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
      // Speed and time left in the progress text: WebGL-heavy works render far slower than
      // canvas ones on a machine without a GPU, and whoever waits wants to know how long.
      const began = Date.now();
      const pace = (done) => {
        const fps = done / Math.max(0.001, (Date.now() - began) / 1000);
        const eta = Math.round((plan.frames - done) / Math.max(fps, 1e-3));
        return { fps, eta, text: `，每秒 ${fps >= 10 ? Math.round(fps) : fps.toFixed(1)} 帧，预计还要 ${eta >= 60 ? `${Math.floor(eta / 60)} 分 ${eta % 60} 秒` : `${eta} 秒`}` };
      };
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
        if (index % 10 === 0) {
          const known = index ? pace(index + 1) : null;
          progress?.(0.15 + 0.85 * (index / plan.frames), `渲染画面 ${index + 1}/${plan.frames}${known?.text ?? ""}`, { eta: known?.eta ?? null, fps: known?.fps ?? null });
        }
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
        if (worthLogging(message)) logs.push(`[${message.type()}] ${message.text()}`.slice(0, 500));
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
    const info = await again(handle.page, READY.resource, () => handle.page.evaluate((key) => window.__FRAME_RESOURCE__.resources.find((item) => item.key === key) ?? null, key));
    if (!info) throw problem(404, `materials/${ref} 里没有资源 ${key}`, "NOT_FOUND");
    const moments = times?.length ? times : [info.time];
    const frames = [];
    const before = handle.errors.length;
    for (const time of moments) {
      try {
        const data = await again(handle.page, READY.resource, () => handle.page.evaluate(({ key, options }) => window.__FRAME_RESOURCE__.render(key, options), { key, options: { preset, values, time, width } }));
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

  /**
   * The page that draws media files the browser cannot show by itself (src/preview/asset.ts):
   * 3D models, Lottie, HDR/EXR panoramas, fonts. One warm page per asset base (a work, or a
   * repository's libraries as they are now) — and per studio page in the user's browser (`on`)
   * drawing it there; `open` switches the file it shows.
   */
  async assetPage(assetBase, on) {
    const key = `asset:${assetBase}` + (on ? `|gpu:${on.id}` : "");
    const existing = this.pages.get(key);
    if (existing && !existing.stale) {
      existing.usedAt = Date.now();
      return existing.handle;
    }
    if (existing) {
      this.pages.delete(key);
      this.retire(existing);
    }
    const entry = { usedAt: Date.now(), stale: false };
    entry.handle = this.openAssetPage(`${this.services.baseUrl}/preview/asset.html?${new URLSearchParams({ assetBase })}`, 60000, on);
    this.pages.set(key, entry);
    entry.handle.catch(() => this.pages.get(key) === entry && this.pages.delete(key));
    return entry.handle;
  }
  async openAssetPage(url, timeoutMs = 60000, on) {
    const browser = on ?? (await this.browser());
    // Only pages here keep the headless browser from closing.
    const here = on ? 0 : 1;
    this.openPages += here;
    let closed = false;
    let context;
    const close = () => {
      if (!closed) {
        closed = true;
        this.openPages -= here;
        this.lastUse = Date.now();
      }
      return context?.close().catch(() => {});
    };
    try {
      context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, extraHTTPHeaders: { Authorization: "Bearer " + this.token } });
      const page = await context.newPage();
      const errors = [];
      const logs = [];
      page.on("pageerror", (error) => errors.push(error.stack || error.message));
      page.on("console", (message) => {
        if (worthLogging(message)) logs.push(`[${message.type()}] ${message.text()}`.slice(0, 500));
        if (logs.length > 50) logs.shift();
      });
      const reoptimized = () => logs.some((line) => line.includes("Outdated Optimize Dep")) || errors.some((line) => line.startsWith("HTTP 504 "));
      for (let attempt = 1; ; attempt++) {
        try {
          await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
          await page.waitForFunction(() => window.__FRAME_ASSET__?.ready || window.__FRAME_ASSET__?.error, null, { timeout: timeoutMs, polling: 50 });
          break;
        } catch (error) {
          if (attempt >= 3 || !(reoptimized() || /Execution context was destroyed|navigation/i.test(error.message))) throw error;
          errors.length = 0;
          logs.length = 0;
        }
      }
      return { page, errors, logs, close };
    } catch (error) {
      await close();
      if (isGone(error)) throw error;
      throw problem(422, "素材预览页无法加载：" + error.message, "ASSET_PAGE_FAILED");
    }
  }

  /**
   * Pictures of one media file (`src` an asset address under `assetBase`): PNG buffers
   * `width` pixels wide, one per view (`time`, `animation`, `azimuth`, `elevation`), what the
   * file holds, and the GPU that drew them (`gpu`, null: here). `who`: a browser keeping the
   * file may draw it (see `anywhere`; asset_view passes it only for files a work keeps there).
   */
  assetFrames({ assetBase, src, kind, views = [{}], width = 640, who }) {
    // Opening one file and drawing it is one step: another request would switch the file between.
    // A reload in between loses the opened file: open and draw it again, once.
    const run = (on) =>
      this.assetQueue.run(assetBase + (on ? `|gpu:${on.id}` : ""), async () => {
        const draw = () => this.assetFramesNow({ assetBase, src, kind, views, width, on });
        try {
          return await draw();
        } catch (error) {
          if (!reloaded(error)) throw error;
          const handle = await this.assetPage(assetBase, on);
          await handle.page.waitForLoadState("load", { timeout: 60000 });
          await handle.page.waitForFunction(READY.asset, null, { timeout: 60000, polling: 50 });
          return draw();
        }
      });
    return who ? this.anywhere(run, who) : run(null);
  }
  async assetFramesNow({ assetBase, src, kind, views, width, on }) {
    this.lastUse = Date.now();
    const handle = await this.assetPage(assetBase, on);
    const before = handle.errors.length;
    const fail = (error) => (isGone(error) ? error : problem(422, [String(error.message).replace(/^page\.evaluate: (Error: )?/, ""), ...handle.errors.slice(before)].join("\n"), "RENDER_FAILED"));
    let info;
    try {
      info = await handle.page.evaluate(({ src, kind }) => window.__FRAME_ASSET__.open(src, kind), { src, kind });
    } catch (error) {
      throw fail(error);
    }
    const frames = [];
    for (const view of views)
      try {
        const data = await handle.page.evaluate(({ view, width }) => window.__FRAME_ASSET__.render({ ...view, width }), { view, width });
        frames.push({ ...view, png: Buffer.from(data.split(",")[1], "base64") });
      } catch (error) {
        throw fail(error);
      }
    return { frames, info, gpu: on?.gpu ?? null };
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
/** What the work's picture is made of, as one fingerprint (files' sizes and times; notes left out). */
export function contentStamp(root) {
  const parts = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Notes (AGENTS.md…) are not part of the picture: the AI writing them must not reload the page.
      if (["exports", ".cache", "node_modules"].includes(entry.name) || entry.name.endsWith(".md")) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile())
        try {
          const stat = fs.statSync(file);
          parts.push(`${file}\0${stat.size}\0${stat.mtimeMs}`);
        } catch {}
    }
  };
  walk(root);
  return sha256(parts.join("\n"));
}

/** A short fingerprint of a rendered frame: equal pictures, equal fingerprints. */
export const digest = (png) => sha256(png).slice(0, 12);
const escapeXml = (text) => String(text).replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Frames of equal size w×h in a grid, each under a label (default "#n  time"). */
export async function contactSheet(frames, w, h, columns, format = "jpeg") {
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
    [format === "png" ? "png" : "jpeg"](format === "png" ? {} : { quality: 82 })
    .toBuffer();
}
