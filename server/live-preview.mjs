import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";
import { hash, token, confined, problem } from "./security.mjs";
import { confinedAsync, copyTree, treeHash } from "./project-files.mjs";
import { createLivePreviewWorker } from "./live-preview-worker.mjs";
import { LivePreviewMedia } from "./live-preview-media.mjs";
import { liveSourceInventory } from "../scripts/live-preview-bundle.mjs";
import { bundleResources, runtimeResources, liveResource } from "./live-preview-resources.mjs";
import { liveReviewRevision } from "./live-review-snapshot.mjs";
import { livePreviewMediaModeSchema } from "../src/contracts/live-preview.mjs";

const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
const brotli = promisify(brotliCompress), gz = promisify(gzip);
const LOSSLESS_AUDIO = /\.(?:wav|flac|aiff?|pcm)$/i;
const AUDIO = /\.(?:wav|mp3|ogg|opus|flac|m4a|aac|aiff?|pcm)$/i;

/** Ephemeral edit sessions do not create durable build tasks or publish work commits.
 * Capability scope exposes compiled output and this work's immutable public media only.
 */
export class LivePreviewSessions {
  constructor({ db, data, repos, root = runtimeRoot, bundleFactory = createLivePreviewWorker,
    idleMs = 10 * 60 * 1000, leaseMs = 60 * 60 * 1000, maxSessions = 4,
    maxBundleBytes = 512 * 1024 * 1024, maxRuntimeBytes = 32 * 1024 * 1024, media } = {}) {
    this.db = db; this.data = data; this.repos = repos; this.root = root; this.bundleFactory = bundleFactory;
    this.idleMs = idleMs; this.leaseMs = leaseMs; this.maxSessions = maxSessions; this.maxBundleBytes = maxBundleBytes; this.maxRuntimeBytes = maxRuntimeBytes;
    this.sessions = new Map(); this.keys = new Map(); this.capabilities = new Map(); this.pending = new Map(); this.closed = false;
    this.media = media || new LivePreviewMedia({ data });
    fs.mkdirSync(path.join(data, "live-preview"), { recursive: true });
    this.timer = setInterval(() => { void this.sweep(); }, Math.min(30000, Math.max(100, idleMs / 2)));
    this.timer.unref();
  }
  async source(work, taskId = null, kind = "work", agentId = null) {
    if (taskId || agentId || kind !== "work") throw problem(400, "实时预览只使用当前作品的唯一工作区");
    const { dir } = await this.repos.project(work.repo, work.project);
    return { projectDir: dir, source: "work", task: null };
  }
  async start({ work, task, ai = false, mediaMode = "compressed", source = "work" }) {
    const checkedMode = livePreviewMediaModeSchema.safeParse(mediaMode);
    if (!checkedMode.success) throw problem(400, "Invalid preview media mode");
    if (this.closed) throw problem(503, "Live preview service stopped");
    if (work.deleted) throw problem(410, "Work is in the recycle bin");
    if (source !== "work" || task)
      throw problem(400, "实时预览只使用当前作品的唯一工作区");
    const key = work.id;
    const existing = this.sessions.get(this.keys.get(key));
    if (existing && !existing.closed) {
      existing.expires = Date.now() + this.leaseMs; existing.lastUsed = Date.now();
      return this.link(existing, ai, mediaMode);
    }
    if (this.pending.has(key)) return this.link(await this.pending.get(key), ai, mediaMode);
    const creation = this.create(work, key);
    this.pending.set(key, creation);
    try { return this.link(await creation, ai, mediaMode); } finally { this.pending.delete(key); }
  }
  async create(work, key) {
    const source = await this.source(work);
    await this.sweep();
    if (this.sessions.size >= this.maxSessions) {
      const idle = [...this.sessions.values()].filter(s => s.clients === 0 && s.manifest)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle) await this.stop(idle.id);
      else throw problem(503, "Live preview capacity is busy; close an unused preview and retry");
      // Another start can finish while the old worker is stopping.
      if (this.sessions.size >= this.maxSessions)
        throw problem(503, "Live preview capacity is busy; close an unused preview and retry");
    }
    const id = randomUUID(), secret = token(), now = Date.now();
    const session = { id, key, secret, work: work.id, repo: work.repo, project: work.project, ...source,
      outDir: path.join(this.data, "live-preview", id), expires: now + this.leaseMs, lastUsed: now,
      state: "starting", revision: 0, manifest: null, error: null, clients: 0, closed: false,
      emitter: new EventEmitter(), files: new Set(), fileBytes: new Map(), assets: new Map(), assetKeys: new Map(),
      mediaFiles: new Map(), mediaBytes: 0, mediaReserved: 0, runtimeFiles: new Map(), runtimeBytes: 0, runtimeSources: new Map(), resourceHashes: new Map(), sourceSnapshots: new Map(), releases: new Set(), publish: Promise.resolve(),
      abort: new AbortController(), mediaJobs: new Set(), lastLeaseWritten: 0, leaseWrite: Promise.resolve() };
    session.emitter.setMaxListeners(100);
    this.sessions.set(id, session); this.keys.set(key, id); this.capabilities.set(hash(secret), id);
    await this.writeLease(session);
    const fail = error => {
      if (session.closed) return;
      session.state = "error";
      const message = String(error.message || error).replaceAll(this.root, "<runtime>").replaceAll(session.projectDir, "projects/" + session.project).slice(0, 4000);
      session.error = { message, state: "error", revision: session.revision };
      session.emitter.emit("error-state", session.error);
    };
    try {
      session.worker = await this.bundleFactory({
        root: this.root, projectDir: session.projectDir, id: session.project, outDir: session.outDir,
        maxBundleBytes: this.maxBundleBytes,
        onBundle: bundle => {
          session.publish = session.publish.then(async () => {
            try { await this.publish(session, bundle); }
            catch (error) { await this.discard(session, bundle); throw error; }
          }).catch(fail);
          return session.publish;
        },
        onError: fail,
        onState: state => { if (!session.closed) session.emitter.emit("state", { state, revision: session.revision }); },
      });
    } catch (error) { fail(error); }
    return session;
  }
  async discard(session, bundle) {
    // Failed candidates never become accessible. Remove their artifacts so persistent failures stay bounded.
    for (const file of (bundle.files || []).filter(file => !session.files.has(file))) {
      const output = confined(session.outDir, file);
      await Promise.all(["", ".br", ".gz"].map(suffix => fsp.rm(output + suffix, { force: true })));
      session.resourceHashes.delete(file);
    }
    // Candidate media is not reachable until commit. Failed edits must not consume the original-media quota forever.
    for (const [revision, record] of session.mediaFiles) {
      if (session.assets.has(revision)) continue;
      await fsp.rm(record.file, { force: true });
      session.mediaFiles.delete(revision); session.mediaBytes -= record.bytes;
    }
    const retainedRuntime = new Set([...session.sourceSnapshots.values()]
      .flatMap(snapshot => snapshot.manifest.resources.filter(resource => resource.kind === "runtime")
        .map(resource => resource.path + ":" + resource.revision)));
    for (const [key, record] of session.runtimeFiles) {
      if (retainedRuntime.has(key)) continue;
      session.runtimeFiles.delete(key); session.runtimeBytes -= record.bytes;
      if (![...session.runtimeFiles.values()].some(value => value.file === record.file))
        await fsp.rm(record.file, { force: true });
    }
    for (const [relative, record] of session.runtimeSources)
      if (!session.runtimeFiles.has(relative + ":" + record.resource.revision)) session.runtimeSources.delete(relative);
    const snapshotKey = this.bundleVersion(bundle);
    if (!session.sourceSnapshots.has(snapshotKey))
      await fsp.rm(path.join(session.outDir, "source-snapshots", snapshotKey), { recursive: true, force: true });
  }
  bundleVersion(bundle) {
    return liveReviewRevision({ sourceRevision: bundle.sourceRevision, compiledRevision: bundle.compiledRevision || hash(JSON.stringify(bundle.fingerprints)) });
  }
  async publish(session, bundle) {
    const compiledRevision = bundle.compiledRevision || hash(JSON.stringify(bundle.fingerprints));
    if (session.closed || session.manifest?.sourceRevision === bundle.sourceRevision && session.manifest?.compiledRevision === compiledRevision) return;
    const entries = Object.entries(bundle.assets).map(([src, asset]) => ({ ...asset, src }));
    // Preserve all owned runtime media before publishing a revision. This is local bounded copying,
    // never full-film audio generation; already captured identities are reused.
    for (let index = 0; index < entries.length; index += 4) {
      const results = await Promise.allSettled(entries.slice(index, index + 4).map(asset => this.media.snapshot(session, asset)));
      const failed = results.find(result => result.status === "rejected");
      // Wait for sibling copies before rollback; otherwise a late sibling can register leaked candidate bytes.
      if (failed) throw failed.reason;
    }
    if (session.closed) return;
    const snapshotKey = this.bundleVersion(bundle);
    const codeDir = path.join(session.outDir, "source-snapshots", snapshotKey);
    const newSizes = new Map(session.fileBytes);
    for (const file of bundle.files) {
      const output = confined(session.outDir, file), stat = await fsp.stat(output);
      newSizes.set(file, stat.size * 3); // Bound original plus both compressed variants before allocation.
    }
    if ([...newSizes.values()].reduce((sum, bytes) => sum + bytes, 0) > this.maxBundleBytes)
      throw problem(413, "Live preview revision cache is full; reopen the preview to release old code");
    for (const source of bundle.sourceFiles || []) {
      const file = confined(codeDir, source.path);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, Buffer.from(source.content, "base64"), { mode: 0o600 });
    }
    // Precompressed artifacts avoid encoding work on slow clients and survive repeated reconnects.
    for (const file of bundle.files.filter(file => /\.(?:js|css|json|svg)$/.test(file))) {
      const output = confined(session.outDir, file);
      if (fs.existsSync(output + ".br")) continue;
      const bytes = await fsp.readFile(output);
      if (bytes.length < 1024) continue;
      const [br, compressed] = await Promise.all([
        brotli(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }),
        gz(bytes, { level: 4 }),
      ]);
      await Promise.all([fsp.writeFile(output + ".br", br), fsp.writeFile(output + ".gz", compressed)]);
    }
    const previous = session.manifest, assetRevisions = {}, audioSources = {};
    for (const asset of entries) {
      assetRevisions[asset.src] = asset.revision;
      if (AUDIO.test(asset.src) && asset.bytes >= 256 * 1024) {
        const base = "/preview-live/" + session.secret + "/audio/" + asset.revision + "/";
        const originalUrl = "/preview-live/" + session.secret + "/" + asset.src + "?v=" + asset.revision;
        const lossless = LOSSLESS_AUDIO.test(asset.src);
        audioSources[asset.src] = { revision: asset.revision, url: lossless ? base + "preview" : originalUrl,
          originalUrl, renditions: { ...(lossless ? { preview: base + "preview" } : {}), economy: base + "economy" } };
      } else if (/\.(?:wav|mp3|ogg|opus|flac|m4a|aac|aiff?)$/i.test(asset.src)) {
        audioSources[asset.src] = { revision: asset.revision, url: "/preview-live/" + session.secret + "/" + asset.src + "?v=" + asset.revision,
          originalUrl: "/preview-live/" + session.secret + "/" + asset.src + "?v=" + asset.revision };
      }
    }
    const resources = [
      ...await bundleResources(session, bundle.files),
      ...entries.map(asset => liveResource(session, asset.src, asset.revision, asset.bytes, "media")),
      ...await runtimeResources(session, this.root, this.maxRuntimeBytes),
    ];
    if (resources.length > 20000) throw problem(413, "Live preview contains too many runtime resources");
    const manifest = {
      workId: session.work, projectId: session.project,
      mediaModes: ["original", "compressed", "cached"], defaultMediaMode: "compressed", resources,
      schemaVersion: 1, sessionId: session.id, revision: session.revision + 1, source: session.source,
      sourceRevision: bundle.sourceRevision, compiledRevision, projectUrl: bundle.projectUrl, fingerprints: bundle.fingerprints,
      changes: {
        visual: !previous || previous.fingerprints.visual !== bundle.fingerprints.visual,
        audio: !previous || previous.fingerprints.audio !== bundle.fingerprints.audio,
        metadata: !previous || previous.fingerprints.metadata !== bundle.fingerprints.metadata,
      },
      assetRevisions, assetsRevision: hash(JSON.stringify(assetRevisions)), audioSources,
      audioGeneratorRevision: bundle.audioGeneratorRevision || bundle.fingerprints.audio,
      preloads: bundle.preloads || [], moduleGraph: bundle.moduleGraph || {},
      createdAt: new Date().toISOString(), buildMs: bundle.buildMs,
    };
    for (const asset of entries) {
      session.assets.set(asset.revision, asset); session.assetKeys.set(asset.src + ":" + asset.revision, asset);
    }
    session.fileBytes = newSizes; for (const file of bundle.files) session.files.add(file);
    session.shell = { playerUrl: bundle.playerUrl, styles: bundle.styles };
    session.manifest = manifest; session.revision = manifest.revision; session.state = "ready"; session.error = null;
    session.sourceSnapshots.set(snapshotKey, { codeDir, entries, manifest });
    while (session.sourceSnapshots.size > 16) {
      const oldest = session.sourceSnapshots.keys().next().value, old = session.sourceSnapshots.get(oldest);
      session.sourceSnapshots.delete(oldest); await fsp.rm(old.codeDir, { recursive: true, force: true });
    }
    session.emitter.emit("revision", manifest);
  }
  link(session, ai = false, mediaMode = "compressed") {
    const query = new URLSearchParams();
    if (ai) query.set("ai", "1");
    if (mediaMode !== "compressed") query.set("mediaMode", mediaMode);
    return { mediaMode, url: "/preview-live/" + session.secret + "/index.html" + (query.size ? "?" + query : ""),
      sessionId: session.id, sourceRevision: session.manifest?.sourceRevision || null, compiledRevision: session.manifest?.compiledRevision || null, source: session.source,

      expires: new Date(session.expires).toISOString(), state: session.manifest ? "ready" : session.state,
      revision: session.revision, ...(session.error ? { error: session.error.message } : {}) };
  }
  getByCapability(secret) {
    if (typeof secret !== "string" || secret.length > 100) throw problem(401, "Invalid live preview capability");
    const session = this.sessions.get(this.capabilities.get(hash(secret)));
    if (!session || session.closed || session.expires <= Date.now()) throw problem(401, "Live preview expired; reopen the work");
    session.lastUsed = Date.now();
    if (Date.now() - session.lastLeaseWritten > 30000) void this.writeLease(session).catch(() => {});
    return session;
  }
  async writeLease(session) {
    session.lastLeaseWritten = Date.now();
    session.leaseWrite = session.leaseWrite.then(async () => {
      if (session.closed) return;
      await fsp.mkdir(session.outDir, { recursive: true });
      await fsp.writeFile(path.join(session.outDir, ".lease.json"), JSON.stringify({ expires: session.expires, touched: Date.now() }), { mode: 0o600 });
    });
    return session.leaseWrite;
  }
  async ready(session, { timeout = 45000, signal } = {}) {
    if (session.manifest) return session.manifest;
    if (session.state === "error") throw problem(409, session.error.message);
    return new Promise((resolve, reject) => {
      const stop = () => { cleanup(); reject(problem(499, "Preview request cancelled")); };
      const ok = value => { cleanup(); resolve(value); };
      const fail = error => { cleanup(); reject(problem(409, error.message)); };
      const timer = setTimeout(() => { cleanup(); reject(problem(504, "Live preview is still preparing")); }, timeout);
      const cleanup = () => {
        clearTimeout(timer); session.emitter.off("revision", ok); session.emitter.off("error-state", fail); signal?.removeEventListener("abort", stop);
      };
      session.emitter.once("revision", ok); session.emitter.once("error-state", fail);
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
    });
  }
  snapshot(session) {
    return session.manifest || { schemaVersion: 1, sessionId: session.id, revision: 0, source: session.source, state: session.state,

      ...(session.error ? { error: session.error.message } : {}) };
  }
  attach(session, close) {
    if (session.closed || session.clients >= 32) throw problem(429, "Too many live preview viewers");
    session.clients++; session.lastUsed = Date.now(); session.releases.add(close);
    let detached = false;
    return () => { if (detached) return; detached = true; session.clients--; session.lastUsed = Date.now(); session.releases.delete(close); };
  }
  async freezeReference({ sessionId, sourceRevision, compiledRevision, repo, project }) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed || session.repo !== repo || session.project !== project)
      throw problem(404, "Live review session does not belong to this work");
    let snapshot;
    if (compiledRevision) snapshot = session.sourceSnapshots.get(liveReviewRevision({ sourceRevision, compiledRevision }));
    else {
      const matches = [...session.sourceSnapshots.values()].filter(value => value.manifest?.sourceRevision === sourceRevision);
      if (matches.length > 1) throw problem(409, "此源码有多个已显示编译版本，请重新选择当前画面");
      snapshot = matches[0] || session.sourceSnapshots.get(sourceRevision);
    }
    if (!snapshot) throw problem(410, "This live source revision has expired; refresh the review reference");
    const actualCompiledRevision = snapshot.manifest.compiledRevision;
    const versionKey = liveReviewRevision({ sourceRevision, compiledRevision: actualCompiledRevision });
    const root = path.join(this.data, "live-preview-references", session.id, versionKey),
      dir = path.join(root, "projects", project);
    if (snapshot.frozen) {
      if (await treeHash(dir, { includeIgnored: true }) !== snapshot.frozen.fingerprint) throw problem(409, "Frozen live review source was modified");
      return snapshot.frozen;
    }
    const pendingKey = "freeze:" + session.id + ":" + versionKey;
    if (this.pending.has(pendingKey)) return this.pending.get(pendingKey);
    const freezing = (async () => {
      const temporary = path.join(path.dirname(root), "." + versionKey + "-" + randomUUID()),
        temporaryDir = path.join(temporary, "projects", project);
      try {
        if (fs.existsSync(root)) throw problem(409, "Unexpected existing live review snapshot");
        await fsp.mkdir(path.dirname(temporaryDir), { recursive: true });
        await copyTree(snapshot.codeDir, temporaryDir, { includeIgnored: true });
        for (const asset of snapshot.entries) {
          const source = session.mediaFiles.get(asset.revision);
          if (!source) throw problem(410, "Live media revision has expired");
          const destination = confined(temporaryDir, "public/" + asset.src.split("/").slice(2).join("/"));
          await fsp.mkdir(path.dirname(destination), { recursive: true });
          await fsp.copyFile(source.file, destination, fs.constants.COPYFILE_FICLONE);
        }
        const fingerprint = await treeHash(temporaryDir, { includeIgnored: true });
        await fsp.rename(temporary, root);
        snapshot.frozen = { root, dir, fingerprint, sourceRevision, ...(actualCompiledRevision ? { compiledRevision: actualCompiledRevision } : {}), revision: snapshot.manifest.revision,
          sessionId: session.id, source: session.source, task: null };
        return snapshot.frozen;
      } finally { await fsp.rm(temporary, { recursive: true, force: true }); }
    })();
    this.pending.set(pendingKey, freezing);
    try { return await freezing; } finally { this.pending.delete(pendingKey); }
  }
  async stop(id) {
    const session = this.sessions.get(id);
    if (!session || session.closed) return;
    session.closed = true; session.abort.abort(problem(499, "Preview request cancelled"));
    this.sessions.delete(id); this.keys.delete(session.key); this.capabilities.delete(hash(session.secret));
    for (const release of session.releases) release(); session.releases.clear(); session.emitter.removeAllListeners();
    await session.worker?.close(); await session.publish; await session.leaseWrite;
    await Promise.allSettled(session.mediaJobs);
    await fsp.rm(session.outDir, { recursive: true, force: true });
  }
  async sweep() {
    const now = Date.now();
    await Promise.all([...this.sessions.values()].filter(session => session.expires <= now ||
      (session.clients === 0 && now - session.lastUsed > this.idleMs)).map(session => this.stop(session.id)));
    const base = path.join(this.data, "live-preview");
    for (const id of await fsp.readdir(base)) {
      if (!/^[a-f0-9-]{36}$/.test(id) || this.sessions.has(id)) continue;
      const directory = path.join(base, id), stat = await fsp.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      let lease;
      try { lease = JSON.parse(await fsp.readFile(path.join(directory, ".lease.json"), "utf8")); } catch {}
      if (lease ? lease.expires < now && lease.touched < now - this.idleMs : stat.mtimeMs < now - this.leaseMs - this.idleMs)
        await fsp.rm(directory, { recursive: true, force: true });
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    await Promise.allSettled(this.pending.values());
    await Promise.all([...this.sessions.keys()].map(id => this.stop(id)));
    await this.media.close();
  }
}
