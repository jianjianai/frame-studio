import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { treeHash } from "./project-files.mjs";
import { problem } from "./security.mjs";
import { paseoPublicValidation } from "./paseo-work.mjs";

const ignored = new Set([".git", "node_modules", ".cache", ".history", "exports"]);
async function stamp(root) {
  const rows = [];
  async function walk(dir, relative = "") {
    for (const name of (await fsp.readdir(dir)).filter(name => !ignored.has(name)).sort()) {
      const relativeFile = relative ? relative + "/" + name : name;
      const file = path.join(dir, name), stat = await fsp.lstat(file, { bigint: true });
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1n || !stat.isFile() && !stat.isDirectory())
        throw problem(400, "Links and special files are not allowed");
      rows.push([relativeFile, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String));
      if (stat.isDirectory()) await walk(file, relativeFile);
    }
  }
  await walk(root);
  return JSON.stringify(rows);
}
const busy = native => native?.incomplete || native?.activeAgents?.length || native?.activeTerminals || native?.pendingPermissions;

/** Observe the sole checkout and validate in its existing runtime. Reports never apply or replace source. */
export class PaseoWorkspace {
  constructor({ data, works, repos, store, manager, validate, debounceMs = 500, reconcileMs = 15000,
    onChange = () => {}, onError = () => {} }) {
    Object.assign(this, { data, works, repos, store, manager, validate, debounceMs, reconcileMs, onChange, onError });
    this.entries = new Map(); this.starting = new Map(); this.closed = false;
  }
  async start(workId) {
    if (this.closed) throw Error("Paseo workspace watcher is closed");
    if (this.entries.has(workId)) return this.reconcile(workId);
    if (this.starting.has(workId)) return this.starting.get(workId);
    const operation = this.open(workId); this.starting.set(workId, operation);
    try { return await operation; } finally { this.starting.delete(workId); }
  }
  async open(workId) {
    const work = await this.works.get(workId, { active: true }), ready = await this.manager.ensure(work);
    if (this.closed) return;
    const entry = { work, ready, chain: Promise.resolve(), worker: null, pending: false, controller: new AbortController(),
      signature: null, watcher: null, timer: null, interval: null };
    this.entries.set(workId, entry);
    const schedule = file => {
      if (file && String(file).split(/[\\/]/).some(part => ignored.has(part))) return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.reconcile(workId).catch(error => this.onError(workId, error)), this.debounceMs);
      entry.timer.unref?.();
    };
    try {
      try { entry.watcher = fs.watch(ready.projectRoot, { recursive: true }, (_event, file) => schedule(file)); }
      catch (error) { if (!error.code?.startsWith("ERR_FEATURE_UNAVAILABLE")) throw error; }
      // A restarted controller cancels only the recorded validation process before retrying its current revision.
      for (const report of await this.store.listValidations(workId, { states: ["running"] })) {
        await this.manager.cancelValidation?.(workId, report.id);
        await this.store.updateValidation(report.id, { from: ["running"], state: "queued" });
      }
      entry.interval = setInterval(() => this.reconcile(workId).catch(error => this.onError(workId, error)), this.reconcileMs);
      entry.interval.unref?.();
      return this.reconcile(workId);
    } catch (error) { await this.stop(workId); throw error; }
  }
  reconcile(workId, { force = false } = {}) {
    const entry = this.entries.get(workId);
    if (!entry) return Promise.resolve(null);
    const operation = entry.chain.catch(() => {}).then(async () => {
      if (entry.controller.signal.aborted) return null;
      const signature = await stamp(entry.ready.projectRoot);
      if (signature !== entry.signature || force) {
        const revision = await treeHash(entry.ready.projectRoot, { includeExecutableMode: true });
        const changed = await this.store.markRevision(workId, { revision });
        entry.signature = signature;
        await this.onChange(workId, { revision, generation: changed.generation });
      }
      const binding = await this.store.getWork(workId);
      if (!binding) throw Error("Paseo workspace binding missing");
      if (!busy(await this.manager.observe(workId))) {
        await this.store.createValidation({ workId, revision: binding.revision, generation: binding.generation,
          runtimeFingerprint: entry.ready.runtimeFingerprint });
        this.kick(workId);
      }
      return binding;
    });
    entry.chain = operation;
    return operation;
  }
  kick(workId) {
    const entry = this.entries.get(workId);
    if (!entry || entry.controller.signal.aborted) return;
    if (entry.worker) { entry.pending = true; return; }
    entry.pending = false;
    entry.worker = this.drain(workId).catch(error => this.onError(workId, error)).finally(() => {
      entry.worker = null;
      if (entry.pending && this.entries.get(workId) === entry) this.kick(workId);
    });
  }
  async drain(workId) {
    const entry = this.entries.get(workId);
    for (;;) {
      if (!entry || entry.controller.signal.aborted || busy(await this.manager.observe(workId))) return;
      const binding = await this.store.getWork(workId);
      const reports = await this.store.listValidations(workId, { states: ["queued"] });
      for (const report of reports)
        if (report.revision !== binding.revision || report.runtimeFingerprint !== entry.ready.runtimeFingerprint)
          await this.store.updateValidation(report.id, { from: ["queued"], state: "stale" });
      const report = reports.find(row => row.revision === binding.revision && row.runtimeFingerprint === entry.ready.runtimeFingerprint);
      if (!report) return;
      if (!await this.store.updateValidation(report.id, { from: ["queued"], state: "running", error: null })) continue;
      const controller = new AbortController();
      entry.validation = { reportId: report.id, controller };
      const signal = AbortSignal.any([entry.controller.signal, controller.signal]);
      try {
        const result = await this.validate(report, { signal });
        signal.throwIfAborted();
        const current = await treeHash(entry.ready.projectRoot, { includeExecutableMode: true });
        const state = current !== report.revision || result.stale ? "stale" : result.status === "passed" ? "passed" : "failed";
        if (state === "passed" && result.modeFingerprint !== report.revision)
          throw Error("Validation receipt does not match the workspace revision");
        const saved = await this.store.updateValidation(report.id, { from: ["running"], state, result,
          error: state === "failed" ? String(result.error || "作品验证失败").slice(0, 2000) : null });
        if (!saved) continue;
        await this.onChange(workId, { revision: current, validation: report.id, state });
        if (state === "stale") await this.reconcile(workId, { force: true });
      } catch (error) {
        if (signal.aborted) {
          await this.store.updateValidation(report.id, { from: ["running"], state: "cancelled", error: null });
          if (entry.controller.signal.aborted) return;
          continue;
        }
        const current = await treeHash(entry.ready.projectRoot, { includeExecutableMode: true }).catch(() => null);
        await this.store.updateValidation(report.id, { from: ["running"], state: current === report.revision ? "failed" : "stale",
          error: String(error.message).slice(0, 2000) });
        this.onError(workId, error);
        if (current !== report.revision) await this.reconcile(workId, { force: true });
      } finally {
        if (entry.validation?.controller === controller) entry.validation = null;
      }
    }
  }
  async request(workId, { wait = false, signal, reportId } = {}) {
    signal?.throwIfAborted();
    await this.works.get(workId, { active: true });
    const ready = await this.manager.ensure(workId);
    const revision = await treeHash(ready.projectRoot, { includeExecutableMode: true });
    const { generation } = await this.store.markRevision(workId, { revision });
    let report;
    if (reportId) {
      report = await this.store.getValidation(reportId);
      if (report?.workId !== workId) throw problem(404, "验证报告不属于当前作品");
      if (report.revision !== revision || report.runtimeFingerprint !== ready.runtimeFingerprint)
        return { ...report, state: "stale", error: "作品已更新，此报告不能代表当前源码" };
    } else report = await this.store.createValidation({ workId, revision, generation, runtimeFingerprint: ready.runtimeFingerprint });
    if (["failed", "cancelled", "stale"].includes(report.state))
      report = await this.store.updateValidation(report.id, { from: [report.state], state: "queued", error: null, result: null }) || report;
    // API processes only enqueue metadata. The elected controller owns workers and source observation.
    if (this.manager.localMode || this.manager.tasks?.lease?.held) {
      if (!this.entries.has(workId)) await this.start(workId);
      this.kick(workId);
    }
    if (!wait || !["queued", "running"].includes(report.state)) return report;
    const cancel = async () => {
      const running = this.entries.get(workId)?.validation;
      if (running?.reportId === report.id) running.controller.abort(signal.reason || Error("Validation cancelled"));
      await this.manager.cancelValidation?.(workId, report.id);
      await this.store.updateValidation(report.id, { from: ["queued", "running"], state: "cancelled", error: null });
    };
    try {
      while (["queued", "running"].includes(report.state)) {
        signal?.throwIfAborted();
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason || Error("Validation wait cancelled")); };
          const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 200);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) { signal.removeEventListener("abort", abort); abort(); }
        });
        report = await this.store.getValidation(report.id);
        if (!report) throw Error("Validation report was removed while waiting");
      }
      return report;
    } catch (error) {
      if (signal?.aborted) await cancel().catch(() => {});
      throw error;
    }
  }
  async retry(workId, reportId) {
    await this.works.get(workId, { active: true });
    const report = await this.store.getValidation(reportId), binding = await this.store.getWork(workId);
    if (report?.workId !== workId || !["failed", "cancelled"].includes(report.state))
      throw problem(409, "此验证报告不能重试");
    if (report.revision !== binding.revision) throw problem(409, "源码已更新，请验证当前版本");
    const updated = await this.store.updateValidation(reportId, { from: [report.state], state: "queued", error: null });
    this.kick(workId);
    return paseoPublicValidation(updated || await this.store.getValidation(reportId));
  }
  async stop(workId) {
    const entry = this.entries.get(workId);
    if (!entry) return;
    this.entries.delete(workId); clearTimeout(entry.timer); clearInterval(entry.interval); entry.watcher?.close();
    entry.controller.abort(Error("Paseo workspace watcher stopped"));
    await Promise.allSettled([entry.chain, entry.worker].filter(Boolean));
  }
  async close() { this.closed = true; await Promise.allSettled([...this.starting.values()]);
    await Promise.all([...this.entries.keys()].map(id => this.stop(id))); }
}
