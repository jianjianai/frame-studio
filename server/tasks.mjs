import { randomUUID } from "node:crypto";
import { problem } from "./util.mjs";

/**
 * In-memory background tasks (exports, model downloads, speech batches).
 * Progress is pushed as `task` events; finished tasks are kept for a while.
 */
export class Tasks {
  constructor(events) {
    this.events = events;
    this.items = new Map();
  }
  start({ kind, title, work, repo }, run) {
    const id = randomUUID();
    const controller = new AbortController();
    const task = {
      id,
      kind,
      title,
      work,
      repo,
      status: "running",
      progress: null,
      message: "",
      result: null,
      error: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.items.set(id, { task, controller });
    const publish = () => this.events.emit({ type: "task", task: { ...task } });
    const update = (change) => {
      Object.assign(task, change);
      publish();
    };
    publish();
    task.done = (async () => {
      try {
        task.result = await run({ signal: controller.signal, progress: (progress, message = task.message) => update({ progress, message }) });
        update({ status: "done", progress: 1, endedAt: new Date().toISOString() });
      } catch (error) {
        const cancelled = controller.signal.aborted;
        update({ status: cancelled ? "cancelled" : "failed", error: cancelled ? null : error.message, endedAt: new Date().toISOString() });
      } finally {
        this.prune();
      }
      return task;
    })();
    return task;
  }
  get(id) {
    const entry = this.items.get(id);
    if (!entry) throw problem(404, "任务不存在", "NOT_FOUND");
    const { done, ...task } = entry.task;
    return task;
  }
  wait(id, timeoutMs = 0) {
    const entry = this.items.get(id);
    if (!entry) throw problem(404, "任务不存在", "NOT_FOUND");
    const done = entry.task.done.then(() => this.get(id));
    return timeoutMs ? Promise.race([done, new Promise((resolve) => setTimeout(() => resolve(this.get(id)), timeoutMs))]) : done;
  }
  list({ work } = {}) {
    return [...this.items.values()]
      .map(({ task: { done, ...task } }) => task)
      .filter((task) => !work || task.work === work)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  cancel(id) {
    const entry = this.items.get(id);
    if (!entry) throw problem(404, "任务不存在", "NOT_FOUND");
    entry.controller.abort(new Error("已取消"));
  }
  prune() {
    const finished = [...this.items.values()].filter(({ task }) => task.status !== "running");
    for (const { task } of finished.slice(0, Math.max(0, finished.length - 50))) this.items.delete(task.id);
  }
}
