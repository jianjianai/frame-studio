import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { randomUUID, createHash } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { AGENTS, agentEnv } from "./agents.mjs";
import { Profiles } from "./profiles.mjs";
import { appVersion } from "../config.mjs";
import { problem, notFound, writeFileAtomic } from "../util.mjs";
import { formatTime } from "../render.mjs";
import { experienceDelta, filesNotice, noteSeen, rebaseSeen, referencedExperience, selectionText, snapshotFiles } from "./context.mjs";

const IDLE_MS = 15 * 60 * 1000;
/** FRAME permission levels mapped to each agent's own session modes. */
export const PERMISSION_MODES = {
  ask: { claude: "default", codex: "read-only" },
  edits: { claude: "acceptEdits", codex: "workspace-write" },
  auto: { claude: "auto", codex: "agent" },
  full: { claude: "bypassPermissions", codex: "agent-full-access" },
};
/** Agent modes in which changes wait for the user: FRAME's "ask" level, and planning. */
const CONFIRMING_MODES = new Set(["default", "plan", "read-only"]);
/** Whether the session's current mode has the user confirm each change. */
export function confirmsChanges(meta) {
  const option = (id) => meta.configOptions?.find((item) => item.id === id);
  return CONFIRMING_MODES.has(option("mode")?.currentValue ?? meta.modes?.currentModeId) || option("collaboration_mode")?.currentValue === "plan";
}
const CLAUDE_ALLOWED_TOOLS = [
  "mcp__frame",
  "Read",
  "Glob",
  "Grep",
  "LS",
  ...["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "file", "git status", "git diff", "git log", "git show"].map((command) => `Bash(${command}:*)`),
];

/** One ACP adapter process (claude-agent-acp or codex-acp) serving many sessions. */
class AgentProcess {
  constructor(manager, { key, profile, model }) {
    this.manager = manager;
    this.key = key;
    this.profile = profile;
    this.model = model;
    this.agent = profile.agent;
    this.sessions = new Set();
    this.usedAt = Date.now();
    this.stderr = "";
  }
  async start() {
    const env = agentEnv(this.manager.services.config, this.manager.profiles.env(this.profile, this.model));
    if (this.agent === "claude") env.CLAUDE_CODE_EXECUTABLE = AGENTS.claude.cli().command;
    if (this.agent === "codex") env.INITIAL_AGENT_MODE = "agent";
    const logDir = path.join(this.manager.dir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    if (this.agent === "codex") env.APP_SERVER_LOGS = logDir;
    this.child = spawn(process.execPath, [AGENTS[this.agent].adapter()], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
    });
    this.exited = new Promise((resolve) => this.child.on("close", (code) => resolve(code)));
    this.exited.then((code) => this.manager.onProcessExit(this, code));
    this.child.stdin.on("error", () => {});
    const stream = acp.ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout));
    this.connection = new acp.ClientSideConnection(
      () => ({
        sessionUpdate: (params) => this.manager.onUpdate(params),
        requestPermission: (params) => this.manager.onPermission(params),
        readTextFile: (params) => this.manager.readFile(params),
        writeTextFile: (params) => this.manager.writeFile(params),
      }),
      stream,
    );
    this.init = await Promise.race([
      this.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "frame-studio", title: "FRAME Studio", version: appVersion },
      }),
      this.exited.then(() => {
        throw new Error("AI 进程启动失败：" + this.stderr.trim().slice(-600));
      }),
    ]);
    if (this.profile.kind === "openai" && !this.profile.baseUrl && this.init.authMethods?.some((method) => method.id === "api-key"))
      await this.connection.authenticate({ methodId: "api-key" });
    return this;
  }
  get capabilities() {
    return this.init?.agentCapabilities ?? {};
  }
  /** ACP `_session/steering`: inject a message into the running turn. */
  get steering() {
    return Boolean(this.init?._meta?.steering?.supported);
  }
  kill() {
    this.child?.kill();
  }
}

/**
 * Chat sessions: one per conversation, bound to a work. The transcript is a JSONL
 * of raw ACP updates plus user/permission/turn events; the studio renders it.
 */
export class AiManager {
  constructor(services) {
    this.services = services;
    this.profiles = new Profiles(services.settings);
    this.dir = services.config.dirs.ai;
    this.sessionsDir = path.join(this.dir, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.processes = new Map();
    this.sessions = new Map();
    this.permissions = new Map();
    for (const name of fs.readdirSync(this.sessionsDir).filter((file) => file.endsWith(".json"))) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, name), "utf8"));
        this.sessions.set(meta.id, { meta: { ...meta, status: "idle", queue: [] }, process: null, attached: false });
      } catch {}
    }
    this.timer = setInterval(() => this.sweep(), 60000);
    this.timer.unref();
  }

  // ---- persistence --------------------------------------------------------
  saveMeta(session) {
    const meta = { ...session.meta, queue: undefined };
    writeFileAtomic(path.join(this.sessionsDir, meta.id + ".json"), JSON.stringify(meta, null, 2));
  }
  /** Images (agent tool results, user frame references) are stored as files, not inline base64. */
  storeImages(session, value) {
    if (Array.isArray(value)) return value.map((item) => this.storeImages(session, item));
    if (!value || typeof value !== "object") return value;
    if (value.type === "image" && typeof value.data === "string" && value.data.length > 256) {
      const bytes = Buffer.from(value.data, "base64");
      const ext = { "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[value.mimeType] ?? "jpg";
      const name = createHash("sha256").update(bytes).digest("hex").slice(0, 24) + "." + ext;
      const dir = path.join(this.sessionsDir, session.meta.id + ".images");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
      const { data, ...rest } = value;
      return { ...rest, uri: `/api/ai/sessions/${session.meta.id}/images/${name}` };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.storeImages(session, item)]));
  }
  imageFile(id, name) {
    if (!/^[a-f0-9]{24}\.(png|jpg|webp|gif)$/.test(name)) throw notFound("图片不存在");
    return path.join(this.sessionsDir, id + ".images", name);
  }
  append(session, entry) {
    const line = this.storeImages(session, { at: Date.now(), ...entry });
    fs.appendFileSync(path.join(this.sessionsDir, session.meta.id + ".jsonl"), JSON.stringify(line) + "\n");
    this.services.events.emit({ type: "ai-event", session: session.meta.id, work: session.meta.work, entry: line });
  }
  publish(session) {
    session.meta.updatedAt = new Date().toISOString();
    this.saveMeta(session);
    this.services.events.emit({ type: "ai-session", session: this.publicMeta(session) });
  }
  publicMeta(session) {
    // What the AI has seen (for per-message changes) is the server's business.
    const { context: _context, ...meta } = session.meta;
    return meta;
  }
  transcript(id) {
    const file = path.join(this.sessionsDir, id + ".jsonl");
    if (!fs.existsSync(file)) return [];
    return compact(
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  }
  /** Merge streamed text chunks so stored transcripts stay small. */
  compactFile(id) {
    const file = path.join(this.sessionsDir, id + ".jsonl");
    if (!fs.existsSync(file)) return;
    writeFileAtomic(
      file,
      this.transcript(id)
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  }

  // ---- processes ------------------------------------------------------------
  async process(profileId, model = "") {
    const profile = this.profiles.get(profileId);
    const key = `${profile.id}:${model}`;
    let entry = this.processes.get(key);
    if (!entry) {
      const process = new AgentProcess(this, { key, profile, model });
      entry = { promise: process.start(), process };
      this.processes.set(key, entry);
      entry.promise.catch(() => this.processes.get(key) === entry && this.processes.delete(key));
    }
    const process = await entry.promise;
    process.usedAt = Date.now();
    return process;
  }
  onProcessExit(process, code) {
    for (const [key, entry] of this.processes) if (entry.process === process) this.processes.delete(key);
    for (const session of this.sessions.values()) {
      if (session.process !== process) continue;
      session.process = null;
      session.attached = false;
      if (session.meta.status === "running") {
        this.append(session, { kind: "error", message: `AI 进程意外退出（${code}）：${process.stderr.trim().slice(-400)}` });
        session.meta.status = "idle";
        this.publish(session);
      }
    }
  }
  sweep() {
    for (const [key, entry] of this.processes) {
      const busy = [...this.sessions.values()].some((session) => session.process === entry.process && session.meta.status !== "idle");
      if (!busy && Date.now() - entry.process.usedAt > IDLE_MS) {
        this.processes.delete(key);
        entry.process.kill();
      }
    }
  }

  // ---- sessions ---------------------------------------------------------------
  list({ work, repo } = {}) {
    return [...this.sessions.values()]
      .map((session) => this.publicMeta(session))
      .filter((meta) => (!work || meta.work === work) && (!repo || meta.repo === repo))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw notFound("对话不存在");
    return session;
  }
  mcpServers(session) {
    const token = (session.token ||= this.services.auth.issueInternal({ work: session.meta.work, repo: session.meta.repo, session: session.meta.id }));
    return [{ type: "http", name: "frame", url: `${this.services.baseUrl}/mcp`, headers: [{ name: "Authorization", value: "Bearer " + token }] }];
  }
  /**
   * `choices` are the user's remembered picker values ({ <option id or category>: value }),
   * applied as soon as the agent session exists.
   */
  async create({ work: workId, repo, profile: profileId, model = "", title = "", choices = {} }) {
    const work = await this.services.openWork(workId, repo);
    profileId ||= this.services.settings.get("ai").defaultProfile || "claude-account";
    const profile = this.profiles.get(profileId);
    const now = new Date().toISOString();
    const session = {
      meta: {
        id: randomUUID(),
        work: work.id,
        repo: work.repo,
        profile: profile.id,
        profileName: profile.name,
        agent: profile.agent,
        model,
        title: title || "新对话",
        createdAt: now,
        updatedAt: now,
        status: "idle",
        queue: [],
        choices: {},
      },
      process: null,
      attached: false,
      initialChoices: choices,
    };
    this.sessions.set(session.meta.id, session);
    try {
      await this.attach(session, work);
    } catch (error) {
      this.sessions.delete(session.meta.id);
      throw error;
    }
    this.publish(session);
    return this.publicMeta(session);
  }
  /** Make sure the session has a live ACP session (new, resumed or reloaded). */
  async attach(session, work) {
    if (session.attached && session.process) return;
    work ||= await this.services.openWork(session.meta.work, session.meta.repo);
    const process = await this.process(session.meta.profile, session.meta.model);
    // The agent loads the brief (AGENTS.md) as the session starts or resumes: it is the baseline.
    const brief = this.services.works.writeBrief(work);
    let result;
    // The work root holds the platform AGENTS.md/CLAUDE.md and the engine links; the work itself is projects/<name>/.
    const common = { cwd: work.root, mcpServers: this.mcpServers(session) };
    // Claude never asks about FRAME tools (confirmTool does, following the session mode) or read-only inspection.
    const meta = process.agent === "claude" ? { _meta: { claudeCode: { options: { allowedTools: CLAUDE_ALLOWED_TOOLS } } } } : {};
    try {
      if (!session.meta.acpSessionId) {
        result = await process.connection.newSession({ ...common, ...meta });
        session.meta.acpSessionId = result.sessionId;
      } else {
        try {
          if (process.capabilities.sessionCapabilities?.resume)
            result = await process.connection.resumeSession({ sessionId: session.meta.acpSessionId, ...common, ...meta });
          else {
            session.replaying = true;
            try {
              result = await process.connection.loadSession({ sessionId: session.meta.acpSessionId, ...common, ...meta });
            } finally {
              session.replaying = false;
            }
          }
        } catch (error) {
          // The agent never stored this conversation (no message was sent before a restart) or
          // deleted it: continue in a new agent context instead of leaving the chat unusable.
          if (error?.code !== -32002 && !/not found/i.test(error?.message || "")) throw error;
          result = await process.connection.newSession({ ...common, ...meta });
          session.meta.acpSessionId = result.sessionId;
          this.append(session, { kind: "notice", message: "AI 的上下文已无法恢复，已在新的上下文中继续（对话记录仍保留在这里）" });
        }
      }
    } catch (error) {
      throw authHint(error, process);
    }
    session.process = process;
    session.attached = true;
    process.sessions.add(session.meta.id);
    session.meta.context = { ...session.meta.context, experience: rebaseSeen(session.meta.context?.experience ?? null, brief.experience ?? null) };
    session.files ??= this.readFiles(session) ?? snapshotFiles(work.dir);
    if (result?.configOptions) session.meta.configOptions = result.configOptions;
    if (result?.modes) session.meta.modes = result.modes;
    if (result?.models) session.meta.models = result.models;
    await this.restoreChoices(session, process);
  }
  /**
   * A resumed or reloaded agent session starts with the agent's defaults (after a
   * restart or the idle sweep), so the user's model/effort/mode choices are re-applied
   * every time. A new session takes the remembered picker values, else the default
   * permission level from settings.
   */
  async restoreChoices(session, process) {
    const options = () => session.meta.configOptions ?? [];
    const choices = { ...(session.meta.choices ?? {}) };
    for (const [key, value] of Object.entries(session.initialChoices ?? {})) {
      const option = options().find((item) => item.id === key || item.category === key);
      if (option && !(option.id in choices)) choices[option.id] = value;
    }
    session.initialChoices = null;
    const mode = options().find((option) => option.id === "mode" || option.category === "mode");
    const permission = PERMISSION_MODES[this.services.settings.get("ai").permission || "edits"]?.[process.agent];
    if (mode && !(mode.id in choices) && permission) choices[mode.id] = permission;
    // The model first: the other options (effort) may depend on it.
    const order = Object.keys(choices).sort((a, b) => Number(isModel(options(), b)) - Number(isModel(options(), a)));
    for (const id of order) {
      const option = options().find((item) => item.id === id);
      const value = choices[id];
      if (!option?.options?.some((item) => item.value === value)) continue;
      if (option.currentValue !== value)
        try {
          const result = await process.connection.setSessionConfigOption({ sessionId: session.meta.acpSessionId, configId: id, value });
          if (result?.configOptions) session.meta.configOptions = result.configOptions;
        } catch {
          continue;
        }
      session.meta.choices = { ...session.meta.choices, [id]: value };
    }
  }
  sessionByAcp(acpSessionId) {
    for (const session of this.sessions.values()) if (session.meta.acpSessionId === acpSessionId) return session;
    return null;
  }

  /** Send a prompt; queued if a turn is running. `view` is what the user was looking at when sending. */
  async prompt(id, { text = "", attachments = [], view = null }) {
    const session = this.get(id);
    if (!text.trim() && !attachments.length) throw problem(400, "消息不能为空");
    const message = { id: randomUUID(), text, attachments, view: view && typeof view === "object" ? view : null };
    if (session.meta.status !== "idle") {
      session.meta.queue.push(message);
      this.publish(session);
      return { queued: true, id: message.id };
    }
    void this.runTurn(session, message);
    return { queued: false, id: message.id };
  }
  async runTurn(session, message) {
    session.meta.status = "running";
    if (session.meta.title === "新对话" && message.text.trim()) session.meta.title = message.text.trim().replace(/\s+/g, " ").slice(0, 40);
    this.publish(session);
    const work = await this.services.openWork(session.meta.work, session.meta.repo);
    this.append(session, { kind: "user", id: message.id, text: message.text, attachments: userAttachments(message) });
    try {
      await this.attach(session, work);
      const prompt = this.turnPrompt(session, message, work);
      const response = await session.process.connection.prompt({ sessionId: session.meta.acpSessionId, prompt });
      this.append(session, { kind: "turn_end", stopReason: response.stopReason, usage: response.usage ?? null });
    } catch (error) {
      this.append(session, { kind: "error", message: authHint(error, session.process).message });
    } finally {
      for (const [requestId, pending] of this.permissions)
        if (pending.session === session.meta.id) {
          pending.resolve({ outcome: { outcome: "cancelled" } });
          this.permissions.delete(requestId);
        }
      session.meta.status = "idle";
      // The AI's own changes are part of what it knows; later changes are someone else's.
      this.saveFiles(session, work);
      this.compactFile(session.meta.id);
      this.publish(session);
      const next = session.meta.queue.shift();
      if (next) void this.runTurn(session, next);
    }
  }
  async cancel(id) {
    const session = this.get(id);
    session.meta.queue = [];
    if (session.meta.status !== "idle" && session.process) await session.process.connection.cancel({ sessionId: session.meta.acpSessionId });
    this.publish(session);
  }
  async setConfig(id, configId, value) {
    const session = this.get(id);
    if (!session.attached) await this.attach(session);
    const result = await session.process.connection.setSessionConfigOption({ sessionId: session.meta.acpSessionId, configId, value });
    if (result?.configOptions) session.meta.configOptions = result.configOptions;
    session.meta.choices = { ...session.meta.choices, [configId]: value };
    this.publish(session);
    return this.publicMeta(session);
  }
  /**
   * Send a queued message now: injected into the running turn (ACP steering) instead
   * of waiting for it to finish. Without a running turn it simply starts one.
   */
  async steer(id, messageId) {
    const session = this.get(id);
    const index = session.meta.queue.findIndex((item) => item.id === messageId);
    if (index < 0) throw notFound("这条消息已经发送");
    const [message] = session.meta.queue.splice(index, 1);
    this.publish(session);
    if (session.meta.status === "idle" || !session.process) {
      void this.runTurn(session, message);
      return { outcome: "started" };
    }
    const requeue = () => {
      session.meta.queue.splice(Math.min(index, session.meta.queue.length), 0, message);
      this.publish(session);
    };
    if (!session.process.steering) {
      requeue();
      throw problem(409, "这个 AI 不支持中途引导，消息会在这一轮结束后发送");
    }
    const work = await this.services.openWork(session.meta.work, session.meta.repo);
    let result;
    try {
      result = await session.process.connection.request("_session/steering", {
        sessionId: session.meta.acpSessionId,
        prompt: this.turnPrompt(session, message, work, { steering: true }),
        _meta: { steering: { idleBehavior: "promptRequired" } },
      });
    } catch (error) {
      requeue();
      throw problem(502, "引导失败：" + error.message);
    }
    if (result?.outcome === "promptRequired") {
      // The turn ended while the request was in flight.
      if (session.meta.status === "idle") void this.runTurn(session, message);
      else requeue();
      return { outcome: "queued" };
    }
    if (result?.outcome === "failed") {
      requeue();
      throw problem(502, "AI 没有接受这条引导消息，它会在这一轮结束后发送");
    }
    this.append(session, { kind: "user", id: message.id, text: message.text, attachments: userAttachments(message), steered: true });
    return { outcome: "injected" };
  }
  removeQueued(id, messageId) {
    const session = this.get(id);
    session.meta.queue = session.meta.queue.filter((item) => item.id !== messageId);
    this.publish(session);
  }
  /** Switch the profile/model of a conversation: continues in a new agent session. */
  async switchProfile(id, { profile, model = "" }) {
    const session = this.get(id);
    if (session.meta.status !== "idle") throw problem(409, "AI 正在工作，先停止再切换");
    const target = this.profiles.get(profile);
    Object.assign(session.meta, {
      profile: target.id,
      profileName: target.name,
      agent: target.agent,
      model,
      acpSessionId: null,
      configOptions: null,
    });
    session.attached = false;
    session.process = null;
    this.append(session, { kind: "notice", message: `已切换到 ${target.name}${model ? " · " + model : ""}，新消息将在新的上下文中继续` });
    await this.attach(session);
    this.publish(session);
    return this.publicMeta(session);
  }
  rename(id, title) {
    const session = this.get(id);
    session.meta.title = String(title || "").slice(0, 80) || session.meta.title;
    this.publish(session);
  }
  async remove(id) {
    const session = this.get(id);
    if (session.meta.status !== "idle") await this.cancel(id).catch(() => {});
    this.sessions.delete(id);
    if (session.token) this.services.auth.revokeInternal(session.token);
    fs.rmSync(path.join(this.sessionsDir, id + ".json"), { force: true });
    fs.rmSync(path.join(this.sessionsDir, id + ".jsonl"), { force: true });
    fs.rmSync(path.join(this.sessionsDir, id + ".files.json"), { force: true });
    fs.rmSync(path.join(this.sessionsDir, id + ".images"), { recursive: true, force: true });
    this.services.events.emit({ type: "ai-session-removed", session: id, work: session.meta.work });
  }

  // ---- ACP client callbacks ---------------------------------------------------------
  onUpdate({ sessionId, update }) {
    const session = this.sessionByAcp(sessionId);
    if (!session || session.replaying) return;
    if (update.sessionUpdate === "config_option_update" && update.configOptions) {
      session.meta.configOptions = update.configOptions;
      return this.publish(session);
    }
    if (update.sessionUpdate === "current_mode_update" && session.meta.modes) {
      session.meta.modes.currentModeId = update.currentModeId;
      return this.publish(session);
    }
    if (update.sessionUpdate === "available_commands_update") {
      session.meta.commands = update.availableCommands?.map(({ name, description, input }) => ({ name, description, hint: input?.hint }));
      return this.publish(session);
    }
    if (update.sessionUpdate === "session_info_update") {
      const title = String(update.title || "")
        .split("[FRAME]")[0]
        .trim();
      if (title) session.meta.title = title.slice(0, 80);
      return this.publish(session);
    }
    if (update.sessionUpdate === "usage_update") {
      session.meta.usage = update;
      return this.publish(session);
    }
    this.append(session, { kind: "update", update });
  }
  onPermission(params) {
    const session = this.sessionByAcp(params.sessionId);
    if (!session) return { outcome: { outcome: "cancelled" } };
    return this.askUser(session, params.toolCall, params.options);
  }
  /** A permission card in the chat; resolves with the ACP response once the user picks an option. */
  askUser(session, toolCall, options, signal) {
    const id = randomUUID();
    session.meta.status = "waiting";
    this.publish(session);
    this.append(session, { kind: "permission", id, toolCall, options });
    return new Promise((resolve) => {
      const pending = {
        session: session.meta.id,
        resolve: (outcome) => {
          this.append(session, { kind: "permission_result", id, outcome });
          if (session.meta.status === "waiting") {
            session.meta.status = "running";
            this.publish(session);
          }
          resolve(outcome);
        },
      };
      this.permissions.set(id, pending);
      signal?.addEventListener(
        "abort",
        () => {
          if (this.permissions.delete(id)) pending.resolve({ outcome: { outcome: "cancelled" } });
        },
        { once: true },
      );
    });
  }
  /**
   * FRAME tools run in our MCP server, where the agents' own confirmations do not reach
   * (Claude allows them up front, Codex never asks). When the user's mode confirms changes,
   * a FRAME tool that changes the work waits here for the user's answer.
   */
  async confirmTool(sessionId, tool, args, signal) {
    const session = this.sessions.get(sessionId);
    if (!session || tool.readOnly || !confirmsChanges(session.meta)) return true;
    const input = JSON.stringify(args ?? {}, null, 2);
    const response = await this.askUser(
      session,
      {
        toolCallId: randomUUID(),
        title: `mcp__frame__${tool.name}`,
        kind: "edit",
        rawInput: args,
        content: [{ type: "content", content: { type: "text", text: input.length > 1500 ? input.slice(0, 1500) + "\n…" : input } }],
      },
      [
        { optionId: "allow", name: "允许", kind: "allow_once" },
        { optionId: "reject", name: "拒绝", kind: "reject_once" },
      ],
      signal,
    );
    return response.outcome.outcome === "selected" && response.outcome.optionId === "allow";
  }
  respondPermission(requestId, optionId) {
    const pending = this.permissions.get(requestId);
    if (!pending) throw notFound("这个权限请求已经结束");
    this.permissions.delete(requestId);
    pending.resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
  }
  async readFile() {
    throw problem(400, "fs capability not offered");
  }
  async writeFile() {
    throw problem(400, "fs capability not offered");
  }

  // ---- what the AI knows ---------------------------------------------------------------------

  /**
   * The content blocks of a user message: the text, then a [FRAME] block with the current
   * situation and only what changed since the AI last knew it (files others changed,
   * experience documents others edited). Updates what the session has seen. A message
   * steered into a running turn skips the file changes: they are mostly the AI's own so far.
   */
  turnPrompt(session, message, work, { steering = false } = {}) {
    const { services } = this;
    const lines = [`[FRAME] 作品 ${work.id}，作品文件在 projects/${work.slug}/`];
    const view = message.view ?? services.viewState.get(`${work.repo}/${work.id}`);
    const meta = services.works.meta(work).meta;
    if (view) {
      lines.push(`用户播放器位置 ${formatTime(view.time ?? 0)}${view.playing ? "（播放中）" : ""}`);
      const selected = selectionText(view.selection, meta);
      if (selected) lines.push(`用户在时间轴上选中了：${selected}`);
      if (view.editing) lines.push(`用户在编辑器中打开着：${view.editing}`);
    }
    if (!steering) {
      const files = snapshotFiles(work.dir);
      const changedFiles = filesNotice(session.files, files);
      session.files = files;
      if (changedFiles) lines.push(changedFiles);
    }
    const references = [];
    for (const attachment of message.attachments) {
      if (attachment.type === "frame") references.push(`画面 ${formatTime(attachment.time)}（截图见附图）`);
      if (attachment.type === "range") references.push(`片段 ${formatTime(attachment.start)}–${formatTime(attachment.end)}`);
      if (attachment.type === "layer") references.push(`图层 ${attachment.id}${attachment.name ? "「" + attachment.name + "」" : ""}`);
      if (attachment.type === "asset") references.push(`素材 ${attachment.url}`);
      if (attachment.type === "file") references.push(`文件 ${attachment.path}`);
      if (attachment.type === "experience") references.push(`经验库文档 ${attachment.path}`);
      if (attachment.type === "problem") references.push(`问题：${attachment.message}`);
    }
    const images = message.attachments.filter((item) => item.type === "image").length;
    if (images) references.push(`${images} 张图片（用户直接发给你的，见附图，不是作品里的画面）`);
    if (references.length) lines.push("用户引用：" + references.join("；"));
    const library = services.experience?.current(work) ?? null;
    const experience = experienceDelta(session.meta.context?.experience ?? null, library);
    const referenced = referencedExperience(
      experience.seen,
      library,
      message.attachments.filter((item) => item.type === "experience").map((item) => item.path),
    );
    session.meta.context = { ...session.meta.context, experience: referenced.seen };
    this.saveMeta(session);
    if (experience.text) lines.push("", experience.text);
    if (referenced.text) lines.push("", referenced.text);

    const blocks = [];
    if (message.text.trim()) blocks.push({ type: "text", text: message.text });
    blocks.push({ type: "text", text: lines.join("\n") });
    for (const attachment of message.attachments) {
      if (attachment.data && attachment.mimeType?.startsWith("image/")) blocks.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
      if (attachment.type === "file" || attachment.type === "asset") {
        const relative = attachment.path || attachment.url?.replace(/^films\/[^/]+\//, "public/");
        if (relative) blocks.push({ type: "resource_link", uri: "file://" + path.join(work.dir, relative), name: path.basename(relative) });
      }
    }
    return blocks;
  }

  /** An experience tool tells us what this session's AI just read or wrote (hash null: deleted). */
  noteExperience(sessionId, library, file, hash, level = "content") {
    const session = this.sessions.get(sessionId);
    if (!session?.meta.context?.experience) return;
    session.meta.context = { ...session.meta.context, experience: noteSeen(session.meta.context.experience, library, file, hash, level) };
    this.saveMeta(session);
  }

  /** The work's file fingerprint after a turn survives restarts, so the next turn still sees others' changes. */
  saveFiles(session, work) {
    try {
      session.files = snapshotFiles(work.dir);
      writeFileAtomic(path.join(this.sessionsDir, session.meta.id + ".files.json"), JSON.stringify(session.files));
    } catch {}
  }
  readFiles(session) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.sessionsDir, session.meta.id + ".files.json"), "utf8"));
    } catch {
      return null;
    }
  }

  close() {
    clearInterval(this.timer);
    for (const entry of this.processes.values()) entry.process.kill();
    this.processes.clear();
  }
}

const isModel = (options, id) => options.some((option) => option.id === id && (option.category === "model" || option.id === "model"));

/** Attachments as stored in the transcript: image data becomes an image entry (saved to a file by storeImages). */
const userAttachments = (message) => message.attachments.map((item) => (item.data ? { ...item, type: "image", kind: item.type } : item));

function authHint(error, process) {
  const message = error?.message || String(error);
  if (/auth/i.test(message) || error?.code === -32000) {
    const how = process?.profile?.kind === "account" ? `请在 设置 → AI 中登录 ${process.profile.name}` : "请检查 API Key 和接口地址";
    return new Error(`${message}。${how}`);
  }
  return error instanceof Error ? error : new Error(message);
}

/** Merge consecutive text chunks of the same kind (and message id). */
export function compact(entries) {
  const out = [];
  for (const entry of entries) {
    const prev = out.at(-1);
    const update = entry.update;
    if (
      entry.kind === "update" &&
      prev?.kind === "update" &&
      ["agent_message_chunk", "agent_thought_chunk"].includes(update?.sessionUpdate) &&
      prev.update.sessionUpdate === update.sessionUpdate &&
      update.content?.type === "text" &&
      prev.update.content?.type === "text" &&
      (prev.update.messageId ?? null) === (update.messageId ?? null)
    ) {
      prev.update = { ...prev.update, content: { ...prev.update.content, text: prev.update.content.text + update.content.text } };
      continue;
    }
    out.push(structuredClone(entry));
  }
  return out;
}
