import { Worker } from "node:worker_threads";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Workspace, FrameError } from "./mcp/workspace.mjs";

const pools = new Map();
const MAX_PENDING = 64;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
function requestBytes(value, seen = new Set()) {
  if (typeof value === "string") return value.length * 2;
  if (!value || typeof value !== "object") return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  let bytes = 64;
  for (const key of Object.keys(value)) {
    bytes += key.length * 2 + requestBytes(value[key], seen);
    if (bytes > MAX_PENDING_BYTES) break;
  }
  return bytes;
}
const interactiveOperations = new Set([
  "edit",
  "patch",
  "checkpoint",
  "history",
  "restore",
  "fingerprint",
  "search",
  "listFiles",
  "check",
  "checkProject",
  "audioEdit",
  "visualEdit",
]);
function poolFor(snapshot) {
  const key = snapshot ? "snapshot" : "interactive";
  if (pools.has(key)) return pools.get(key);
  // Capturing large frozen inputs cannot occupy the editing workers.
  const pool = { size: snapshot ? 1 : 2, slots: [], queue: [], queuedBytes: 0 };
  pools.set(key, pool);
  return pool;
}
/** Fence a terminated thread's exact lock; keep transaction recovery data. */
export function releaseExitedWorkerLock(request, ownerWorkerId, ownerThreadId) {
  if (request.operation === "captureInput") return;
  const workspace = new Workspace(request.root, request.options);
  const lock = workspace.file(
    request.arguments[0],
    ".cache/mcp/operation.lock",
    true,
  );
  const read = () => {
    try {
      if (fs.lstatSync(lock).size > 8192) return null;
      return JSON.parse(fs.readFileSync(lock, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const record = read();
  if (
    record?.pid !== process.pid ||
    record.ownerWorkerId !== ownerWorkerId ||
    record.ownerThreadId !== ownerThreadId ||
    !/^[a-f0-9-]{36}$/.test(record.lockId ?? "")
  )
    return;
  const current = read();
  if (
    current?.lockId === record.lockId &&
    current.ownerWorkerId === ownerWorkerId &&
    current.ownerThreadId === ownerThreadId &&
    current.pid === process.pid
  )
    fs.unlinkSync(lock);
}
export const projectIoMetrics = () =>
  [...pools.entries()].map(([lane, pool]) => ({
    lane,
    queued: pool.queue.length,
    queuedBytes: pool.queuedBytes,
    workers: pool.slots.map((slot) => ({ busy: !!slot.job, ...slot.metrics })),
  }));
function dispatch(pool) {
  while (pool.queue.length) {
    let slot = pool.slots.find((item) => !item.job && !item.dead);
    if (!slot && pool.slots.length < pool.size) {
      let worker;
      try {
        // Pure ESM workers need no CLI/test-runner flags. Explicit inheritance
        // includes process-only V8 flags in Node's test runner and is invalid.
        worker = new Worker(
          new URL("./project-io-worker.mjs", import.meta.url),
          { execArgv: [] },
        );
      } catch (error) {
        for (const job of pool.queue.splice(0)) job.reject(error);
        pool.queuedBytes = 0;
        return;
      }
      const ownerThreadId = worker.threadId;
      slot = { worker, job: null, dead: false, metrics: null };
      pool.slots.push(slot);
      worker.unref();
      worker.on("message", (response) => {
        const job = slot.job;
        if (!job) return;
        slot.job = null;
        slot.metrics = response.metrics;
        worker.unref();
        if (response.error) {
          const data = response.error;
          const error = data.frame
            ? new FrameError(data.code, data.message, data.details)
            : Object.assign(new Error(data.message), {
                code: data.code,
                details: data.details,
              });
          job.reject(error);
        } else job.resolve(response.value);
        dispatch(pool);
      });
      worker.on("error", (error) => {
        slot.failure = error;
      });
      // The error event can precede exit. Cleanup only after the thread stopped.
      worker.on("exit", (code) => {
        if (slot.dead) return;
        slot.dead = true;
        pool.slots.splice(pool.slots.indexOf(slot), 1);
        let error = slot.failure ?? new Error("Worker exit: " + code);
        try {
          if (slot.job)
            releaseExitedWorkerLock(
              slot.job.request,
              slot.job.ownerWorkerId,
              ownerThreadId,
            );
        } catch (cleanupError) {
          error = new AggregateError(
            [error, cleanupError],
            "Worker operation lock needs inspection",
          );
        }
        slot.job?.reject(
          Object.assign(
            new Error(
              "Project I/O worker stopped; inspect the project operation before retrying.",
            ),
            { code: "PROJECT_IO_FAILED", cause: error },
          ),
        );
        slot.job = null;
        dispatch(pool);
      });
    }
    if (!slot) break;
    slot.job = pool.queue.shift();
    pool.queuedBytes -= slot.job.bytes;
    slot.job.ownerWorkerId = randomUUID();
    slot.worker.ref();
    try {
      slot.worker.postMessage({
        ...slot.job.request,
        options: {
          ...slot.job.request.options,
          ioWorkerId: slot.job.ownerWorkerId,
        },
      });
    } catch (error) {
      const job = slot.job;
      slot.job = null;
      slot.worker.unref();
      job.reject(error);
    }
  }
}
/** Internal bounded executor; workers keep verified digest caches warm. */
export function runProjectIo(request) {
  if (
    request.operation !== "captureInput" &&
    !interactiveOperations.has(request.operation)
  )
    return Promise.reject(new Error("Unsupported project I/O operation"));
  const pool = poolFor(request.operation === "captureInput");
  const bytes = requestBytes(request);
  if (
    pool.queue.length >= MAX_PENDING ||
    pool.queuedBytes + bytes > MAX_PENDING_BYTES
  )
    return Promise.reject(
      new FrameError(
        "PROJECT_BUSY",
        "Project I/O queue is full; wait and retry.",
        { retryable: true },
      ),
    );
  return new Promise((resolve, reject) => {
    pool.queuedBytes += bytes;
    pool.queue.push({ request, resolve, reject, bytes });
    dispatch(pool);
  });
}
export function projectOperationAsync(workspace, operation, ...arguments_) {
  return runProjectIo({
    root: workspace.root,
    options: {
      projects: [...workspace.projects],
      readOnly: workspace.readOnly,
      sessionId: workspace.sessionId,
      checkOptions: workspace.checkOptions,
    },
    operation,
    arguments: arguments_,
  });
}
