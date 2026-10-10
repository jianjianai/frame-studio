import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { randomUUID, createHash } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { AGENTS, agentEnv, CLAUDE_REFRESH_BUSY, waitForClaudeRefresh } from "./agents.mjs";
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
  /** The options (model, mode, effort) a profile offered last, for the pickers of a new conversation. */
  optionsOf(profileId) {
    const latest = [...this.sessions.values()]
      .filter((session) => session.meta.profile === profileId && session.meta.configOptions?.length)
      .sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt))[0];
    return latest?.meta.configOptions ?? [];
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
  /**
   * Branch a conversation: a new conversation holding the first `keep` turns of this one,
   * with the agent's context forked right after its last reply in them. With `text` it
   * continues with that message, which is how an earlier message is edited and resent.
   */
  async fork(id, { keep, text = "", attachments = [], view = null }) {
    const parent = this.get(id);
    const entries = this.transcript(id);
    const starts = entries.flatMap((entry, index) => (entry.kind === "user" && !entry.steered ? [index] : []));
    if (!Number.isInteger(keep) || keep < 0 || keep > starts.length) throw problem(400, "无效的分支位置");
    if (keep === starts.length && parent.meta.status !== "idle") throw problem(409, "AI 还在回复这一轮，等它完成再分支");
    const kept = entries.slice(0, keep < starts.length ? starts[keep] : entries.length);
    const messageId = kept.findLast((entry) => entry.kind === "update" && entry.update?.sessionUpdate === "agent_message_chunk" && entry.update.messageId)
      ?.update.messageId;
    const now = new Date().toISOString();
    const session = {
      meta: {
        id: randomUUID(),
        work: parent.meta.work,
        repo: parent.meta.repo,
        profile: parent.meta.profile,
        profileName: parent.meta.profileName,
        agent: parent.meta.agent,
        model: parent.meta.model,
        title: parent.meta.title,
        createdAt: now,
        updatedAt: now,
        status: "idle",
        queue: [],
        choices: { ...parent.meta.choices },
        usage: keep === starts.length ? (parent.meta.usage ?? null) : null,
        // Turns dropped from the branch may have changed files: said once in the first message.
        branch: { from: parent.meta.id, title: parent.meta.title, keep, dropped: starts.length - keep },
      },
      process: null,
      attached: false,
      forkFrom: messageId && parent.meta.acpSessionId && parent.meta.agent ? { sessionId: parent.meta.acpSessionId, messageId } : null,
    };
    // The transcript so far, with its images, then a divider.
    const from = `/api/ai/sessions/${parent.meta.id}/images/`;
    const to = `/api/ai/sessions/${session.meta.id}/images/`;
    const lines = kept.map((entry) => JSON.stringify(entry));
    for (const [, name] of lines.join("\n").matchAll(/\/api\/ai\/sessions\/[^/]+\/images\/([a-f0-9]{24}\.[a-z]+)/g)) {
      const source = path.join(this.sessionsDir, parent.meta.id + ".images", name);
      if (!fs.existsSync(source)) continue;
      fs.mkdirSync(path.join(this.sessionsDir, session.meta.id + ".images"), { recursive: true });
      fs.copyFileSync(source, path.join(this.sessionsDir, session.meta.id + ".images", name));
    }
    lines.push(JSON.stringify({ at: Date.now(), kind: "branch", from: parent.meta.id, title: parent.meta.title, keep }));
    fs.writeFileSync(path.join(this.sessionsDir, session.meta.id + ".jsonl"), lines.map((line) => line.replaceAll(from, to)).join("\n") + "\n");
    this.sessions.set(session.meta.id, session);
    try {
      await this.attach(session);
    } catch (error) {
      await this.remove(session.meta.id).catch(() => {});
      throw error;
    }
    this.publish(session);
    if (text.trim() || attachments.length) await this.prompt(session.meta.id, { text, attachments: this.resendable(attachments), view });
    return this.publicMeta(session);
  }
  /** The agent's own fork of the parent context; null when it cannot (the branch then starts fresh). */
  async forkContext(session, process, params) {
    const { sessionId, messageId } = session.forkFrom;
    session.forkFrom = null;
    try {
      const forked = await process.connection.unstable_forkSession({
        ...params,
        sessionId,
        _meta: { ...params._meta, jetbrains: { air: { fork: { version: 1, messageId } } } },
      });
      session.meta.acpSessionId = forked.sessionId;
      // Codex hands back a live session; Claude writes the forked conversation, which is then resumed.
      return forked.configOptions || forked.modes ? forked : null;
    } catch (error) {
      console.warn("fork failed:", error.message);
      this.append(session, { kind: "notice", message: "AI 的上下文无法从这里分支，分支会在新的上下文中继续（对话记录仍保留在这里）" });
      return null;
    }
  }
  /** Attachments of a stored message, ready to send again: images are read back from the store. */
  resendable(attachments) {
    return attachments
      .map((item) => {
        if (item?.type !== "image" || !item.uri) return item;
        const [, sessionId, name] = /^\/api\/ai\/sessions\/([^/]+)\/images\/([^/]+)$/.exec(item.uri) ?? [];
        try {
          const { uri: _uri, kind, ...rest } = item;
          return { ...rest, type: kind || "image", data: fs.readFileSync(this.imageFile(sessionId, name)).toString("base64") };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /** Make sure the session has a live ACP session (new, resumed or reloaded); one attach at a time. */
  attach(session, work) {
    if (session.attached && session.process) return Promise.resolve();
    session.attaching ??= this.connect(session, work).finally(() => (session.attaching = null));
    return session.attaching;
  }
  async connect(session, work) {
    work ||= await this.services.openWork(session.meta.work, session.meta.repo);
    const process = await this.process(session.meta.profile, session.meta.model);
    // The agent loads the brief (AGENTS.md) as the session starts or resumes: it is the baseline.
    await this.services.experience?.prepare(work);
    await this.services.resources?.overview(work.repo).catch(() => {}); // the brief's section on the material libraries
    const brief = this.services.works.writeBrief(work);
    let result;
    // The work root holds the platform AGENTS.md/CLAUDE.md and the engine links; the work itself is projects/<name>/.
    const common = { cwd: work.root, mcpServers: this.mcpServers(session) };
    // Claude never asks about FRAME tools (confirmTool does, following the session mode) or read-only inspection.
    const meta = process.agent === "claude" ? { _meta: { claudeCode: { options: { allowedTools: CLAUDE_ALLOWED_TOOLS } } } } : {};
    try {
      if (!session.meta.acpSessionId && session.forkFrom) result = await this.forkContext(session, process, { ...common, ...meta });
      if (!session.meta.acpSessionId) {
        result = await process.connection.newSession({ ...common, ...meta });
        session.meta.acpSessionId = result.sessionId;
      } else if (!result) {
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
    // What the brief told the AI; after a compaction that is all it is sure to remember.
    session.briefSeen = brief.experience ?? {};
    session.meta.context = {
      ...session.meta.context,
      experience: rebaseSeen(this.services.experience?.follow(work, session.meta.context?.experience) ?? {}, session.briefSeen),
    };
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
    if (session.meta.title === "新对话" && message.text.trim() && !isCommand(session, message.text))
      session.meta.title = message.text.trim().replace(/\s+/g, " ").slice(0, 40);
    this.publish(session);
    const work = await this.services.openWork(session.meta.work, session.meta.repo);
    this.append(session, { kind: "user", id: message.id, text: message.text, attachments: userAttachments(message) });
    try {
      await this.attach(session, work);
      const prompt = this.turnPrompt(session, message, work);
      let response;
      for (let attempt = 1; ; attempt++) {
        try {
          response = await session.process.connection.prompt({ sessionId: session.meta.acpSessionId, prompt });
          break;
        } catch (error) {
          // A starting Claude refreshes an expired login from several places at once: the ones that
          // lose fail at once, and one that dies mid-refresh leaves the lock until it is stale (60 s).
          // Wait that out once and send the message again, instead of making the user retry by hand.
          if (attempt > 1 || session.process?.agent !== "claude" || !CLAUDE_REFRESH_BUSY.test(error?.message || "")) throw error;
          this.append(session, { kind: "notice", message: "Claude 正在刷新登录，完成后会自动重发这条消息（最多等一分钟左右）" });
          this.publish(session);
          session.waiting = new AbortController();
          const outcome = await waitForClaudeRefresh({ signal: session.waiting.signal }).finally(() => (session.waiting = null));
          if (outcome === "aborted") {
            response = { stopReason: "cancelled" };
            break;
          }
        }
      }
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
  /** Summarize the conversation so far to free context (the agents' own /compact). */
  compact(id) {
    return this.prompt(id, { text: "/compact" });
  }
  async cancel(id) {
    const session = this.get(id);
    session.meta.queue = [];
    session.waiting?.abort(); // waiting for a login refresh: stop instead of sending again
    if (session.meta.status !== "idle" && session.process) await session.process.connection.cancel({ sessionId: session.meta.acpSessionId });
    this.publish(session);
  }
  /**
   * Change a session option (model, mode, effort). The choice shows at once; a live agent
   * session gets it right away, a detached one when it next starts (restoreChoices), so
   * nobody waits seconds for an agent to start just to flip a picker.
   */
  async setConfig(id, configId, value) {
    const session = this.get(id);
    const option = session.meta.configOptions?.find((item) => item.id === configId);
    if (option?.options && !option.options.some((item) => item.value === value)) throw problem(400, "没有这个选项");
    const before = { configOptions: session.meta.configOptions, choices: session.meta.choices };
    session.meta.choices = { ...session.meta.choices, [configId]: value };
    if (session.meta.configOptions)
      session.meta.configOptions = session.meta.configOptions.map((item) => (item.id === configId ? { ...item, currentValue: value } : item));
    this.publish(session);
    if (!session.attached || !session.process) {
      // Another model may offer other options (effort): start the agent in the background to
      // learn them; the choice above is applied as it attaches.
      if (option?.category === "model" || configId === "model")
        void this.attach(session).then(
          () => this.publish(session),
          () => {},
        );
      return this.publicMeta(session);
    }
    try {
      const result = await session.process.connection.setSessionConfigOption({ sessionId: session.meta.acpSessionId, configId, value });
      // The agent's answer is authoritative (another model may offer other efforts).
      if (result?.configOptions) session.meta.configOptions = result.configOptions;
    } catch (error) {
      Object.assign(session.meta, before);
      this.publish(session);
      throw problem(502, "切换失败：" + (error?.message || error));
    }
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
      // Claude marks forked conversations "(fork)"; branches have their own icon instead.
      const title = String(update.title || "")
        .split("[FRAME]")[0]
        .replace(/\s*\(fork\)\s*$/i, "")
        .trim();
      if (title) session.meta.title = title.slice(0, 80);
      return this.publish(session);
    }
    if (update.sessionUpdate === "usage_update") {
      session.meta.usage = update;
      return this.publish(session);
    }
    // Both agents report a compaction (manual or automatic) as a "Compact conversation" tool call.
    if (update.sessionUpdate === "tool_call" && update.title === "Compact conversation") session.compacting = update.toolCallId;
    if (update.toolCallId && update.toolCallId === session.compacting && update.status === "completed") {
      session.compacting = null;
      // The summary keeps the gist, not documents read along the way: assume only the brief.
      session.meta.context = { ...session.meta.context, experience: session.briefSeen ?? {} };
      this.saveMeta(session);
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
    // A slash command goes as typed: anything appended would become its arguments.
    if (isCommand(session, message.text) && !message.attachments.length) return [{ type: "text", text: message.text.trim() }];
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
      if (attachment.type === "experience") references.push(`经验库${attachment.library ? `「${attachment.library}」` : ""}的文档 ${attachment.path}`);
      if (attachment.type === "resource") references.push(`素材库资源 ${attachment.id}${attachment.title ? `「${attachment.title}」` : ""}（resource_view 看详情和预览图）`);
      if (attachment.type === "problem") references.push(`问题：${attachment.message}`);
    }
    const images = message.attachments.filter((item) => item.type === "image").length;
    if (images) references.push(`${images} 张图片（用户直接发给你的，见附图，不是作品里的画面）`);
    if (references.length) lines.push("用户引用：" + references.join("；"));
    // Published: the files are read-only and FRAME's changing tools refuse; talking it over and the experience library are fine.
    if (services.works.published(work))
      lines.push(
        "这个作品已发布，只能查看：不要修改作品文件（文件是只读的，修改会失败），也不能改变它关联的经验库和素材库。经验库和素材库本身不属于作品，可以照常整理：讨论、复盘，用 experience_write 整理经验并用 experience_commit 保存，用 material_write 整理素材库，需要时用 experience_link / materials_link 的 create 新建库。要改作品，请用户先取消发布或创建副本。",
      );
    const remote = services.remoteSync?.get(work);
    if (remote?.state === "behind")
      lines.push(
        `GitHub 上有这个作品 ${remote.behind} 个更新的版本（来自其他设备或对话），本机的作品文件还是旧的${remote.blocked?.length ? `（本机未保存的修改和它们改了同样的文件：${remote.blocked.join("、")}）` : ""}。不要修改作品文件：请用户先在工作台顶部的提示中更新到最新版本，避免在旧版本上继续修改。`,
      );
    else if (remote?.state === "diverged" || remote?.state === "conflict")
      lines.push(
        `本机和 GitHub 上都有这个作品的新版本（冲突：本机 ${remote.ahead} 个、GitHub ${remote.behind} 个）。不要修改作品文件：请用户先在工作台顶部的提示中选择合并双方、采用 GitHub 的版本或保留本机的版本。`,
      );
    else if (remote?.pulled && Date.now() - Date.parse(remote.at) < 15000)
      lines.push(`这一轮开始前，FRAME 从 GitHub 拉取了 ${remote.pulled} 个更新的版本（其他设备上的修改），作品文件已是最新：改文件前先读取。`);
    if (session.meta.branch?.dropped && !session.meta.branch.told) {
      lines.push("这是从之前的对话中间分支出来的对话：分支点之后那些轮次对作品文件做过的修改仍在文件里，没有回退。改文件前先读取最新内容。");
      session.meta.branch = { ...session.meta.branch, told: true };
    }
    const libraries = services.experience?.current(work) ?? [];
    const experience = experienceDelta(services.experience?.follow(work, session.meta.context?.experience) ?? {}, libraries);
    const referenced = referencedExperience(
      experience.seen,
      libraries,
      message.attachments.filter((item) => item.type === "experience").map((item) => ({ library: item.library, path: item.path })),
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
      if ((attachment.type === "file" || attachment.type === "asset") && !String(attachment.url || "").startsWith("materials/")) {
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

  /** The AI linked or unlinked experience libraries itself: it knows the new ones as its tool showed them. */
  noteExperienceLibraries(sessionId, { added = {}, removed = [] }) {
    const session = this.sessions.get(sessionId);
    if (!session?.meta.context) return;
    const experience = { ...session.meta.context.experience, ...added };
    for (const id of removed) delete experience[id];
    session.meta.context = { ...session.meta.context, experience };
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
/** "/compact", "/review …": a command the agent offers (both offer compact). */
function isCommand(session, text) {
  const name = /^\/([a-z][\w-]*)(\s|$)/i.exec(text.trim())?.[1];
  return Boolean(name) && (name === "compact" || Boolean(session.meta.commands?.some((command) => command.name === name)));
}

const userAttachments = (message) => message.attachments.map((item) => (item.data ? { ...item, type: "image", kind: item.type } : item));

export function authHint(error, process) {
  const message = error?.message || String(error);
  // Another Claude Code on this computer refreshing the same login: it passes, signing in again is not the cure.
  if (CLAUDE_REFRESH_BUSY.test(message)) return new Error(`${message}。这是暂时的（Claude 正在刷新登录，或者上次刷新中途中断），稍等一分钟再发`);
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
