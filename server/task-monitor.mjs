import { ingestAgentEvents } from "./agent-event-store.mjs";
import fs from "node:fs";
import path from "node:path";
import { confined } from "./security.mjs";

/** Observability failures do not imply execution failures; cursors are persisted in SQL. */
export class TaskMonitor {
  constructor({ db, data, command, get, complete, failTask, localProcesses = null }) {
    Object.assign(this, { db, data, command, get, complete, failTask, localProcesses });
    this.logs = new Map();
    this.monitorWarnings = new Map();
    this.missingContainers = new Map();
  }
  async monitorWarning(t, phase, error) {
    const message = String(error?.message || error).slice(0, 1500);
    const previous = this.monitorWarnings.get(t.id);
    if (previous?.message === message && Date.now() - previous.checked < 30000) return;
    const monitor = { phase, message, checked: Date.now(), since: previous?.since || Date.now() };
    this.monitorWarnings.set(t.id, monitor);
    try {
      await this.db.pool.query("UPDATE tasks SET monitor=$2 WHERE id=$1 AND state IN ('running','cancelling')", [t.id, monitor]);
      await this.db.event(t.id, "monitor-warning", monitor);
    } catch (e) { console.error("Task monitoring unavailable:", e.message); }
  }
  async observeTask(t) {
    // Optional diagnostic files must never determine whether the execution lives.
    let diagnosticError = false;
    try {
      const progressFile = confined(path.join(this.data, "runs", t.id), "progress.json");
      if (fs.existsSync(progressFile) && fs.statSync(progressFile).size < 4096) {
        const value = JSON.parse(fs.readFileSync(progressFile, "utf8"));
        const progress = { stage: String(value.stage || "正在处理").slice(0, 100) };
        if (Number.isFinite(value.total) && value.total > 0 && Number.isFinite(value.completed))
          Object.assign(progress, { total: value.total, completed: Math.max(0, Math.min(value.completed, value.total)) });
        if (JSON.stringify(progress) !== JSON.stringify(t.progress))
          await this.db.pool.query("UPDATE tasks SET progress=$2 WHERE id=$1", [t.id, progress]);
      }
    } catch (e) {
      diagnosticError = true;
      await this.monitorWarning(t, "progress", e);
    }
    let state;
    try {
      state = this.localProcesses
        ? this.localProcesses.inspect(t.id, t.container)
        : JSON.parse(await this.command("docker", ["inspect", "--format", "{{json .State}}", t.container], { timeout: 10000, max: 65536 }));
      if (typeof state?.Running !== "boolean" || (!state.Running && !Number.isInteger(state.ExitCode)))
        throw Error("Docker returned an incomplete task state");
      this.missingContainers.delete(t.id);
    } catch (e) {
      const missing = this.localProcesses || /No such (?:object|container)/i.test(e.message);
      const count = missing ? (this.missingContainers.get(t.id) || 0) + 1 : 0;
      this.missingContainers.set(t.id, count);
      await this.monitorWarning(t, this.localProcesses ? "local-worker" : "docker", e);
      // Confirm repeated absence against a healthy daemon, not a broken connection.
      if (count >= 3 && Date.now() - new Date(t.started).getTime() > 120000) {
        if (!this.localProcesses)
          await this.command("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10000 });
        await this.failTask(t, this.localProcesses
          ? "本机执行进程连续多次确认不存在；工作副本已保留，请检查后重试。"
          : "执行容器连续多次确认不存在；工作副本已保留，请检查后重试。");
      }
      return;
    }
    t = await this.get(t.id);
    const timedOut = t.state === "running" && Date.now() - new Date(t.started).getTime() - Number(t.input_wait_ms || 0) - (t.input_wait_started ? Math.max(0, Date.now() - new Date(t.input_wait_started).getTime()) : 0) >
      Math.max(600, Math.min(604800, Number(process.env.FRAME_TASK_TIMEOUT_SECONDS) || 21600)) * 1000;
    if (state.Running && (t.state === "cancelling" || timedOut)) {
      // Successful stop is followed by a fresh inspect on the next tick. A failed
      // stop is a monitoring problem, not permission to force-remove the container.
      if (this.localProcesses) await this.localProcesses.stop(t.id, t.container);
      else await this.command("docker", ["stop", "-t", "5", t.container], { timeout: 20000 });
      return;
    }
    if (timedOut && !state.Running) {
      await this.failTask(t, "创作超过服务器配置的运行时限，隔离工作区产物已保留，可重新继续。");
    } else {
      try {
        if (t.kind === "agent") {
          do { if (!(await this.collectEvents(t))) break; } while (!state.Running);
        } else {
          const log = this.localProcesses ? this.localProcesses.logs(t.id)
            : await this.command("docker", ["logs", "--tail", "1500", t.container], { timeout: 10000, max: 1024 * 1024, combined: true });
          if (log !== this.logs.get(t.id)) {
            const old = this.logs.get(t.id) || "";
            const delta = log.startsWith(old) ? log.slice(old.length) : log;
            if (delta) await this.db.event(t.id, "log", { text: delta.slice(-64000) });
            this.logs.set(t.id, log);
          }
        }
      } catch (e) {
        diagnosticError = true;
        await this.monitorWarning(t, "events", e);
      }
      if (!state.Running) {
        try { await this.complete(t, state.ExitCode); }
        catch (e) {
          if (e.executionFailed) await this.failTask(t, e.message);
          else { await this.monitorWarning(t, "publication", e); return; }
        }
      }
    }
    if (!diagnosticError && (t.monitor || this.monitorWarnings.has(t.id))) {
      await this.db.pool.query("UPDATE tasks SET monitor=NULL WHERE id=$1", [t.id]);
      this.monitorWarnings.delete(t.id);
    }
    if (!state.Running && ["succeeded", "failed", "cancelled"].includes((await this.get(t.id)).state)) {
      if (!this.localProcesses)
        await this.command("docker", ["rm", t.container], { timeout: 10000 }).catch(() => {});
      this.logs.delete(t.id);
      this.missingContainers.delete(t.id);
    }
  }
  async collectEvents(task) {
    return ingestAgentEvents(this.db, this.data, task);
  }
}
