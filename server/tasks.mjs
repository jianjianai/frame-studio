import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
export class Tasks {
  constructor(db, data, repos, secrets) {
    this.db = db;
    this.data = data;
    this.repos = repos;
    this.secrets = secrets;
    this.logs = new Map();
    this.ticking = false;
    this.closed = false;
    fs.mkdirSync(path.join(data, "runs"), { recursive: true });
    fs.mkdirSync(path.join(data, "sessions"), { recursive: true });
  }
  async create({ repo, project, kind, input = {}, chat = null }) {
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
      if (repo) await this.repos.writable(repo);
      if (
        kind === "tools-update" &&
        (await this.db.one(
          "SELECT id FROM tasks WHERE kind='tools-update' AND state IN ('queued','running') LIMIT 1",
        ))
      )
        throw problem(409, "Another tool upgrade is running");
      return this.db.one(
        "INSERT INTO tasks(id,repo,project,kind,input,chat) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [id, repo || null, project || null, kind, input, chat],
      );
    };
    return this.db.lock(repo || "tools-update", insert);
  }
  async get(id) {
    const row = await this.db.one("SELECT * FROM tasks WHERE id=$1", [id]);
    if (!row) throw problem(404, "Task not found");
    return row;
  }
  async cancel(id) {
    const t = await this.get(id);
    if (t.state === "queued")
      await this.db.pool.query(
        "UPDATE tasks SET state='cancelled',finished=now() WHERE id=$1 AND state='queued'",
        [id],
      );
    else if (t.state === "running")
      await this.db.pool.query(
        "UPDATE tasks SET state='cancelling' WHERE id=$1 AND state='running'",
        [id],
      );
    return this.get(id);
  }
  host(relative) {
    return path.posix.join(process.env.FRAME_HOST_DATA || this.data, relative);
  }
  async start(t) {
    const run = path.join(this.data, "runs", t.id);
    fs.mkdirSync(run, { recursive: true });
    let fingerprint = null;
    if (t.repo) {
      const { dir } = await this.repos.project(t.repo, t.project, {
        exists: t.kind !== "new",
      });
      if (t.kind === "new" && fs.existsSync(dir))
        throw problem(409, "Project already exists");
      fingerprint = treeHash(dir);
      if (fs.existsSync(dir))
        copyTree(dir, path.join(run, "projects", t.project));
    }
    let config = {};
    if (t.kind === "agent") {
      const stored = await this.db.setting(t.input.provider);
      config = stored?.encrypted ? this.secrets.decrypt(stored.encrypted) : {};
      if (!config.apiKey)
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
    };
    fs.writeFileSync(path.join(run, "task.json"), JSON.stringify(payload));
    await command("chown", ["-R", "1000:1000", run]);
    const session = t.chat || t.id,
      sessionDir = path.join(this.data, "sessions", session);
    fs.mkdirSync(sessionDir, { recursive: true });
    await command("chown", ["-R", "1000:1000", sessionDir]);
    const env = {};
    const flags = [];
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
    await this.db.pool.query(
      "UPDATE tasks SET state='running',started=now(),container=$2,fingerprint=$3 WHERE id=$1",
      [t.id, container, fingerprint],
    );
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
      await command("chmod", ["a+rwx", path.join(this.data, "tools")]);
    }
    await command("docker", args, { env, timeout: 120000 });
    await this.db.event(t.id, "state", { state: "running" });
  }
  async complete(t, exit) {
    const run = path.join(this.data, "runs", t.id),
      resultFile = path.join(run, "result.json");
    let result = fs.existsSync(resultFile)
      ? JSON.parse(fs.readFileSync(resultFile, "utf8"))
      : {};
    if (t.state === "cancelling") {
      await this.db.pool.query(
        "UPDATE tasks SET state='cancelled',finished=now() WHERE id=$1",
        [t.id],
      );
      return;
    }
    if (exit !== 0 || result.error || result.status === "failed")
      throw new Error(result.error || "Task failed; inspect task events");
    if (t.repo && ["agent", "new"].includes(t.kind))
      await this.db.lock(t.repo, async () => {
        const { dir } = await this.repos.project(t.repo, t.project, {
          exists: false,
        });
        const source = confined(run, "projects/" + t.project);
        applyProject({
          source,
          destination: dir,
          run,
          id: t.id,
          fingerprint: t.fingerprint,
        });
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
      "UPDATE tasks SET state='succeeded',result=$2,finished=now() WHERE id=$1",
      [t.id, result],
    );
    await this.db.event(t.id, "result", result);
    await this.db.pool.query("DELETE FROM agent_tokens WHERE task=$1", [t.id]);
    if (t.repo && t.kind === "agent") {
      await this.db.pool.query(
        "UPDATE works SET updated=now() WHERE repo=$1 AND project=$2",
        [t.repo, t.project],
      );
      // A completed creation turn publishes a fresh player preview without a second user action.
      await this.create({
        repo: t.repo,
        project: t.project,
        kind: "build",
      }).catch((e) =>
        this.db.event(t.id, "preview-error", { message: e.message }),
      );
    }
  }
  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      const running = await this.db.all(
        "SELECT * FROM tasks WHERE state IN ('running','cancelling') ORDER BY created",
      );
      for (const t of running) {
        try {
          if (
            t.state === "running" &&
            Date.now() - new Date(t.started).getTime() > 3600000
          ) {
            await command("docker", ["stop", "-t", "5", t.container]).catch(
              () => {},
            );
            throw new Error(
              "Task exceeded the one hour execution limit; completed output is retained.",
            );
          }
          if (t.state === "cancelling")
            await command("docker", ["stop", "-t", "5", t.container]).catch(
              () => {},
            );
          const state = JSON.parse(
            await command("docker", [
              "inspect",
              "--format",
              "{{json .State}}",
              t.container,
            ]),
          );
          const log = await command(
            "docker",
            ["logs", "--tail", "1500", t.container],
            { max: 1024 * 1024, combined: true },
          ).catch((e) => e.message);
          if (log !== this.logs.get(t.id)) {
            const old = this.logs.get(t.id) || "";
            const delta = log.startsWith(old) ? log.slice(old.length) : log;
            this.logs.set(t.id, log);
            if (delta)
              await this.db.event(t.id, "log", { text: delta.slice(-64000) });
          }
          if (!state.Running) {
            await this.complete(t, state.ExitCode);
            await command("docker", ["rm", t.container]).catch(() => {});
            this.logs.delete(t.id);
          }
        } catch (e) {
          await this.db.pool.query(
            "UPDATE tasks SET state='failed',error=$2,finished=now() WHERE id=$1",
            [t.id, e.message],
          );
          await this.db.event(t.id, "error", { message: e.message });
        }
      }
      const count = await this.db.one(
        "SELECT count(*)::int AS n FROM tasks WHERE state IN ('running','cancelling')",
      );
      if (count.n < 2) {
        const t = await this.db.one(
          "SELECT * FROM tasks WHERE state='queued' ORDER BY created LIMIT 1",
        );
        if (t)
          try {
            await this.start(t);
          } catch (e) {
            await this.db.pool.query(
              "UPDATE tasks SET state='failed',error=$2,finished=now() WHERE id=$1",
              [t.id, e.message],
            );
          }
      }
    } finally {
      this.ticking = false;
    }
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
