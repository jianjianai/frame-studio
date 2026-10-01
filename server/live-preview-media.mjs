import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { confined, problem } from "./security.mjs";

export const mediaSignature = stat => createHash("sha256").update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])).digest("hex");

export class LivePreviewMedia {
  constructor({ data, maxBytes = 1024 * 1024 * 1024, transcode = runTranscode } = {}) {
    this.root = path.join(data, "live-preview-media");
    this.maxBytes = maxBytes; this.transcode = transcode;
    this.pending = new Map(); this.jobs = new Map(); this.entries = new Map(); this.waiters = [];
    this.running = 0; this.closed = false;
    fs.mkdirSync(this.root, { recursive: true });
    this.ready = this.load();
  }
  async load() {
    for (const name of await fsp.readdir(this.root)) {
      if (/^[a-f0-9]{64}-.+\.tmp$/.test(name)) {
        const temporary = path.join(this.root, name), stat = await fsp.lstat(temporary);
        if (stat.isFile() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) await fsp.rm(temporary, { force: true });
        continue;
      }
      if (!/^[a-f0-9]{64}-(?:audio|video|image)-(?:preview|economy)-v2\.(?:m4a|mp4|webp)$/.test(name)) continue;
      const file = path.join(this.root, name), stat = await fsp.lstat(file);
      if (stat.isFile() && !stat.isSymbolicLink()) this.entries.set(name.replace(/\.(?:m4a|mp4|webp)$/, ""), { file, bytes: stat.size, used: stat.mtimeMs });
    }
    await this.prune("");
  }
  /** Capture new public content before a revision is published; subsequent edits reuse the frozen bytes. */
  async snapshot(session, asset) {
    if (session.closed || session.abort?.signal.aborted) throw problem(499, "Preview request cancelled");
    const key = asset.revision, existing = session.mediaFiles.get(key);
    if (existing) return existing;
    const pendingKey = "snapshot:" + session.id + ":" + key;
    if (this.pending.has(pendingKey)) return this.pending.get(pendingKey);
    const operation = (async () => {
      const source = confined(session.projectDir, "public/" + asset.src.split("/").slice(2).join("/"));
      const before = await fsp.lstat(source);
      if (!before.isFile() || before.nlink > 1 || before.isSymbolicLink() || mediaSignature(before) !== asset.signature)
        throw problem(409, "Media source changed; wait for the current live revision");
      if (before.size > this.maxBytes) throw problem(413, "This preview source exceeds the media cache limit");
      if (session.mediaBytes + (session.mediaReserved || 0) + before.size > this.maxBytes)
        throw problem(413, "Live preview media cache is full; reopen the preview to release old revisions");
      const folder = path.join(session.outDir, "media");
      await fsp.mkdir(folder, { recursive: true });
      // Reserve after creating the directory, immediately before the first copy await.
      // Re-check because another snapshot may have reserved while mkdir was pending.
      if (session.mediaBytes + (session.mediaReserved || 0) + before.size > this.maxBytes)
        throw problem(413, "Live preview media cache is full; reopen the preview to release old revisions");
      session.mediaReserved = (session.mediaReserved || 0) + before.size;
      const file = path.join(folder, key + path.extname(source)), temporary = file + "." + randomUUID() + ".tmp";
      const hash = createHash("sha256");
      const hashing = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } });
      try {
        await pipeline(fs.createReadStream(source, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) }),
          hashing, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal: session.abort?.signal });
        const after = await fsp.lstat(source);
        if (mediaSignature(after) !== asset.signature) throw problem(409, "Media changed while preparing its preview");
        const contentHash = hash.digest("hex");
        if (contentHash !== key) throw problem(409, "Media content changed while preparing its preview");
        await fsp.rename(temporary, file);
        const record = { file, contentHash, bytes: before.size };
        session.mediaFiles.set(key, record); session.mediaBytes += before.size;
        return record;
      } finally { session.mediaReserved -= before.size; await fsp.rm(temporary, { force: true }); }
    })();
    this.pending.set(pendingKey, operation);
    try { return await operation; } finally { this.pending.delete(pendingKey); }
  }
  async rendition(session, asset, profile, kind = "audio", { signal } = {}) {
    await this.ready;
    this.checkCancelled(session, signal);
    if (!["preview", "economy"].includes(profile)) throw problem(400, "Invalid preview media profile");
    if (!["audio", "video", "image"].includes(kind)) throw problem(400, "Invalid preview media kind");
    const original = await this.snapshot(session, asset);
    this.checkCancelled(session, signal);
    const key = original.contentHash + "-" + kind + "-" + profile + "-v2";
    const existing = this.entries.get(key);
    if (existing && fs.existsSync(existing.file)) { existing.used = Date.now(); return existing.file; }
    let job = this.jobs.get(key);
    // A later retry waits for the cancelled process/temporary file to retire before creating a replacement.
    if (job?.controller.signal.aborted) {
      await job.promise.catch(() => {});
      this.checkCancelled(session, signal);
      job = this.jobs.get(key);
    }
    if (!job) {
      job = { key, controller: new AbortController(), refs: new Set(), settled: false };
      this.jobs.set(key, job);
      job.promise = this.convert(original, key, profile, kind, job.controller.signal);
      this.pending.set(key, job.promise);
      // The first session owns the input snapshot until all shared readers finish.
      session.mediaJobs ||= new Set();
      session.mediaJobs.add(job.promise);
      void job.promise.finally(() => {
        job.settled = true; session.mediaJobs.delete(job.promise);
        if (this.pending.get(key) === job.promise) this.pending.delete(key);
        if (this.jobs.get(key) === job) this.jobs.delete(key);
      }).catch(() => {});
    }
    return this.observe(job, session, signal);
  }
  checkCancelled(session, signal) {
    if (this.closed) throw problem(503, "Live media service stopped");
    if (session.closed || session.abort?.signal.aborted || signal?.aborted)
      throw problem(499, "Preview request cancelled");
  }
  observe(job, session, signal) {
    return new Promise((resolve, reject) => {
      const ref = { session, signal };
      job.refs.add(ref);
      const signals = [...new Set([signal, session.abort?.signal].filter(Boolean))];
      let finished = false;
      const cleanup = () => {
        if (finished) return false;
        finished = true;
        signals.forEach(value => value.removeEventListener("abort", cancel));
        job.refs.delete(ref);
        // Cancelling one viewer must not interrupt another viewer's rendition.
        if (!job.settled && !job.refs.size) job.controller.abort(problem(499, "Preview request cancelled"));
        return true;
      };
      const cancel = () => { if (cleanup()) reject(problem(499, "Preview request cancelled")); };
      signals.forEach(value => value.addEventListener("abort", cancel, { once: true }));
      job.promise.then(value => { if (cleanup()) resolve(value); }, error => { if (cleanup()) reject(error); });
      if (signals.some(value => value.aborted) || session.closed) cancel();
    });
  }
  async convert(original, key, profile, kind, signal) {
    await this.acquire(signal);
    const file = path.join(this.root, key + (kind === "video" ? ".mp4" : kind === "image" ? ".webp" : ".m4a")),
      temporary = file + "." + randomUUID() + ".tmp";
    try {
      if (signal.aborted) throw problem(499, "Preview request cancelled");
      if (!fs.existsSync(file)) {
        await this.transcode(original.file, temporary, profile, kind, signal);
        if (signal.aborted) throw problem(499, "Preview request cancelled");
        const stat = await fsp.stat(temporary);
        if (!stat.size || stat.size > this.maxBytes) throw problem(413, "Media rendition exceeds the preview cache budget");
        await fsp.rename(temporary, file);
      }
      this.entries.set(key, { file, bytes: (await fsp.stat(file)).size, used: Date.now() });
      await this.prune(key);
      return file;
    } finally { await fsp.rm(temporary, { force: true }); this.release(); }
  }
  async acquire(signal) {
    if (this.closed) throw problem(503, "Live media service stopped");
    if (signal?.aborted) throw problem(499, "Preview request cancelled");
    if (this.running < 2) { this.running++; return; }
    await new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => { signal?.removeEventListener("abort", cancel); resolve(); },
        reject: error => { signal?.removeEventListener("abort", cancel); reject(error); },
      };
      const cancel = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(problem(499, "Preview request cancelled"));
      };
      this.waiters.push(waiter); signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    // release() transfers an existing permit directly to this waiter.
    if (this.closed || signal?.aborted) {
      this.release();
      throw problem(this.closed ? 503 : 499, this.closed ? "Live media service stopped" : "Preview request cancelled");
    }
  }
  release() {
    const next = !this.closed && this.waiters.shift();
    if (next) next.resolve();
    else this.running--;
  }
  async prune(keep) {
    let bytes = [...this.entries.values()].reduce((sum, item) => sum + item.bytes, 0);
    for (const [key, item] of [...this.entries].sort(([, a], [, b]) => a.used - b.used)) {
      if (bytes <= this.maxBytes) break;
      if (key === keep || this.pending.has(key)) continue;
      await fsp.rm(item.file, { force: true }); this.entries.delete(key); bytes -= item.bytes;
    }
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(problem(503, "Live media service stopped"));
    for (const waiter of this.waiters.splice(0)) waiter.reject(problem(503, "Live media service stopped"));
    await Promise.allSettled(this.pending.values());
    await this.ready;
  }
}

function runTranscode(source, target, profile, kind, signal) {
  if (kind === "image") return import("sharp").then(({ default: sharp }) =>
    sharp(source, { animated: true, limitInputPixels: 64 * 1024 * 1024 }).rotate()
      .resize({ width: profile === "economy" ? 480 : 1280, withoutEnlargement: true })
      .webp({ quality: profile === "economy" ? 68 : 82, alphaQuality: 90, effort: 3 }).toFile(target));
  return new Promise((resolve, reject) => {
    const economy = profile === "economy";
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source,
      ...(kind === "video"
        ? ["-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale='min(" + (economy ? 320 : 640) + ",iw)':-2,fps=24",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", economy ? "29" : "26", "-maxrate", economy ? "300k" : "700k",
          "-bufsize", economy ? "600k" : "1400k", "-pix_fmt", "yuv420p", "-threads", "2"]
        : ["-map", "0:a:0", "-vn"]),
      "-ar", "48000", "-ac", economy ? "1" : "2", "-c:a", "aac", "-b:a", economy ? "48k" : kind === "video" ? "64k" : "96k",
      "-movflags", "+faststart", "-f", "mp4", target];
    if (signal?.aborted) { reject(problem(499, "Preview request cancelled")); return; }
    const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const cancel = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    let error = "";
    child.stderr.on("data", bytes => { error = (error + String(bytes)).slice(-2048); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000); timer.unref();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    child.once("error", failure => { cleanup(); reject(failure); });
    child.once("close", code => {
      cleanup();
      if (signal?.aborted) reject(problem(499, "Preview request cancelled"));
      else code === 0 ? resolve() : reject(problem(502, "Media preview conversion failed: " + error));
    });
  });
}
