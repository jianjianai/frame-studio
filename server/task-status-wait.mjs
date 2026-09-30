import { AsyncLocalStorage } from "node:async_hooks";
import { problem } from "./security.mjs";
import { taskEventColumns } from "./task-summary.mjs";

const hubs = new WeakMap();
const requestSignals = new AsyncLocalStorage();
const MAX_WAITERS = 1024;
const FALLBACK_MS = 2000;
const hubFor = (db) => {
  let hub = hubs.get(db);
  if (!hub) {
    hub = { waiters: new Map(), count: 0, reads: new Map() };
    hubs.set(db, hub);
  }
  return hub;
};
export const withTaskStatusSignal = (signal, fn) =>
  requestSignals.run(signal, fn);
const aborted = (signal) => {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Request aborted", "AbortError");
};

/** Reuse the existing realtime LISTEN connection; no connection per waiter. */
export function notifyTaskStatus(db, change) {
  const hub = hubs.get(db);
  if (!hub || (change && !["tasks", "events"].includes(change.table))) return;
  const groups = change?.task
    ? [hub.waiters.get(change.task)]
    : hub.waiters.values();
  for (const group of groups) {
    for (const waiter of group ?? []) waiter.notify();
  }
}

/** Install before SELECT so a notification during the read cannot be lost. */
export function subscribeTaskStatus(
  db,
  id,
  signal = requestSignals.getStore(),
) {
  aborted(signal);
  const hub = hubFor(db);
  if (hub.count >= MAX_WAITERS)
    throw problem(503, "Too many task status waits; retry shortly");
  let group = hub.waiters.get(id);
  if (!group) hub.waiters.set(id, (group = new Set()));
  let revision = 0,
    closed = false,
    pending;
  const waiter = {
    get revision() {
      return revision;
    },
    notify() {
      revision++;
      pending?.();
    },
    async wait(since, remainingMs) {
      aborted(signal);
      if (closed || since !== revision || remainingMs <= 0) return;
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          pending = undefined;
        };
        const wake = () => {
          cleanup();
          resolve();
        };
        const cancel = () => {
          cleanup();
          reject(
            signal.reason ?? new DOMException("Request aborted", "AbortError"),
          );
        };
        const timer = setTimeout(wake, Math.min(FALLBACK_MS, remainingMs));
        pending = wake;
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        else if (since !== revision) wake();
      });
      aborted(signal);
    },
    close() {
      if (closed) return;
      closed = true;
      pending?.();
      group.delete(waiter);
      hub.count--;
      if (!group.size) hub.waiters.delete(id);
    },
  };
  group.add(waiter);
  hub.count++;
  return waiter;
}

/** Concurrent polls with the same cursor share the in-flight read, never stale data. */
export function readTaskStatus(db, tasks, { id, after, limit }) {
  const hub = hubFor(db),
    key = JSON.stringify([id, String(after), limit]);
  const existing = hub.reads.get(key);
  if (existing) return existing;
  const read = (async () => {
    const task = await tasks.summary(id);
    // Read events after state so a terminal state still drains durable events.
    const rows = await db.all(
      `SELECT ${taskEventColumns(db)} FROM events WHERE task=$1 AND id>$2 ORDER BY id LIMIT $3`,
      [id, String(after), limit + 1],
    );
    return { task, rows };
  })();
  hub.reads.set(key, read);
  const remove = () => {
    if (hub.reads.get(key) === read) hub.reads.delete(key);
  };
  void read.then(remove, remove);
  return read;
}
