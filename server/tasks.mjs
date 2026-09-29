import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { command } from "./process.mjs";
import {
  confined,
  problem,
  token,
  hash,
} from "./security.mjs";
import { snapshotVersion, versionTree } from "./version-review.mjs";
import { TaskPublication } from "./task-publication.mjs";
import { TaskMonitor } from "./task-monitor.mjs";
import { copyTree, treeHash } from "./project-files.mjs";
import { seedPreviewAudio } from "./preview-audio-seed.mjs";
import { executionRuntime } from "./execution-runtime.mjs";
import { runtimeLimits, diskCapacity } from "./runtime-status.mjs";
import { executableTaskKindSchema } from "../src/contracts/platform.mjs";
import { ControllerLease } from "./controller-lease.mjs";
export class Tasks {
  constructor(db, data, repos, secrets, { runCommand = command } = {}) {
    this.command = async (...args) => {
      if (args[0] === "docker" && ["run", "stop", "rm"].includes(args[1]?.[0])) await this.assertLeadership();
      return runCommand(...args);
    };
    this.controllerId = randomUUID();
    this.limits = runtimeLimits();
    this.queueBlocked = null;
    this.db = db;
    this.data = data;
    this.repos = repos;
    this.secrets = secrets;
    this.publication = new TaskPublication({
      db, data, repos, get: id => this.get(id), finishCancellation: id => this.finishCancellation(id),
    });
    this.monitor = new TaskMonitor({
      db, data, command: (...args) => this.command(...args), get: id => this.get(id),
      complete: (task, exit) => this.complete(task, exit), failTask: (task, message) => this.failTask(task, message),
    });
    this.ticking = false;
    this.closed = false;
    fs.mkdirSync(path.join(data, "runs"), { recursive: true });
    fs.mkdirSync(path.join(data, "sessions"), { recursive: true });
  }
  async create({
    repo,
    project,
    kind,
    input = {},
    chat = null,
    requestKey = null,
  }) {
    input = JSON.parse(JSON.stringify(input));
    if (!executableTaskKindSchema.safeParse(kind).success)
      throw problem(400, "Unknown task kind");
    if (kind === "tools-update") {
      if (
        !["codex", "claude"].includes(input.provider) ||
        !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(input.version)
      )
        throw problem(400, "Choose a provider and explicit semver version");
    } else await this.repos.project(repo, project, { exists: kind !== "new" });
    if (input.version && kind !== "tools-update") {
      if (kind !== "build") throw problem(400, "历史版本只支持只读预览");
      await versionTree(this.repos, { repo, project }, input.version);
    }
    const id = randomUUID();
    const insert = async () => {
      if (requestKey) {
        const existing = await this.db.one(
          "SELECT * FROM tasks WHERE request_key=$1",
          [requestKey],
        );
        if (existing) {
          if (
            existing.repo !== repo ||
            existing.project !== project ||
            existing.chat !== chat ||
            !isDeepStrictEqual(existing.input, input)
          )
            throw problem(409, "Message request key already used");
          return existing;
        }
      }
      if (repo && kind !== "agent" && !input.version) await this.repos.writable(repo, project);
      if (
        kind === "tools-update" &&
        (await this.db.one(
          "SELECT id FROM tasks WHERE kind='tools-update' AND state IN ('queued','running') LIMIT 1",
        ))
      )
        throw problem(409, "Another tool upgrade is running");
      return this.db.one(
        "INSERT INTO tasks(id,repo,project,kind,input,chat,request_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [id, repo || null, project || null, kind, input, chat, requestKey],
      );
    };
    return this.db.lock(repo ? `${repo}:${project}` : "tools-update", insert);
  }
  async get(id) {
    const row = await this.db.one("SELECT * FROM tasks WHERE id=$1", [id]);
    if (!row) throw problem(404, "Task not found");
    return row;
  }
  async cancel(id) {
    // One statement decides from the CURRENT state; a stale queued read must not
    // miss a concurrent transition to running.
    const changed = await this.db.one(
      "UPDATE tasks SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'cancelling' END,finished=CASE WHEN state='queued' THEN now() ELSE finished END,expires=CASE WHEN state='queued' THEN now()+interval '7 days' ELSE expires END WHERE id=$1 AND state IN ('queued','running') RETURNING *",
      [id],
    );
    if (changed?.state === "cancelled")
      await this.db.pool.query("DELETE FROM agent_tokens WHERE task=$1", [id]);
    const current = changed || await this.get(id);
    if (["publishing", "publish_failed"].includes(current.state))
      throw problem(409, "执行已经结束，结果正在保存或等待恢复，请使用重试发布而不是取消");
    return current;
  }
  async finishCancellation(id) {
    await this.db.pool.query(
      "UPDATE tasks SET state='cancelled',finished=now(),expires=now()+interval '7 days' WHERE id=$1 AND state IN ('queued','running','cancelling')",
      [id],
    );
    await this.db.pool.query("DELETE FROM agent_tokens WHERE task=$1", [id]);
  }
  host(relative) {
    return path.posix.join(process.env.FRAME_HOST_DATA || this.data, relative);
  }
  async assertLeadership() {
    if (this.closed) throw Object.assign(new Error("Controller is stopping"), { leadershipLost: true });
    if (this.lease) await this.lease.assert();
  }
  async start(t) {
    await this.assertLeadership();
    const lock = this.db.lock ? fn => this.db.lock(t.repo ? `${t.repo}:${t.project}` : "tools-update", fn) : fn => fn();
    return lock(async () => {
      const container = "frame-task-" + t.id;
      const claimed = await this.db.one(
        "UPDATE tasks SET state='running',started=now(),container=$2,controller_id=$3,progress=$4 WHERE id=$1 AND state='queued' RETURNING id",
        [t.id, container, this.controllerId, { stage: "准备隔离工作副本" }],
      );
      if (!claimed) return;
      try { return await this.prepareAndLaunch(t, container); }
      catch (error) {
        const current = await this.get(t.id);
        if (!error.leadershipLost && !current.launch_attempted_at) {
          await this.assertLeadership();
          await this.failTask(current, error.message);
        }
        throw error;
      }
    });
  }
  async prepareAndLaunch(t, container) {
    if ((await this.get(t.id)).state === "cancelling") { await this.finishCancellation(t.id); return; }
    await this.assertLeadership();
    const run = path.join(this.data, "runs", t.id);
    fs.mkdirSync(run, { recursive: true });
    let fingerprint = null;
    let sourceCommit = null;
    if (t.repo && t.kind === "build" && t.input.version) {
      const destination = path.join(run, "projects", t.project);
      await snapshotVersion(this.repos, t, t.input.version, destination);
      fingerprint = await treeHash(destination);
      sourceCommit = t.input.version;
    } else if (t.repo) {
      const { dir } = await this.repos.project(t.repo, t.project, {
        exists: t.kind !== "new",
      });
      if (t.kind === "new" && fs.existsSync(dir))
        throw problem(409, "Project already exists");
      fingerprint = await treeHash(dir);
      if (fs.existsSync(dir)) {
        const snapshot = path.join(run, "projects", t.project);
        await copyTree(dir, snapshot);
        if (await treeHash(snapshot) !== fingerprint || await treeHash(dir) !== fingerprint)
          throw problem(409, "Source changed while preparing the isolated task");
      }
      if (t.kind !== "new")
        sourceCommit = await this.repos.checkpoint(
          t.repo,
          t.project,
          t.kind === "agent" ? "AI 修改前自动保存" : "生成预览或导出前保存",
        );
    }
    await seedPreviewAudio({ db: this.db, data: this.data, task: t, run });
    let config = {};
    if (t.kind === "agent") {
      if (t.input.connection)
        config = await this.connections.resolve(t.input.connection);
      else {
        const stored = await this.db.setting(t.input.provider);
        config = stored?.encrypted
          ? this.secrets.decrypt(stored.encrypted)
          : {};
      }
      if (!config.apiKey && config.mode !== "official")
        throw problem(
          400,
          "Configure this AI provider API key in Settings first",
        );
    }
    const chat = t.chat
      ? await this.db.one("SELECT * FROM chats WHERE id=$1", [t.chat])
      : null;
    const runtime = await executionRuntime({ data: this.data, task: t, command: this.command });
    const payload = {
      runtime,
      sourceCommit,
      id: t.id,
      project: t.project,
      kind: t.kind,
      input: t.input,
      upstream: chat?.upstream || null,
      model: config.model || null,
      baseUrl: config.baseUrl || null,
      authMode: config.mode || "api",
    };
    fs.writeFileSync(path.join(run, "task.json"), JSON.stringify(payload));
    await this.command("chown", ["-R", "1000:1000", run]);
    const session = t.chat || t.id,
      sessionDir = path.join(this.data, "sessions", session);
    fs.mkdirSync(path.join(sessionDir, ".codex"), { recursive: true });
    await this.command("chown", ["-R", "1000:1000", sessionDir]);
    const env = { FRAME_RUNTIME_IMAGE: runtime.image };
    const flags = ["-e", "FRAME_RUNTIME_IMAGE"];
    if (t.kind === "agent" && config.mode === "official") {
      const auth = path.join(this.data, "auth", config.id);
      if (!fs.existsSync(auth))
        throw problem(409, "官方登录凭据不存在，请重新登录");
      flags.push(
        "-v",
        this.host("auth/" + config.id) + ":/auth",
        "-e",
        t.input.provider === "codex"
          ? "CODEX_HOME=/auth/codex"
          : "CLAUDE_CONFIG_DIR=/auth/claude",
      );
    }
    if (t.kind === "agent") {
      const value = token();
      await this.db.pool.query(
        "INSERT INTO agent_tokens(hash,task) VALUES($1,$2)",
        [hash(value), t.id],
      );
      env.FRAME_AGENT_TOKEN = value;
      env.FRAME_AGENT_URL =
        process.env.FRAME_AGENT_URL || process.env.FRAME_PUBLIC_URL;
      flags.push("-e", "FRAME_AGENT_TOKEN", "-e", "FRAME_AGENT_URL");
    }
    if (config.apiKey) {
      const name =
        t.input.provider === "codex" ? "CODEX_API_KEY" : "ANTHROPIC_API_KEY";
      env[name] = config.apiKey;
      flags.push("-e", name);
      if (config.baseUrl) {
        const key =
          t.input.provider === "codex"
            ? "OPENAI_BASE_URL"
            : "ANTHROPIC_BASE_URL";
        env[key] = config.baseUrl;
        flags.push("-e", key);
      }
    }
    const image = runtime.image;
    await this.assertLeadership();
    const prepared = await this.db.one(
      "UPDATE tasks SET fingerprint=$2,source_commit=$3,runtime=$4 WHERE id=$1 AND state='running' AND controller_id=$5 RETURNING id",
      [t.id, fingerprint, sourceCommit, runtime, this.controllerId],
    );
    if (!prepared) {
      if ((await this.get(t.id)).state === "cancelling") await this.finishCancellation(t.id);
      await this.db.pool.query("DELETE FROM agent_tokens WHERE task=$1", [t.id]);
      return;
    }
    const args = [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      "frame.task=" + t.id,
      "--memory",
      "4g",
      "--cpus",
      "2",
      "--pids-limit",
      "256",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "1000:1000",
      "--network",
      "bridge",
      "-e",
      "HOME=/sessions",
      "-e",
      "CODEX_HOME=/sessions/.codex",
      "-v",
      this.host("runs/" + t.id) + ":/workspace",
      "-v",
      this.host("sessions/" + session) + ":/sessions",
      "-v",
      this.host("tools") + ":/tools" + (t.kind === "tools-update" ? "" : ":ro"),
      ...flags,
      image,
      "node",
      "server/executor.mjs",
    ];
    if (t.kind === "tools-update") {
      fs.mkdirSync(path.join(this.data, "tools"), { recursive: true });
      await this.command("chmod", ["u+rwx", path.join(this.data, "tools")]);
    }
    if ((await this.get(t.id)).state !== "running") {
      await this.finishCancellation(t.id);
      return;
    }
    await this.assertLeadership();
    const launch = await this.db.one(
      "UPDATE tasks SET launch_attempted_at=now() WHERE id=$1 AND state='running' AND controller_id=$2 AND launch_attempted_at IS NULL RETURNING id",
      [t.id, this.controllerId],
    );
    if (!launch) {
      if ((await this.get(t.id)).state === "cancelling") await this.finishCancellation(t.id);
      return;
    }
    await this.command("docker", args, { env, timeout: 120000 });
    // Cancellation after this last check remains durable as 'cancelling'; the
    // scheduler stops the container instead of overwriting it with 'running'.
    await this.db.event(t.id, "state", { state: (await this.get(t.id)).state });
  }
  retryPublication(id) { return this.publication.retryPublication(id); }
  publicationError(task, error) { return this.publication.publicationError(task, error); }
  async complete(task, exit) { await this.assertLeadership(); return this.publication.complete(task, exit); }
  async publish(task) { await this.assertLeadership(); return this.publication.publish(task); }
  monitorWarning(task, phase, error) { return this.monitor.monitorWarning(task, phase, error); }
  observeTask(task) { return this.monitor.observeTask(task); }
  collectEvents(task) { return this.monitor.collectEvents(task); }
  async failTask(t, message) {
    const failed = await this.db.one(
      "UPDATE tasks SET state='failed',error=$2,monitor=NULL,finished=now(),expires=now()+interval '14 days' WHERE id=$1 AND state IN ('queued','running') RETURNING id",
      [t.id, message],
    );
    if (failed) {
      await this.db.pool.query("DELETE FROM agent_tokens WHERE task=$1", [t.id]);
      await this.db.event(t.id, "error", { message });
    } else if ((await this.get(t.id)).state === "cancelling") {
      await this.finishCancellation(t.id);
    }
  }
  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      await this.assertLeadership();
      const running = await this.db.all("SELECT * FROM tasks WHERE state IN ('running','cancelling','publishing') AND (publication_retry_at IS NULL OR publication_retry_at<=now()) ORDER BY created");
      for (const t of running) {
        await this.assertLeadership();
        try {
          if (t.state === "publishing") {
            await this.complete(t, 0);
            if ((await this.get(t.id)).state === "succeeded" && t.container)
              await this.command("docker", ["rm", t.container], { timeout: 10000 }).catch(() => {});
          } else await this.observeTask(t);
        }
        catch (e) { await this.monitorWarning(t, "controller", e); }
      }
      const count = await this.db.one("SELECT count(*)::int AS n FROM tasks WHERE state IN ('running','cancelling')");
      if (count.n < this.limits.concurrency) {
        try {
          const disk = await diskCapacity(this.data);
          this.queueBlocked = disk.freeBytes < this.limits.minFreeBytes ? "可用空间低于安全阈值，新任务保留排队；正在执行的任务不会因此被终止。" : null;
        } catch {
          this.queueBlocked = "暂时无法读取磁盘容量，新任务保留排队。";
        }
        if (this.queueBlocked) return;
        const t = await this.db.one(
          `SELECT t.* FROM tasks t WHERE t.state='queued' AND NOT EXISTS(SELECT 1 FROM tasks r WHERE (r.repo=t.repo AND r.project=t.project AND r.state IN ('running','cancelling','publishing','publish_failed')) OR (r.state IN ('running','cancelling') AND t.input->>'connection' IS NOT NULL AND r.input->>'connection'=t.input->>'connection'))
          ORDER BY t.created LIMIT 1`,
        );
        if (t) {
          await this.assertLeadership();
          try { await this.start(t); }
          catch (e) {
            const current = await this.get(t.id);
            // docker run may have succeeded before its response was lost. Inspect
            // the assigned container on later ticks; never kill it on uncertainty.
            if (["running", "cancelling"].includes(current.state) && current.container)
              await this.monitorWarning(current, "startup", e);
            else if (current.state === "queued") await this.failTask(current, e.message);
            else if (current.state === "cancelled")
              await this.db.pool.query("DELETE FROM agent_tokens WHERE task=$1", [t.id]);
          }
        }
      }
    } finally { this.ticking = false; }
  }
  startLoop({ onLeadership = () => {}, onCycle = () => {} } = {}) {
    if (this.loopStarted) return;
    this.loopStarted = true;
    this.lease = new ControllerLease(this.db.pool);
    this.controllerId = this.lease.id;
    const cycle = async () => {
      if (this.closed || this.loopPromise) return;
      this.loopPromise = (async () => {
        let leader = false;
        try {
          leader = await this.lease.acquire();
          await onLeadership(leader);
          if (leader) await this.tick();
        } catch (error) { console.error("Scheduler:", error.message); }
        finally {
          if (!this.lease.held || this.closed) await onLeadership(false);
          await Promise.resolve().then(() => onCycle({ leader: this.lease.held && !this.closed, controllerId: this.controllerId })).catch(error => console.error("Controller status:", error.message));
        }
      })();
      try { await this.loopPromise; }
      catch (error) { console.error("Controller cycle:", error.message); }
      finally { this.loopPromise = null; }
    };
    this.timer = setInterval(() => void cycle(), 1500);
    void cycle();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.loopPromise?.catch(() => {});
    this.lease?.close();
  }
}
