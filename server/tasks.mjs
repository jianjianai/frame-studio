import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { command } from "./process.mjs";
import {
  copyTree,
  treeHash,
  confined,
  problem,
  token,
  hash,
} from "./security.mjs";
import { applyProject } from "./apply-project.mjs";
import { PREVIEW_VERSION } from "./preview-version.mjs";
export class Tasks {
  constructor(db, data, repos, secrets, { runCommand = command } = {}) {
    this.command = runCommand;
    this.db = db;
    this.data = data;
    this.repos = repos;
    this.secrets = secrets;
    this.logs = new Map();
    this.monitorWarnings = new Map();
    this.missingContainers = new Map();
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
    if (
      ![
        "new",
        "validate",
        "frame",
        "storyboard",
        "render",
        "build",
        "agent",
        "tools-update",
      ].includes(kind)
    )
      throw problem(400, "Unknown task kind");
    if (kind === "tools-update") {
      if (
        !["codex", "claude"].includes(input.provider) ||
        !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(input.version)
      )
        throw problem(400, "Choose a provider and explicit semver version");
    } else await this.repos.project(repo, project, { exists: kind !== "new" });
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
      if (repo && kind !== "agent") await this.repos.writable(repo, project);
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
    return changed || this.get(id);
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
  async start(t) {
    if ((await this.get(t.id)).state !== "queued") return;
    const run = path.join(this.data, "runs", t.id);
    fs.mkdirSync(run, { recursive: true });
    let fingerprint = null;
    let sourceCommit = null;
    if (t.repo) {
      const { dir } = await this.repos.project(t.repo, t.project, {
        exists: t.kind !== "new",
      });
      if (t.kind === "new" && fs.existsSync(dir))
        throw problem(409, "Project already exists");
      fingerprint = treeHash(dir);
      if (fs.existsSync(dir))
        copyTree(dir, path.join(run, "projects", t.project));
      if (t.kind !== "new")
        sourceCommit = await this.repos.checkpoint(
          t.repo,
          t.project,
          t.kind === "agent" ? "AI 修改前自动保存" : "生成预览或导出前保存",
        );
    }
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
    const payload = {
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
    const env = {};
    const flags = [];
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
    const image = process.env.FRAME_EXECUTOR_IMAGE || "frame-studio:local",
      container = "frame-task-" + t.id;
    const claimed = await this.db.one(
      "UPDATE tasks SET state='running',started=now(),container=$2,fingerprint=$3,source_commit=$4 WHERE id=$1 AND state='queued' RETURNING id",
      [t.id, container, fingerprint, sourceCommit],
    );
    if (!claimed) {
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
      await this.command("chmod", ["a+rwx", path.join(this.data, "tools")]);
    }
    if ((await this.get(t.id)).state !== "running") {
      await this.finishCancellation(t.id);
      return;
    }
    await this.command("docker", args, { env, timeout: 120000 });
    // Cancellation after this last check remains durable as 'cancelling'; the
    // scheduler stops the container instead of overwriting it with 'running'.
    await this.db.event(t.id, "state", { state: (await this.get(t.id)).state });
  }
  async complete(t, exit) {
    t = await this.get(t.id);
    if (["cancelled", "succeeded"].includes(t.state)) return;
    if (t.state === "cancelling") {
      await this.finishCancellation(t.id);
      return;
    }
    const run = path.join(this.data, "runs", t.id),
      resultFile = path.join(run, "result.json");
    let result = fs.existsSync(resultFile)
      ? JSON.parse(fs.readFileSync(resultFile, "utf8"))
      : {};
    if (exit !== 0 || result.error || result.status === "failed")
      throw Object.assign(new Error(result.error || "Task failed; inspect task events"), { executionFailed: true });
    if (t.repo && ["agent", "new"].includes(t.kind))
      await this.db.lock(`${t.repo}:${t.project}`, async () => {
        const { dir } = await this.repos.project(t.repo, t.project, {
          exists: false,
        });
        const source = confined(run, "projects/" + t.project);
        // After a process restart, an already applied identical result is safe to finish publishing.
        if (treeHash(dir) !== treeHash(source))
          applyProject({
            source,
            destination: dir,
            run,
            id: t.id,
            fingerprint: t.fingerprint,
          });
        result.commit = await this.repos.checkpoint(
          t.repo,
          t.project,
          "AI · " + (t.input.prompt || "创建作品").slice(0, 120),
        );
      });
    if (t.chat && result.upstream)
      await this.db.pool.query("UPDATE chats SET upstream=$2 WHERE id=$1", [
        t.chat,
        result.upstream,
      ]);
    const artifacts = [];
    const base = path.join(run, "projects", t.project || "", "exports");
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue;
        const file = path.join(dir, item.name);
        if (item.isDirectory()) walk(file);
        else if (/\.(png|mp4|webm|wav|html|srt|json)$/.test(item.name))
          artifacts.push({
            name: path.relative(base, file).replaceAll("\\", "/"),
            path: path.relative(run, file).replaceAll("\\", "/"),
            bytes: fs.statSync(file).size,
          });
      }
    };
    walk(base);
    result = { ...result, artifacts };
    await this.db.pool.query(
      "UPDATE tasks SET state='succeeded',result=$2,source_commit=COALESCE($3,source_commit),finished=now(),expires=now()+interval '7 days' WHERE id=$1",
      [t.id, result, result.commit || null],
    );
    await this.db.event(t.id, "result", result);
    await this.db.pool.query("DELETE FROM agent_tokens WHERE task=$1", [t.id]);
    if (t.repo && t.kind === "agent") {
      await this.db.pool.query(
        "UPDATE works SET updated=now() WHERE repo=$1 AND project=$2",
        [t.repo, t.project],
      );
      // A completed creation turn publishes a fresh player preview without a second user action.
      // Publish the build already validated in this isolated turn, before queued follow-up work.
      try {
        if (result.previewArtifacts) {
          const preview = randomUUID(),
            previewRun = path.join(this.data, "runs", preview);
          fs.mkdirSync(previewRun, { recursive: true });
          const directories = new Set(
            result.previewArtifacts.map((a) => path.posix.dirname(a.path)),
          );
          for (const relative of directories) {
            if (!relative.startsWith(`projects/${t.project}/exports/`))
              throw new Error("Invalid preview output");
            fs.cpSync(confined(run, relative), confined(previewRun, relative), {
              recursive: true,
              filter: (file) => !fs.lstatSync(file).isSymbolicLink(),
            });
          }
          const { dir } = await this.repos.project(t.repo, t.project);
          await this.db.pool.query(
            "INSERT INTO tasks(id,repo,project,kind,state,input,result,fingerprint,source_commit,created,started,finished,expires) VALUES($1,$2,$3,'build','succeeded','{}',$4,$5,$6,now(),now(),now(),now()+interval '7 days')",
            [
              preview,
              t.repo,
              t.project,
              {
                previewVersion: PREVIEW_VERSION,
                artifacts: result.previewArtifacts,
              },
              treeHash(dir),
              result.commit || t.source_commit,
            ],
          );
        } else
          await this.create({
            repo: t.repo,
            project: t.project,
            kind: "build",
          }).catch((e) =>
            this.db.event(t.id, "preview-error", { message: e.message }),
          );
      } catch (e) {
        await this.db.event(t.id, "preview-error", {
          message: "作品已保存，预览发布失败，可重新生成：" + e.message,
        });
      }
      await this.repos.onChange?.(t.repo, t.project).catch((e) =>
        this.db.event(t.id, "index-error", {
          message: "作品已保存，素材索引待刷新：" + e.message,
        }),
      );
    }
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
      state = JSON.parse(await this.command("docker", ["inspect", "--format", "{{json .State}}", t.container], { timeout: 10000, max: 65536 }));
      if (typeof state?.Running !== "boolean" || (!state.Running && !Number.isInteger(state.ExitCode)))
        throw Error("Docker returned an incomplete task state");
      this.missingContainers.delete(t.id);
    } catch (e) {
      const missing = /No such (?:object|container)/i.test(e.message);
      const count = missing ? (this.missingContainers.get(t.id) || 0) + 1 : 0;
      this.missingContainers.set(t.id, count);
      await this.monitorWarning(t, "docker", e);
      // Confirm repeated absence against a healthy daemon, not a broken connection.
      if (count >= 3 && Date.now() - new Date(t.started).getTime() > 120000) {
        await this.command("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10000 });
        await this.failTask(t, "执行容器连续多次确认不存在；工作副本已保留，请检查后重试。");
      }
      return;
    }
    t = await this.get(t.id);
    const timedOut = t.state === "running" && Date.now() - new Date(t.started).getTime() >
      Math.max(600, Math.min(604800, Number(process.env.FRAME_TASK_TIMEOUT_SECONDS) || 21600)) * 1000;
    if (state.Running && (t.state === "cancelling" || timedOut)) {
      // Successful stop is followed by a fresh inspect on the next tick. A failed
      // stop is a monitoring problem, not permission to force-remove the container.
      await this.command("docker", ["stop", "-t", "5", t.container], { timeout: 20000 });
      return;
    }
    if (timedOut && !state.Running) {
      await this.failTask(t, "创作超过服务器配置的运行时限，隔离工作区产物已保留，可重新继续。");
    } else {
      try {
        if (t.kind === "agent") {
          do { if (!(await this.collectEvents(t))) break; } while (!state.Running);
        } else {
          const log = await this.command("docker", ["logs", "--tail", "1500", t.container], { timeout: 10000, max: 1024 * 1024, combined: true });
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
      await this.command("docker", ["rm", t.container], { timeout: 10000 }).catch(() => {});
      this.logs.delete(t.id);
      this.missingContainers.delete(t.id);
    }
  }
  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      const running = await this.db.all("SELECT * FROM tasks WHERE state IN ('running','cancelling') ORDER BY created");
      for (const t of running) {
        try { await this.observeTask(t); }
        catch (e) { await this.monitorWarning(t, "controller", e); }
      }
      const count = await this.db.one("SELECT count(*)::int AS n FROM tasks WHERE state IN ('running','cancelling')");
      if (count.n < 2) {
        const t = await this.db.one(
          `SELECT t.* FROM tasks t WHERE t.state='queued' AND NOT EXISTS(SELECT 1 FROM tasks r WHERE r.state IN ('running','cancelling') AND ((r.repo=t.repo AND r.project=t.project) OR (t.input->>'connection' IS NOT NULL AND r.input->>'connection'=t.input->>'connection')))
          ORDER BY t.created LIMIT 1`,
        );
        if (t) {
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
  async collectEvents(task) {
    const file = path.join(this.data, "runs", task.id, "events.ndjson");
    if (!fs.existsSync(file)) return;
    const start = Number(task.log_cursor || 0),
      size = fs.statSync(file).size;
    if (size <= start) return;
    const fd = fs.openSync(file, "r"),
      bytes = Buffer.alloc(Math.min(size - start, 1024 * 1024));
    try {
      fs.readSync(fd, bytes, 0, bytes.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const end = bytes.lastIndexOf(10);
    if (end < 0) return;
    let offset = start;
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
      offset += Buffer.byteLength(line) + 1;
      try {
        const event = JSON.parse(line);
        await this.db.pool.query(
          "INSERT INTO events(task,kind,data,source_offset) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [task.id, event.type, event, offset],
        );
        if (event.type === "session" && task.chat)
          await this.db.pool.query("UPDATE chats SET upstream=$2 WHERE id=$1", [
            task.chat,
            event.id,
          ]);
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
    }
    await this.db.pool.query("UPDATE tasks SET log_cursor=$2 WHERE id=$1", [
      task.id,
      String(start + end + 1),
    ]);
    task.log_cursor = String(start + end + 1);
    return start + end + 1 < size;
  }
  startLoop() {
    this.timer = setInterval(
      () => this.tick().catch((e) => console.error("Scheduler:", e.message)),
      1500,
    );
    this.tick().catch(console.error);
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
  }
}
