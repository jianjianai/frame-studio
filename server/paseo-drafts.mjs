import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { confinedAsync, copyTree, exists, treeHash } from "./project-files.mjs";
import { problem } from "./security.mjs";
import { paseoPublicCandidate } from "./paseo-work.mjs";

const ignored = new Set([
  ".git",
  "node_modules",
  ".cache",
  ".history",
  "exports",
]);
const decimal = (value) => {
  if (
    (typeof value === "number" && !Number.isSafeInteger(value)) ||
    !/^(0|[1-9][0-9]*)$/.test(String(value))
  )
    throw Error("Invalid Paseo draft generation");
  return BigInt(value);
};
const projectId = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(64);

/** Copy this project into a unique owned run; reject mixed content and chmod races. */
export async function capturePaseoCandidate({
  data,
  work,
  projectRoot,
  generation,
  baselineFingerprint,
  baselineModeFingerprint,
  baselineCommit,
  runtimeFingerprint,
  origin = "manual",
  runId = randomUUID(),
  signal,
  copy = copyTree,
}) {
  z.uuid().parse(work.id);
  z.uuid().parse(runId);
  projectId.parse(work.project);
  const run = await confinedAsync(data, "runs/" + runId);
  const source = await confinedAsync(
    data,
    "runs/" + runId + "/projects/" + work.project,
  );
  if (await exists(run))
    throw problem(409, "Candidate run already exists; retained for recovery");
  const revision = await treeHash(projectRoot, { includeExecutableMode: true });
  const fingerprint = await treeHash(projectRoot);
  signal?.throwIfAborted();
  await fsp.mkdir(path.dirname(run), { recursive: true });
  await confinedAsync(data, "runs/" + runId);
  await fsp.mkdir(run, { mode: 0o700 });
  let complete = false;
  try {
    await fsp.mkdir(path.dirname(source), { recursive: true });
    await copy(projectRoot, source);
    signal?.throwIfAborted();
    if (
      (await treeHash(source)) !== fingerprint ||
      (await treeHash(source, { includeExecutableMode: true })) !== revision ||
      (await treeHash(projectRoot)) !== fingerprint ||
      (await treeHash(projectRoot, { includeExecutableMode: true })) !==
        revision
    )
      throw problem(409, "Draft changed while capturing candidate");
    const candidate = {
      workId: work.id,
      repo: work.repo,
      project: work.project,
      generation: decimal(generation).toString(),
      revision,
      baselineFingerprint,
      baselineModeFingerprint,
      baselineCommit,
      runId,
      snapshotFingerprint: fingerprint,
      snapshotModeFingerprint: revision,
      runtimeFingerprint,
      origin,
    };
    const handle = await fsp.open(
      path.join(run, "candidate.json"),
      "wx",
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(candidate));
      await handle.sync();
    } finally {
      await handle.close();
    }
    complete = true;
    return candidate;
  } finally {
    if (!complete) await fsp.rm(run, { recursive: true, force: true });
  }
}

async function stamp(root) {
  const rows = [];
  const walk = async (dir, relative = "") => {
    const names = (await fsp.readdir(dir))
      .filter((name) => !ignored.has(name))
      .sort();
    for (const name of names) {
      const rel = relative ? relative + "/" + name : name;
      const file = await confinedAsync(root, rel);
      const stat = await fsp.lstat(file, { bigint: true });
      rows.push([
        rel,
        stat.dev.toString(),
        stat.ino.toString(),
        stat.mode.toString(),
        stat.size.toString(),
        stat.mtimeNs.toString(),
        stat.ctimeNs.toString(),
      ]);
      if (stat.isDirectory()) await walk(file, rel);
    }
  };
  await walk(root);
  return JSON.stringify(rows);
}

function busy(native) {
  return (
    !!native?.busy ||
    !!native?.terminalBusy ||
    !!native?.incomplete ||
    (native?.activeAgents?.length || native?.activeAgentIds?.length || 0) > 0 ||
    Number(native?.activeTerminals || 0) > 0 ||
    (native?.agents || []).some((agent) =>
      ["running", "starting", "initializing", "permission"].includes(
        agent.status,
      ),
    ) ||
    Number(native?.pendingPermissions || 0) > 0
  );
}

/** Hash reconciliation is cheap and separate from the single immutable-candidate worker. */
export class PaseoDrafts {
  constructor({
    data,
    works,
    repos,
    store,
    manager,
    validate,
    publish,
    recoverCandidate,
    debounceMs = 250,
    reconcileMs = 15000,
    onChange = () => {},
    onError = () => {},
  }) {
    Object.assign(this, {
      data,
      works,
      repos,
      store,
      manager,
      validate,
      publish,
      recoverCandidate,
      debounceMs,
      reconcileMs,
      onChange,
      onError,
    });
    this.entries = new Map();
    this.starting = new Map();
    this.closed = false;
  }
  async start(workId) {
    if (this.closed) throw Error("Paseo draft watcher is closed");
    if (this.entries.has(workId)) return this.reconcile(workId);
    if (this.starting.has(workId)) return this.starting.get(workId);
    const pending = this.open(workId);
    this.starting.set(workId, pending);
    try {
      return await pending;
    } finally {
      if (this.starting.get(workId) === pending) this.starting.delete(workId);
    }
  }
  async open(workId) {
    const work = await this.works.get(workId, { active: true });
    const ready = await this.manager.ensure(work);
    if (this.closed) return;
    const entry = {
      work,
      ready,
      watchers: [],
      chain: Promise.resolve(),
      worker: null,
      pendingWork: false,
      controller: new AbortController(),
      stamp: null,
      timer: null,
      interval: null,
    };
    this.entries.set(workId, entry);
    const schedule = (file) => {
      if (
        file &&
        String(file)
          .split(/[\\/]/)
          .some((part) => ignored.has(part))
      )
        return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(
        () =>
          this.reconcile(workId).catch((error) => this.onError(workId, error)),
        this.debounceMs,
      );
      entry.timer.unref?.();
    };
    try {
      try {
        entry.watchers.push(
          fs.watch(ready.projectRoot, { recursive: true }, (_event, file) =>
            schedule(file),
          ),
        );
      } catch (error) {
        if (
          ![
            "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
            "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM_WIN32",
          ].includes(error.code)
        )
          throw error;
      }
      // validate/publish callbacks rejoin their exact durable worker/journal, never deliver a model turn.
      const interrupted = await this.store.listCandidates(workId, {
        states: ["validating", "publishing"],
      });
      for (const candidate of interrupted) {
        const ownership = await this.recoverCandidate?.(candidate);
        if (ownership?.active) continue;
        await this.store.transitionCandidate(candidate.id, {
          from: [candidate.state],
          state:
            candidate.state === "validating" ? "queued_validation" : "verified",
        });
      }
      entry.interval = setInterval(
        () =>
          this.reconcile(workId).catch((error) => this.onError(workId, error)),
        this.reconcileMs,
      );
      entry.interval.unref?.();
      return await this.reconcile(workId);
    } catch (error) {
      await this.stop(workId);
      throw error;
    }
  }
  async discardUnregistered(candidate) {
    if (await this.store.getCandidateByRun(candidate.runId)) return;
    const run = await confinedAsync(this.data, "runs/" + candidate.runId);
    const record = JSON.parse(
      await fsp.readFile(path.join(run, "candidate.json"), "utf8"),
    );
    if (record.runId !== candidate.runId || record.workId !== candidate.workId)
      throw Error("Candidate cleanup identity changed");
    await fsp.rm(run, { recursive: true });
  }
  reconcile(workId, { force = false } = {}) {
    const entry = this.entries.get(workId);
    if (!entry) return Promise.resolve(null);
    const operation = entry.chain
      .catch(() => {})
      .then(async () => {
        if (entry.controller.signal.aborted) return null;
        const signature = await stamp(entry.ready.projectRoot);
        if (force || signature !== entry.stamp) {
          const revision = await treeHash(entry.ready.projectRoot, {
            includeExecutableMode: true,
          });
          entry.stamp = signature;
          const changed = await this.store.markDraft(workId, { revision });
          await this.onChange(workId, {
            revision,
            generation: changed.generation,
          });
        }
        const binding = await this.store.getWork(workId);
        if (!binding) throw Error("Paseo work binding missing");
        if (busy(await this.manager.observe(workId))) return binding;
        const candidates = await this.store.listCandidates(workId, {
          states: [
            "queued_validation",
            "validating",
            "verified",
            "publishing",
            "applied",
            "invalid",
            "publish_failed",
            "conflict",
          ],
        });
        // A source already equal to the applied baseline is clean; opening does not create fake changes.
        // Capture after publication completes so a new revision records the new baseline.
        if (
          binding.draftRevision !== binding.baselineModeFingerprint &&
          !candidates.some((candidate) => candidate.state === "publishing") &&
          !candidates.some(
            (candidate) => candidate.revision === binding.draftRevision,
          )
        ) {
          let candidate;
          try {
            candidate = await capturePaseoCandidate({
              data: this.data,
              work: entry.work,
              projectRoot: entry.ready.projectRoot,
              generation: binding.generation,
              baselineFingerprint: binding.baselineFingerprint,
              baselineModeFingerprint: binding.baselineModeFingerprint,
              baselineCommit: binding.baselineCommit,
              runtimeFingerprint: entry.ready.runtimeFingerprint,
              signal: entry.controller.signal,
            });
            const saved = await this.store.createCandidate(candidate);
            if (!saved.created && saved.candidate.runId !== candidate.runId)
              await this.discardUnregistered(candidate);
          } catch (error) {
            if (candidate)
              await this.discardUnregistered(candidate).catch(() => {});
            if (error.statusCode !== 409) throw error;
            // A concurrent save invalidates only this capture, not the draft or the last valid candidate.
            clearTimeout(entry.timer);
            entry.timer = setTimeout(
              () =>
                this.reconcile(workId, { force: true }).catch((next) =>
                  this.onError(workId, next),
                ),
              this.debounceMs,
            );
            entry.timer.unref?.();
          }
        }
        this.kick(workId);
        return binding;
      });
    entry.chain = operation;
    return operation;
  }
  kick(workId) {
    const entry = this.entries.get(workId);
    if (!entry || entry.controller.signal.aborted) return;
    if (entry.worker) {
      entry.pendingWork = true;
      return;
    }
    entry.pendingWork = false;
    entry.worker = this.drain(workId)
      .catch((error) => this.onError(workId, error))
      .finally(() => {
        entry.worker = null;
        if (entry.pendingWork && this.entries.get(workId) === entry)
          this.kick(workId);
      });
  }
  async drain(workId) {
    const entry = this.entries.get(workId);
    for (;;) {
      if (
        !entry ||
        entry.controller.signal.aborted ||
        busy(await this.manager.observe(workId))
      )
        return;
      const rows = await this.store.listCandidates(workId, {
        states: ["queued_validation", "verified"],
      });
      rows.sort((a, b) =>
        decimal(a.generation) === decimal(b.generation)
          ? 0
          : decimal(a.generation) > decimal(b.generation)
            ? -1
            : 1,
      );
      const candidate = rows[0];
      if (!candidate) return;
      for (const older of rows.slice(1))
        await this.store.transitionCandidate(older.id, {
          from: [older.state],
          state: "superseded",
        });
      try {
        if (candidate.state === "queued_validation") {
          const claimed = await this.store.transitionCandidate(candidate.id, {
            from: ["queued_validation"],
            state: "validating",
          });
          if (!claimed) continue;
          const result = await this.validate(candidate, {
            signal: entry.controller.signal,
          });
          entry.controller.signal.throwIfAborted();
          if (
            result.status !== "passed" ||
            result.fingerprint !== candidate.snapshotFingerprint ||
            result.modeFingerprint !== candidate.snapshotModeFingerprint
          )
            throw Error(
              "Validator receipt does not match the frozen candidate",
            );
          const current = await treeHash(entry.ready.projectRoot, {
            includeExecutableMode: true,
          });
          if (current !== candidate.revision) {
            await this.store.transitionCandidate(candidate.id, {
              from: ["validating"],
              state: "superseded",
            });
            await this.reconcile(workId, { force: true });
            continue;
          }
          if (
            !(await this.store.transitionCandidate(candidate.id, {
              from: ["validating"],
              state: "verified",
              patch: { result },
            }))
          )
            continue;
          candidate.state = "verified";
          candidate.result = result;
        }
        if (busy(await this.manager.observe(workId))) return;
        const current = await treeHash(entry.ready.projectRoot, {
          includeExecutableMode: true,
        });
        if (current !== candidate.revision) {
          await this.store.transitionCandidate(candidate.id, {
            from: ["verified"],
            state: "superseded",
          });
          await this.reconcile(workId, { force: true });
          continue;
        }
        const { dir } = await this.repos.project(
          entry.work.repo,
          entry.work.project,
        );
        const canonical = await treeHash(dir),
          canonicalMode = await treeHash(dir, { includeExecutableMode: true });
        const baseline =
          canonical === candidate.baselineFingerprint &&
          canonicalMode === candidate.baselineModeFingerprint;
        const resumedApply =
          canonical === candidate.snapshotFingerprint &&
          canonicalMode === candidate.snapshotModeFingerprint;
        if (!baseline && !resumedApply) {
          await this.store.transitionCandidate(candidate.id, {
            from: ["verified"],
            state: "conflict",
            patch: {
              error:
                "Canonical source changed; draft and candidate retained for resolution",
            },
          });
          return;
        }
        if (
          !(await this.store.transitionCandidate(candidate.id, {
            from: ["verified"],
            state: "publishing",
          }))
        )
          continue;
        const result = await this.publish(candidate, {
          signal: entry.controller.signal,
        });
        await this.store.appliedCandidate(candidate.id, {
          sourceRevision: candidate.snapshotFingerprint,
          commit: result.commit || null,
        });
        await this.onChange(workId, {
          applied: candidate.id,
          sourceRevision: candidate.snapshotFingerprint,
        });
        await this.reconcile(workId, { force: true });
      } catch (error) {
        if (entry.controller.signal.aborted) {
          await this.store.transitionCandidate(candidate.id, {
            from: ["validating"],
            state: "queued_validation",
          });
          return; // Publishing keeps its durable journal for the next controller.
        }
        const latest = await this.store.getCandidate(candidate.id);
        if (["validating", "publishing"].includes(latest?.state))
          await this.store.transitionCandidate(candidate.id, {
            from: [latest.state],
            state: latest.state === "publishing" ? "publish_failed" : "invalid",
            patch: { error: String(error.message).slice(0, 2000) },
          });
        this.onError(workId, error);
      }
    }
  }
  async retry(workId, candidateId) {
    await this.works.get(workId, { active: true });
    const candidate = await this.store.getCandidate(candidateId);
    if (
      candidate?.workId !== workId ||
      !["invalid", "publish_failed"].includes(candidate.state)
    )
      throw problem(409, "This candidate is not waiting for a retry");
    const changed = await this.store.transitionCandidate(candidateId, {
      from: [candidate.state],
      state:
        candidate.state === "publish_failed" ? "verified" : "queued_validation",
      patch: { error: null },
    });
    this.kick(workId);
    return paseoPublicCandidate(
      changed || (await this.store.getCandidate(candidateId)),
    );
  }
  async apply(workId, candidateId) {
    await this.works.get(workId, { active: true });
    const candidate = await this.store.getCandidate(candidateId);
    if (
      candidate?.workId !== workId ||
      !["verified", "publish_failed", "applied"].includes(candidate.state)
    )
      throw problem(409, "Only a verified candidate can be applied");
    if (candidate.state === "publish_failed")
      return this.retry(workId, candidateId);
    this.kick(workId);
    return paseoPublicCandidate(candidate);
  }
  async stop(workId) {
    const entry = this.entries.get(workId);
    if (!entry) return;
    this.entries.delete(workId);
    clearTimeout(entry.timer);
    clearInterval(entry.interval);
    for (const watcher of entry.watchers) watcher.close();
    entry.controller.abort(Error("Paseo watcher stopped"));
    await Promise.allSettled([entry.chain, entry.worker].filter(Boolean));
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.starting.values()]);
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }
}
