import fs from "node:fs/promises";
import path from "node:path";
import { command } from "./process.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";

export function runtimeLimits(env = process.env) {
  const concurrency = Number(env.FRAME_TASK_CONCURRENCY ?? 2);
  const minFreeBytes = Number(env.FRAME_MIN_FREE_BYTES ?? 1073741824);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw Error("FRAME_TASK_CONCURRENCY must be an integer from 1 to 8");
  if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0)
    throw Error("FRAME_MIN_FREE_BYTES must be a nonnegative safe integer");
  return { concurrency, minFreeBytes };
}

export async function diskCapacity(root) {
  const stat = await fs.statfs(root);
  return { totalBytes: stat.blocks * stat.bsize, freeBytes: stat.bavail * stat.bsize };
}

async function usage(root, deadline) {
  let bytes = 0, entries = 0, partial = false;
  const pending = [root];
  while (pending.length) {
    if (Date.now() >= deadline || entries >= 10000) { partial = true; break; }
    const dir = pending.pop();
    try {
      for await (const entry of await fs.opendir(dir)) {
        if (++entries > 10000 || Date.now() >= deadline) { partial = true; break; }
        if (entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) pending.push(file);
        else if (entry.isFile()) {
          try { bytes += (await fs.lstat(file)).size; } catch { partial = true; }
        }
      }
    } catch (error) { if (error.code !== "ENOENT") partial = true; }
    if (partial) break;
  }
  return { bytes, entries, partial };
}

export class RuntimeStatus {
  constructor({ db, data, tasks, speechUrl }) {
    Object.assign(this, { db, data, tasks, speechUrl });
    this.cached = null;
    this.pending = null;
  }
  async read() {
    if (this.cached && Date.now() - this.cached.checked < 30000) return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.collect().then((value) => (this.cached = value)).finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect() {
    const localMode = this.db.kind === "sqlite";
    const probe = async (fn) => {
      try { return { ok: true, ...(await fn()) }; }
      catch { return { ok: false }; }
    };
    const controller = !localMode && process.env.FRAME_ROLE === "api" ? await this.db.setting("controller-runtime") : null;
    const currentRuntime = !localMode && process.env.FRAME_ROLE === "api" ? await runtimeIdentity() : null;
    const controllerReady = !!controller?.leader && Date.now() - controller.checked < 40000 && controller.runtimeFingerprint === currentRuntime?.fingerprint;
    const [docker, speech, disk, queue] = await Promise.all([
      localMode ? Promise.resolve({ ok: true, mode: "windows-native", version: process.version })
      : process.env.FRAME_ROLE === "api"
        ? Promise.resolve(controllerReady ? controller.docker : { ok: false, error: "控制器未连接、心跳过期或运行时版本不一致" })
        : probe(async () => ({ version: (await command("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 3000, max: 65536 })).trim() })),
      probe(async () => {
        const response = await fetch(this.speechUrl + "/healthz", { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw Error("Speech unavailable");
        return {};
      }),
      probe(() => diskCapacity(this.data)),
      this.db.one(localMode
        ? "SELECT count(*) FILTER (WHERE state='queued') AS queued,count(*) FILTER (WHERE state IN ('running','cancelling')) AS running,count(*) FILTER (WHERE state='publishing') AS publishing,count(*) FILTER (WHERE state='publish_failed') AS needs_recovery,COALESCE((julianday(frame_now())-julianday(min(created) FILTER (WHERE state='queued')))*86400,0) AS oldest_wait_seconds FROM tasks"
        : "SELECT count(*) FILTER (WHERE state='queued')::int AS queued,count(*) FILTER (WHERE state IN ('running','cancelling'))::int AS running,count(*) FILTER (WHERE state='publishing')::int AS publishing,count(*) FILTER (WHERE state='publish_failed')::int AS needs_recovery,COALESCE(EXTRACT(epoch FROM now()-(min(created) FILTER (WHERE state='queued'))),0)::float8 AS oldest_wait_seconds FROM tasks"),
    ]);
    const sizes = {}, deadline = Date.now() + 2000;
    for (const name of ["works", "repos", "libraries", "blobs", "runs", "sessions", "tools"])
      sizes[name] = await usage(path.join(this.data, name), deadline);
    const schema = await this.db.all("SELECT id,checksum,applied FROM frame_schema_migrations ORDER BY id");
    const limits = controllerReady ? controller.limits : this.tasks.limits;
    return {
      checked: Date.now(), docker, speech, disk, queue, schema, sizes, limits,
      controller: !localMode && process.env.FRAME_ROLE === "api" ? { connected: controllerReady, checked: controller?.checked || null } : { embedded: true },
      queueBlocked: controllerReady ? controller.queueBlocked : this.tasks.queueBlocked || null,
      ready: docker.ok && speech.ok && disk.ok && disk.freeBytes >= limits.minFreeBytes,
    };
  }
}
