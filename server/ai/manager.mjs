import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { randomUUID, createHash } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { AGENTS, agentEnv, CLAUDE_REFRESH_BUSY, moveClaudeConversation, waitForClaudeRefresh } from "./agents.mjs";
import { Profiles } from "./profiles.mjs";
import { appVersion } from "../config.mjs";
import { problem, notFound, writeFileAtomic } from "../util.mjs";
import { formatTime } from "../render.mjs";
import { experienceDelta, filesNotice, noteSeen, rebaseSeen, referencedExperience, selectionText, snapshotFiles } from "./context.mjs";
import { lastReceived } from "./heartbeat.mjs";
import { ClaudeGoalReader, CODEX_STATUSES, goalCommand, goalOutput, hookCap } from "./goal.mjs";

const IDLE_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 3000;
/**
 * How often a running Claude turn's goal checks are read from its conversation file (also
 * before each update the agent sends, so a check shows before the reply that follows it).
 */
const GOAL_POLL_MS = 1000;
// What "continue" says to the AI for the user.
const GOAL_CONTINUE = "继续朝目标做";
// A turn the studio's shutdown cut off (an update) goes on after the restart, if it comes soon.
const RESUME_WITHIN_MS = 30 * 60 * 1000;
const RESUME_TEXT = "FRAME 刚才更新重启，打断了你上一轮的工作（这条消息是自动发的）。请从中断的地方接着做。";
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
    this.pulse = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    this.pulse.unref();
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
      const { data, ...rest } = value;
      return { ...rest, uri: this.saveImage(session, data, value.mimeType) };
    }
    // Claude's raw tool output uses the Anthropic API shape: { type: "image", source: { type: "base64", data } }.
    if (value.type === "image" && value.source?.type === "base64" && typeof value.source.data === "string" && value.source.data.length > 256)
      return { ...value, source: { type: "url", url: this.saveImage(session, value.source.data, value.source.media_type) } };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.storeImages(session, item)]));
  }
  saveImage(session, base64, mimeType) {
    const bytes = Buffer.from(base64, "base64");
    const ext = { "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[mimeType] ?? "jpg";
    const name = createHash("sha256").update(bytes).digest("hex").slice(0, 24) + "." + ext;
    const dir = path.join(this.sessionsDir, session.meta.id + ".images");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
    return `/api/ai/sessions/${session.meta.id}/images/${name}`;
  }
  imageFile(id, name) {
    if (!/^[a-f0-9]{24}\.(png|jpg|webp|gif)$/.test(name)) throw notFound("图片不存在");
    return path.join(this.sessionsDir, id + ".images", name);
  }
  append(session, entry) {
    const line = this.storeImages(session, { at: Date.now(), ...entry });
    const file = path.join(this.sessionsDir, session.meta.id + ".jsonl");
    fs.appendFileSync(file, JSON.stringify(line) + "\n");
    // Megabytes of command output would hold up every other event on a slow link. `end` (where
    // the entry ends in the file) tells a chat still loading the conversation whether it has it.
    const end = fs.statSync(file).size;
    this.services.events.emit({ type: "ai-event", session: session.meta.id, work: session.meta.work, entry: lean(line), end });
  }
  publish(session) {
    session.meta.updatedAt = new Date().toISOString();
    this.saveMeta(session);
    this.services.events.emit({ type: "ai-session", session: this.publicMeta(session) });
  }
  publicMeta(session) {
    // What the AI has seen (for per-message changes) is the server's business; queued
    // messages are shown by their text (their pictures stay here until sent).
    const { context: _context, queue, ...meta } = session.meta;
    return { ...meta, queue: queue?.map(({ id, text }) => ({ id, text })) };
  }
  /**
   * A transcript as stored: its bytes and where each line (one entry) is in them. Long
   * conversations are tens of megabytes; only the lines asked for are decoded.
   */
  stored(id) {
    const file = path.join(this.sessionsDir, id + ".jsonl");
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    const ranges = [];
    for (let start = 0; start < bytes.length;) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      if (end > start) ranges.push([start, end]);
      start = end + 1;
    }
    return {
      size: bytes.length,
      count: ranges.length,
      entry: (index) => parseLine(bytes.toString("utf8", ranges[index][0], ranges[index][1])),
      /** The start of a line: an entry's kind comes right after its time. */
      head: (index) => bytes.toString("utf8", ranges[index][0], Math.min(ranges[index][1], ranges[index][0] + 100)),
      /** The lines that contain `text`. */
      containing(text) {
        const needle = Buffer.from(text);
        const found = new Set();
        for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + needle.length)) {
          let low = 0,
            high = ranges.length - 1;
          while (low < high) {
            const middle = (low + high + 1) >> 1;
            if (ranges[middle][0] <= at) low = middle;
            else high = middle - 1;
          }
          found.add(low);
        }
        return [...found];
      },
    };
  }
  transcript(id) {
    const stored = this.stored(id);
    return compact(Array.from({ length: stored.count }, (_, index) => stored.entry(index)).filter(Boolean));
  }
  /**
   * The conversation as the chat loads it, a few turns at a time: the latest turns, or those
   * before turn `before` when the chat scrolls back; at most `turns`, and no more than fill
   * `budget` characters (at least one). A turn starts at a message of the user's own (the
   * numbering fork() uses; messages steered into a running turn belong to it); `turn` is the
   * number of the first turn returned, `turns` how many there are, `size` how much of the
   * file was read (later events end after it). Tool output is cut short (lean).
   */
  history(id, { turns = 8, before, budget = 600 * 1024 } = {}) {
    const stored = this.stored(id);
    const starts = [];
    for (let index = 0; index < stored.count; index++) {
      if (!stored.head(index).includes('"kind":"user"')) continue;
      const entry = stored.entry(index);
      if (entry?.kind === "user" && !entry.steered) starts.push(index);
    }
    // Turn i is lines bounds[i]..bounds[i + 1]: what comes before the first message goes with it.
    const bounds = [0, ...starts.slice(1), stored.count];
    const count = bounds.length - 1;
    const last = Number.isInteger(before) ? Math.max(0, Math.min(before, count)) : count;
    let first = last;
    let size = 0;
    const pieces = [];
    while (first > 0 && last - first < turns && (size < budget || first === last)) {
      first--;
      const entries = [];
      for (let index = bounds[first]; index < bounds[first + 1]; index++) entries.push(stored.entry(index));
      const piece = compact(entries.filter(Boolean)).map(lean);
      size += JSON.stringify(piece).length;
      pieces.unshift(piece);
    }
    return { entries: pieces.flat(), turn: first, turns: count, size: stored.size };
  }
  /** Every stored update of one tool call, whole (what lean() cut short). */
  toolCall(id, toolCallId) {
    const stored = this.stored(id);
    return stored
      .containing(JSON.stringify(String(toolCallId)))
      .map((index) => stored.entry(index))
      .filter((entry) => entry?.kind === "update" && entry.update?.toolCallId === toolCallId)
      .map((entry) => ({ ...entry, update: unwrapToolResult(entry.update) }));
  }
  /**
   * Merge streamed text chunks so stored transcripts stay small. Only what was written since
   * `from` (where a turn started): the rest is merged already, and long transcripts are not
   * read and written again at the end of every turn.
   */
  compactFile(id, from = 0) {
    const file = path.join(this.sessionsDir, id + ".jsonl");
    const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size <= from) return;
    const tail = Buffer.alloc(size - from);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, tail, 0, tail.length, from);
    } finally {
      fs.closeSync(fd);
    }
    const lines = tail.toString("utf8").split("\n").filter(Boolean);
    const entries = compact(lines.map(parseLine).filter(Boolean));
    if (entries.length === lines.length) return;
    const temp = `${file}.${process.pid}.tmp`;
    fs.copyFileSync(file, temp);
    fs.truncateSync(temp, from);
    fs.appendFileSync(temp, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    fs.renameSync(temp, file);
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
      if (session.meta.status === "running" && !this.closing) {
        this.append(session, { kind: "error", message: `AI 进程意外退出（${code}）：${process.stderr.trim().slice(-400)}` });
        session.meta.status = "idle";
        this.publish(session);
      }
    }
  }
  /**
   * Tell the chat when each running Claude turn last heard from the model (see heartbeat.mjs):
   * thinking it doesn't show looks the same as a stalled connection otherwise.
   */
  async heartbeat() {
    const running = [...this.sessions.values()].filter(
      (session) => session.meta.status === "running" && session.process?.agent === "claude" && session.process.child?.pid,
    );
    if (this.probing || !running.length) return;
    this.probing = true;
    try {
      const times = await lastReceived(
        running.map((session) => ({ id: session.meta.id, sessionId: session.meta.acpSessionId, root: session.process.child.pid })),
      );
      for (const session of running) {
        if (!times.has(session.meta.id) || session.meta.status !== "running") continue;
        const at = times.get(session.meta.id);
        if (at !== null) session.heartbeat = Math.max(session.heartbeat ?? 0, at);
        this.services.events.emit({ type: "ai-heartbeat", session: session.meta.id, work: session.meta.work, at: session.heartbeat ?? null });
      }
    } finally {
      this.probing = false;
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
        // Claude's fork copies the messages, not the cost total: it counts from zero (see noteCost).
        spent: 0,
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
    await this.services.materials?.dir(work.repo).catch(() => {}); // the brief counts the material libraries
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
        session.meta.spent = 0; // a new agent session has cost nothing yet
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
          session.meta.spent = 0;
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
    // The answer carries the session as it now is (queued or running): the chat shows it at once.
    if (session.meta.status !== "idle") {
      session.meta.queue.push(message);
      this.publish(session);
      return { queued: true, id: message.id, session: this.publicMeta(session) };
    }
    void this.runTurn(session, message);
    return { queued: false, id: message.id, session: this.publicMeta(session) };
  }
  async runTurn(session, message) {
    session.meta.status = "running";
    session.turnCost = undefined;
    session.heartbeat = undefined;
    // A conversation is named by its first message; one started with a goal, by the goal.
    const named = goalCommand(message.text)?.objective ?? (isCommand(session, message.text) ? "" : message.text);
    if (session.meta.title === "新对话" && named.trim()) session.meta.title = named.trim().replace(/\s+/g, " ").slice(0, 40);
    this.publish(session);
    const turnStart = fs.statSync(path.join(this.sessionsDir, session.meta.id + ".jsonl"), { throwIfNoEntry: false })?.size ?? 0;
    const work = await this.services.openWork(session.meta.work, session.meta.repo);
    this.append(session, { kind: "user", id: message.id, text: message.text, attachments: userAttachments(message) });
    let goalPoll = null;
    try {
      await this.attach(session, work);
      const prompt = this.turnPrompt(session, message, work);
      this.noteGoalCommand(session, message.text);
      // Claude writes each goal check to its conversation file; read them as the turn goes (also
      // those of a goal set before the studio knew of goals, or while it was down).
      if (session.process?.agent === "claude" && session.meta.acpSessionId) {
        if (session.goalReader?.id !== session.meta.acpSessionId) session.goalReader = new ClaudeGoalReader(session.meta.acpSessionId);
        goalPoll = setInterval(() => this.readGoal(session), GOAL_POLL_MS);
      }
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
      // What the agent sent just before its answer (the turn's cost) can still be on its way
      // through the connection, which hands answers over sooner than notifications.
      await new Promise((resolve) => setImmediate(resolve));
      // The goal's last check (achieved, say) belongs before the turn's end, and after it why
      // Claude ended the turn anyway.
      if (goalPoll) this.readGoal(session);
      if (session.goalCapped) this.applyGoal(session, { type: "capped", count: session.goalCapped });
      const cost = session.turnCost && this.pricedByClaude(session) ? { cost: session.turnCost } : {};
      this.append(session, { kind: "turn_end", stopReason: response.stopReason, usage: response.usage ?? null, ...cost });
    } catch (error) {
      // The studio shutting down ended it: said so already (close).
      if (!this.closing) this.append(session, { kind: "error", message: authHint(error, session.process).message });
    } finally {
      if (goalPoll) {
        clearInterval(goalPoll);
        this.readGoal(session);
      }
      // What the AI recorded in experience libraries this turn: a version of each.
      const writes = session.experienceWrites;
      session.experienceWrites = null;
      if (writes?.size) await this.services.experience?.saveTurn([...writes.values()]);
      session.goalCapped = null;
      for (const [requestId, pending] of this.permissions)
        if (pending.session === session.meta.id) {
          pending.resolve({ outcome: { outcome: "cancelled" } });
          this.permissions.delete(requestId);
        }
      session.meta.status = "idle";
      // The AI's own changes are part of what it knows; later changes are someone else's.
      this.saveFiles(session, work);
      this.compactFile(session.meta.id, turnStart);
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
    this.noteGoalCommand(session, message.text);
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
  /**
   * Goal mode from the chat's controls: the agents' own "/goal" commands. While the AI works
   * the command goes into the running turn (as the CLI takes /goal at once), else it is a
   * message of its own. Pause and resume are Codex's. "continue" asks the AI to go on toward
   * the goal after a turn ended short of it (stopped, or Claude's limit of checks in a row).
   */
  async goal(id, { action, objective = "" } = {}) {
    const session = this.get(id);
    if (!["set", "clear", "pause", "resume", "continue"].includes(action)) throw problem(400, "action 是 set、clear、pause、resume 或 continue");
    if (action === "continue") {
      if (!session.meta.goal) throw problem(400, "没有进行中的目标");
      return this.prompt(id, { text: GOAL_CONTINUE });
    }
    if (action === "set" && !String(objective).trim()) throw problem(400, "目标不能为空");
    if (action === "set" && String(objective).trim().length > 4000) throw problem(400, "目标最多 4000 字");
    if ((action === "pause" || action === "resume") && session.meta.agent !== "codex") throw problem(400, "只有 Codex 的目标可以暂停和继续");
    const text = action === "set" ? `/goal ${String(objective).trim()}` : `/goal ${action}`;
    if (session.meta.status !== "idle" && session.process?.steering) {
      const message = { id: randomUUID(), text, attachments: [], view: null };
      session.meta.queue.unshift(message);
      return this.steer(id, message.id);
    }
    return this.prompt(id, { text });
  }
  /** A goal command on its way to the agent: the user's "/goal clear" is told as theirs. */
  noteGoalCommand(session, text) {
    if (goalCommand(text)?.action === "clear") session.goalClearing = true;
  }
  /** Claude's goal checks written since the last look (its turns read its file, see runTurn). */
  readGoal(session) {
    if (!session.goalReader) return;
    try {
      for (const event of session.goalReader.read()) this.applyGoal(session, event);
    } catch (error) {
      console.warn("goal read failed", error.message);
    }
  }
  /**
   * One goal event: the goal the chat shows changes, and the conversation gets the line the
   * CLI prints for it (set, not met yet and why, achieved, could not be achieved, cleared).
   */
  applyGoal(session, event) {
    const goal = session.meta.goal ?? null;
    const at = event.at ?? Date.now();
    const line = (entry) => this.append(session, { kind: "goal", ...entry });
    switch (event.type) {
      case "set":
        if (goal && goal.objective === event.objective) return;
        session.meta.goal = { objective: event.objective, status: "active", setAt: at, checks: 0 };
        session.goalClearing = false;
        line({ event: "set", objective: event.objective });
        break;
      case "check": {
        // A goal set before the studio knew of it shows from its first check on.
        const known = goal ?? (event.objective ? { objective: event.objective, status: "active", setAt: at, checks: 0 } : null);
        if (!known) return;
        session.meta.goal = { ...known, checks: (known.checks ?? 0) + 1, lastReason: event.reason ?? null, checkedAt: at };
        line({ event: "check", objective: known.objective, reason: event.reason ?? null, checks: session.meta.goal.checks });
        break;
      }
      case "active":
        // Asked for its status ("/goal"): the agent's goal, known or not.
        session.meta.goal =
          goal && goal.objective === event.objective
            ? { ...goal, checks: Math.max(goal.checks ?? 0, event.checks), lastReason: event.reason ?? goal.lastReason ?? null }
            : { objective: event.objective, status: "active", setAt: at, checks: event.checks, lastReason: event.reason };
        line({ event: "status", objective: event.objective, checks: event.checks, reason: event.reason });
        break;
      case "met":
      case "failed":
        line({
          event: event.type,
          objective: goal?.objective ?? event.objective,
          reason: event.reason ?? null,
          iterations: event.iterations ?? (goal ? (goal.checks ?? 0) + 1 : undefined),
          durationMs: event.durationMs ?? (goal ? at - goal.setAt : undefined),
          tokens: event.tokens,
        });
        session.meta.goal = null;
        break;
      case "cleared":
        // The user's own "/goal clear" says so even when no goal was known (a restart lost it).
        if (!goal && !session.goalClearing) return;
        line({ event: "cleared", objective: goal?.objective ?? event.objective ?? "", byUser: Boolean(session.goalClearing) });
        session.meta.goal = null;
        session.goalClearing = false;
        break;
      case "capped":
        // The goal stays: the next message goes on toward it.
        if (!goal) return;
        line({ event: "capped", objective: goal.objective, checks: event.count });
        break;
      case "none":
        // Asked for its status, or to clear it, the agent has no goal (one known ended unseen).
        line({ event: "none" });
        session.meta.goal = null;
        session.goalClearing = false;
        break;
      default:
        return;
    }
    this.publish(session);
  }
  /** Codex's goal as its adapter reports it (null: there is none any more). */
  codexGoal(session, snapshot) {
    const goal = session.meta.goal ?? null;
    if (!snapshot) return this.applyGoal(session, { type: "cleared" });
    if (!goal || goal.objective !== snapshot.objective) this.applyGoal(session, { type: "set", objective: snapshot.objective, at: snapshot.createdAt });
    const current = session.meta.goal;
    const status = CODEX_STATUSES.has(snapshot.status) ? snapshot.status : "active";
    const stats = { tokensUsed: snapshot.tokensUsed ?? null, timeUsedSeconds: snapshot.timeUsedSeconds ?? null, tokenBudget: snapshot.tokenBudget ?? null };
    if (status === "complete")
      return this.applyGoal(session, {
        type: "met",
        objective: current.objective,
        tokens: stats.tokensUsed ?? undefined,
        durationMs: stats.timeUsedSeconds != null ? stats.timeUsedSeconds * 1000 : undefined,
      });
    if (status !== current.status) this.append(session, { kind: "goal", event: status, objective: current.objective });
    session.meta.goal = { ...current, ...stats, status };
    this.publish(session);
  }
  removeQueued(id, messageId) {
    const session = this.get(id);
    session.meta.queue = session.meta.queue.filter((item) => item.id !== messageId);
    this.publish(session);
    return this.publicMeta(session);
  }
  rename(id, title) {
    const session = this.get(id);
    session.meta.title = String(title || "").slice(0, 80) || session.meta.title;
    this.publish(session);
  }
  /**
   * A work moved to another repository (works.move): its conversations go with it. The next
   * message resumes the agent in the work's new folder with a new FRAME token. `stamps` are
   * the work's file stamps in the old folder and in the new one: files the AI saw unchanged
   * take their new stamp, so a fresh checkout is not reported as every file changed.
   */
  async moveWork({ id, from, to, roots, stamps }) {
    for (const session of this.sessions.values()) {
      if (session.meta.work !== id || session.meta.repo !== from) continue;
      session.meta.repo = to;
      // The agent lets go of the conversation first: Claude writes to it as its session ends.
      const { process } = session;
      if (process && session.attached && process.capabilities.sessionCapabilities?.close)
        await process.connection.closeSession({ sessionId: session.meta.acpSessionId }).catch(() => {});
      process?.sessions.delete(session.meta.id);
      session.process = null;
      session.attached = false;
      if (session.token) this.services.auth.revokeInternal(session.token);
      session.token = null;
      if (session.meta.agent === "claude" && session.meta.acpSessionId)
        try {
          moveClaudeConversation(session.meta.acpSessionId, roots.from, roots.to);
        } catch (error) {
          console.warn("moving a Claude conversation failed:", error.message);
        }
      const files = session.files ?? this.readFiles(session);
      if (files) {
        for (const [file, stamp] of Object.entries(files)) if (stamps.before[file] === stamp && stamps.after[file]) files[file] = stamps.after[file];
        session.files = files;
        writeFileAtomic(path.join(this.sessionsDir, session.meta.id + ".files.json"), JSON.stringify(files));
      }
      this.publish(session);
    }
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
      const air = update._meta?.jetbrains?.air;
      if (air && "goal" in air) this.codexGoal(session, air.goal);
      // Claude marks forked conversations "(fork)"; branches have their own icon instead.
      const title = String(update.title || "")
        .split("[FRAME]")[0]
        .replace(/\s*\(fork\)\s*$/i, "")
        .trim();
      // A command is no title ("/goal" after a goal's status was asked), nor "go on": when
      // Claude cannot make a title it falls back on the first message that is not a command.
      if (title && !title.startsWith("/") && title !== GOAL_CONTINUE) session.meta.title = title.slice(0, 80);
      return this.publish(session);
    }
    if (update.sessionUpdate === "usage_update") {
      if (update.cost) this.noteCost(session, update.cost);
      session.meta.usage = update;
      return this.publish(session);
    }
    if (session.goalReader) this.readGoal(session);
    // What Claude prints for a goal command is shown as the goal's own line, not as a reply.
    // Its message id is none or a UUID; the model's words come in messages "msg_…".
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      !/^msg_/.test(update.messageId ?? "") &&
      update.content?.type === "text" &&
      session.meta.agent === "claude"
    ) {
      const output = goalOutput(update.content.text.trim());
      if (output) return this.applyGoal(session, output);
    }
    // Claude's own notices (a warning; why a hook ended the turn) come as text marked
    // "informational": a line of their own, not words run on into the reply.
    if (update.sessionUpdate === "agent_message_chunk" && update._meta?.claudeCode?.kind === "informational" && update.content?.type === "text") {
      const text = update.content.text.replace(/^\*\*[A-Z][a-z]+:\*\*\s*/, "").trim();
      const capped = hookCap(text);
      // The goal's checks kept the AI going until Claude's limit: told with the goal's lines,
      // after the last check (still on its way from Claude's file).
      if (capped && session.meta.goal) session.goalCapped = capped;
      else if (text) this.append(session, { kind: "notice", message: text });
      return;
    }
    // Both agents report a compaction (manual or automatic) as a "Compact conversation" tool call.
    if (update.sessionUpdate === "tool_call" && update.title === "Compact conversation") session.compacting = update.toolCallId;
    if (update.toolCallId && update.toolCallId === session.compacting && update.status === "completed") {
      session.compacting = null;
      // The summary keeps the gist, not documents read along the way: assume only the brief.
      session.meta.context = { ...session.meta.context, experience: session.briefSeen ?? {} };
      this.saveMeta(session);
    }
    this.append(session, { kind: "update", update: unwrapToolResult(withoutAgentCopy(update)) });
  }
  /**
   * Claude reports what its session has cost so far, and a resumed session goes on from the
   * total Claude saved for it as its process ended: a turn costs what the total grew by while
   * it ran. Unknown (null) when there is no earlier total or it went down (it was not saved).
   */
  noteCost(session, cost) {
    const amount = Number(cost.amount);
    if (!Number.isFinite(amount)) return;
    const before = session.meta.spent;
    session.meta.spent = amount;
    if (session.meta.status === "idle" || session.turnCost === null) return;
    session.turnCost =
      typeof before === "number" && amount >= before ? { amount: (session.turnCost?.amount ?? 0) + amount - before, currency: cost.currency || "USD" } : null;
  }
  /**
   * Whether Claude's cost is right: it knows Anthropic's prices, and prices another vendor's
   * model behind an Anthropic-compatible endpoint as its own default model.
   */
  pricedByClaude(session) {
    const profile = this.profiles.list().find((item) => item.id === session.meta.profile);
    return profile?.kind === "account" || (profile?.kind === "anthropic" && !profile.baseUrl);
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
      if (view.sample)
        lines.push(
          `用户正在看样片 ${view.sample.path}（单独播放，不在时间轴上），样片里的 ${formatTime(view.sample.time ?? 0)}${view.sample.playing ? "（播放中）" : ""}`,
        );
    }
    if (!steering) {
      const files = snapshotFiles(work.dir);
      const changedFiles = filesNotice(session.files, files);
      session.files = files;
      if (changedFiles) lines.push(changedFiles);
    }
    const references = [];
    for (const attachment of message.attachments) {
      if (attachment.type === "frame")
        references.push(
          attachment.scene
            ? `样片 ${attachment.scene} 在它自己的 ${formatTime(attachment.time)} 的画面（截图见附图，不是成片的时间）`
            : `画面 ${formatTime(attachment.time)}（截图见附图）`,
        );
      if (attachment.type === "range") references.push(`片段 ${formatTime(attachment.start)}–${formatTime(attachment.end)}`);
      if (attachment.type === "layer") references.push(`图层 ${attachment.id}${attachment.name ? "「" + attachment.name + "」" : ""}`);
      if (attachment.type === "asset") references.push(`素材 ${attachment.url}`);
      if (attachment.type === "file") references.push(`文件 ${attachment.path}`);
      if (attachment.type === "experience") references.push(`经验库${attachment.library ? `「${attachment.library}」` : ""}的文档 ${attachment.path}`);
      if (attachment.type === "resource")
        references.push(`素材库资源 ${attachment.id}${attachment.title ? `「${attachment.title}」` : ""}（resource_view 看详情和预览图）`);
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

  /** The AI wrote to an experience library: saved as a version of that library when the turn ends. */
  noteExperienceWrite(sessionId, { repo, library, files, note }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.experienceWrites ??= new Map();
    const key = `${repo}/${library}`;
    const entry = session.experienceWrites.get(key) ?? { repo, library, files: new Set(), notes: [] };
    for (const file of files) entry.files.add(file);
    if (note) entry.notes.push(note);
    session.experienceWrites.set(key, entry);
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

  /**
   * The studio is shutting down (an update replaces it): turns still running are cut off. They
   * are marked, and go on by themselves after the restart (resumeInterrupted). A crash marks
   * nothing, so a turn that brings the studio down is not sent again and again.
   */
  close() {
    this.closing = true;
    clearInterval(this.timer);
    clearInterval(this.pulse);
    for (const session of this.sessions.values()) {
      if (session.meta.status === "idle") continue;
      session.meta.interrupted = Date.now();
      this.append(session, { kind: "notice", message: "FRAME 正在更新重启，这一轮被打断了；重启后 AI 会自动接着做" });
      this.saveMeta(session);
    }
    for (const entry of this.processes.values()) entry.process.kill();
    this.processes.clear();
  }
  /** After a restart: the conversations whose turn the shutdown cut off go on, once. */
  resumeInterrupted() {
    for (const session of this.sessions.values()) {
      const at = session.meta.interrupted;
      if (!at) continue;
      delete session.meta.interrupted;
      this.saveMeta(session);
      if (Date.now() - at > RESUME_WITHIN_MS) continue;
      this.prompt(session.meta.id, { text: RESUME_TEXT }).catch((error) => console.warn(`resuming conversation ${session.meta.id} failed:`, error.message));
    }
  }
}

const isModel = (options, id) => options.some((option) => option.id === id && (option.category === "model" || option.id === "model"));

/** Attachments as stored in the transcript: image data becomes an image entry (saved to a file by storeImages). */
/**
 * "/compact", "/review …": a command the agent offers. Both offer compact and goal, also before
 * a new conversation's list of commands has arrived (a goal is often its first message).
 */
function isCommand(session, text) {
  const name = /^\/([a-z][\w-]*)(\s|$)/i.exec(text.trim())?.[1];
  return Boolean(name) && (name === "compact" || name === "goal" || Boolean(session.meta.commands?.some((command) => command.name === name)));
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

/**
 * Claude Code repeats each tool result in `_meta.claudeCode` (with whole files, base64 images
 * and file contents before an edit); the transcript only shows `content`, so it is not stored.
 */
export function withoutAgentCopy(update) {
  if (!update._meta?.claudeCode) return update;
  const { claudeCode: _copy, ...meta } = update._meta;
  return { ...update, _meta: Object.keys(meta).length ? meta : undefined };
}

/**
 * Codex hands over the result of an MCP tool as one text: the JSON of the whole result, with
 * its pictures as base64 (about a megabyte per preview_frames call). Unwrapped, the pictures
 * are stored as files like other tool pictures, and the chat shows them.
 */
export function unwrapToolResult(update) {
  const content = update?.rawOutput?.result?.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") return update;
  const text = content[0].text;
  if (typeof text !== "string" || !text.startsWith('{"content":[')) return update;
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return update;
  }
  if (!Array.isArray(result?.content) || !result.content.every((item) => typeof item?.type === "string")) return update;
  return { ...update, rawOutput: { ...update.rawOutput, result: { content: result.content, ...(result.isError ? { isError: true } : {}) } } };
}

/** A stored transcript line; null for one that cannot be read (cut short by a crash). */
function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** How much of each text of a tool call the chat gets with the conversation. */
const SHORT_TEXT = 4000;

/**
 * An entry as the chat gets it: the long texts of a tool call (command output, file
 * contents, results) cut to SHORT_TEXT characters, and the entry marked `cut`. The chat
 * shows a tool's output only when its card is opened, and then asks for the whole call.
 */
export function lean(entry) {
  if (entry?.kind !== "update" || !["tool_call", "tool_call_update"].includes(entry.update?.sessionUpdate)) return entry;
  let cut = false;
  const shorten = (value) => {
    if (typeof value === "string") {
      if (value.length <= SHORT_TEXT) return value;
      cut = true;
      return value.slice(0, SHORT_TEXT);
    }
    if (Array.isArray(value)) return value.map(shorten);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shorten(item)]));
    return value;
  };
  const update = shorten(entry.update);
  return cut ? { ...entry, update, cut: true } : entry;
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
