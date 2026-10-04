import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { AiClient } from "./ai-client.mjs";
import { aiControl } from "./ai-control.mjs";
import { problem } from "./security.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";
import { creatorPrompt } from "./creator-workspace.mjs";
import { command } from "./process.mjs";
import { prepareAiRuntime } from "./ai-work.mjs";

const active = thread => ["starting", "running"].includes(thread.session?.status) || !!thread.session?.activeTurnId ||
  !!thread.hasPendingApprovals || !!thread.hasPendingUserInput || !!thread.backgroundLiveness;
const samePath = (a, b) => typeof a === "string" && typeof b === "string" && path.resolve(a) === path.resolve(b);
const terminalBusy = terminal => terminal.status === "starting" || terminal.status === "running" && terminal.hasRunningSubprocess;

function nativeActivityIndex(snapshot) {
  const projects = new Map(), threads = new Map(), orphanCwds = new Set(), busyCwds = new Map();
  for (const thread of snapshot?.threads || []) {
    threads.set(thread.id, thread);
    const group = projects.get(thread.projectId) || { threads: [], terminals: [] };
    group.threads.push(thread); projects.set(thread.projectId, group);
  }
  for (const terminal of snapshot?.terminals || []) {
    const thread = threads.get(terminal.threadId);
    if (terminalBusy(terminal) && typeof terminal.cwd === "string") {
      const cwd = path.resolve(terminal.cwd), owners = busyCwds.get(cwd) || new Set();
      owners.add(thread?.projectId); busyCwds.set(cwd, owners);
    }
    if (thread) projects.get(thread.projectId).terminals.push(terminal);
    else if (typeof terminal.cwd === "string") orphanCwds.add(path.resolve(terminal.cwd));
  }
  return { projects, orphanCwds, busyCwds };
}
export function nativeWorkSummary(binding, snapshot, index = nativeActivityIndex(snapshot)) {
  if (!binding.projectId) return { state: binding.state, activeThreads: [], activeTerminals: 0, pendingPermissions: 0, incomplete: false };
  if (!snapshot) return { state: "failed", activeThreads: [], activeTerminals: 0, pendingPermissions: 0, incomplete: true };
  const { threads = [], terminals = [] } = index.projects.get(binding.projectId) || {};
  const physicalOwners = binding.cwd && index.busyCwds.get(path.resolve(binding.cwd));
  const uncertain = threads.some(thread => thread.worktreePath && !samePath(thread.worktreePath, binding.cwd)) ||
    terminals.some(terminal => !samePath(terminal.cwd, binding.cwd) || terminal.worktreePath && !samePath(terminal.worktreePath, binding.cwd)) ||
    !!binding.cwd && index.orphanCwds.has(path.resolve(binding.cwd)) ||
    !!physicalOwners && (physicalOwners.size > 1 || !physicalOwners.has(binding.projectId));
  return { state: "ready", activeThreads: threads.filter(active).map(thread => thread.id),
    activeTerminals: terminals.filter(terminalBusy).length,
    pendingPermissions: threads.filter(thread => thread.hasPendingApprovals || thread.hasPendingUserInput).length,
    incomplete: snapshot.terminalsReady !== true || uncertain };
}

/** A shared T3 environment owns native execution; this manager owns only FRAME work bindings. */
export class AiManager extends EventEmitter {
  constructor({ db, data, store, workService, tasks, client, localMode = process.env.FRAME_LOCAL_MODE === "1", runCommand = command }) {
    super();
    Object.assign(this, { db, data, store, workService, tasks, localMode, runCommand });
    this.client = client || new AiClient({ data }); this.container = process.env.FRAME_T3_CONTAINER || "frame-t3";
    this.ensuring = new Map(); this.runtimePrepared = new Map(); this.threadActivity = new Map(); this.terminalActivity = new Map(); this.closed = false; this.ticking = null;
    this.workActivity = new Map(); this.activityProjects = new Set(); this.activityCwds = new Set(); this.activityAll = false;
    this.nativeReady = this.client.terminalsReady === true;
    this.client.on?.("change", event => this.nativeChange(event));
    this.client.on?.("terminal", event => this.nativeTerminal(event));
    this.client.on?.("disconnect", () => {
      if (!this.nativeReady) return;
      this.nativeReady = false; this.queueActivity({ all: true });
    });
  }
  nativeThread(thread, id = thread?.id) {
    const previous = this.threadActivity.get(id);
    const value = thread && { projectId: thread.projectId, signature: JSON.stringify([thread.projectId,
      thread.worktreePath || null, active(thread), !!(thread.hasPendingApprovals || thread.hasPendingUserInput)]) };
    if (previous?.signature === value?.signature) return false;
    if (value) this.threadActivity.set(id, value); else this.threadActivity.delete(id);
    this.queueActivity({ projects: [previous?.projectId, value?.projectId] });
    return true;
  }
  nativeChange(event) {
    if (event.kind === "snapshot") {
      const threads = new Map(event.snapshot.threads.map(thread => [thread.id, thread]));
      for (const id of new Set([...this.threadActivity.keys(), ...threads.keys()])) this.nativeThread(threads.get(id), id);
      this.queueActivity({ all: true });
    } else if (["thread-upserted", "thread-removed"].includes(event.kind)) {
      const id = event.thread?.id || event.threadId;
      if (this.nativeThread(event.thread, id)) {
        // Removing/moving a thread can leave terminals at another work's cwd.
        // Only semantic transitions inspect this cache; streamed text skips it.
        const cwds = [];
        for (const terminal of this.client.terminals?.values() || []) if (terminal.threadId === id) cwds.push(terminal.cwd);
        this.queueActivity({ cwds });
      }
    }
  }
  nativeTerminal(event) {
    const ready = this.client.terminalsReady === true;
    if (ready !== this.nativeReady) { this.nativeReady = ready; this.queueActivity({ all: true }); }
    const terminals = event.type === "snapshot" ? event.terminals : event.type === "upsert" ? [event.terminal] : [];
    const current = new Map(terminals.map(terminal => [JSON.stringify([terminal.threadId, terminal.terminalId]), terminal]));
    const keys = event.type === "snapshot" ? new Set([...this.terminalActivity.keys(), ...current.keys()]) :
      event.type === "remove" ? [JSON.stringify([event.threadId, event.terminalId])] : current.keys();
    for (const key of keys) {
      const terminal = current.get(key), previous = this.terminalActivity.get(key);
      const projectId = this.client.threads?.get(terminal?.threadId || previous?.threadId)?.projectId;
      const value = terminal && { threadId: terminal.threadId, projectId, cwd: terminal.cwd,
        signature: JSON.stringify([projectId, terminal.threadId, terminal.cwd, terminal.worktreePath || null, terminalBusy(terminal)]) };
      if (previous?.signature === value?.signature) continue;
      if (value) this.terminalActivity.set(key, value); else this.terminalActivity.delete(key);
      this.queueActivity({ projects: [previous?.projectId, value?.projectId, projectId], cwds: [previous?.cwd, value?.cwd] });
    }
  }
  queueActivity({ all = false, projects = [], cwds = [] } = {}) {
    if (this.closed) return;
    this.activityAll ||= all;
    for (const project of projects) if (project) this.activityProjects.add(project);
    for (const cwd of cwds) if (typeof cwd === "string") this.activityCwds.add(path.resolve(cwd));
    if (this.activityTimer || this.activityFlush) return;
    this.activityTimer = setImmediate(() => {
      this.activityTimer = null;
      void this.flushActivity().catch(error => this.onActivityError?.(error));
    });
  }
  async flushActivity() {
    if (this.activityFlush) return this.activityFlush;
    if (this.closed || !this.activityAll && !this.activityProjects.size && !this.activityCwds.size) return;
    clearImmediate(this.activityTimer); this.activityTimer = null;
    const all = this.activityAll, projects = this.activityProjects, cwds = this.activityCwds;
    this.activityAll = false; this.activityProjects = new Set(); this.activityCwds = new Set();
    const operation = (async () => {
      // Native text/usage chunks never reach this query. Snapshots and state
      // transitions share one requested-work lookup for the whole event batch.
      const bindings = await this.store.listWorks({ requested: true, limit: 10000 });
      if (this.closed) return;
      const snapshot = this.client.snapshot?.(), index = nativeActivityIndex(snapshot);
      const retained = new Set(bindings.map(binding => binding.workId));
      for (const id of this.workActivity.keys()) if (!retained.has(id)) this.workActivity.delete(id);
      for (const binding of bindings) {
        if (!all && !projects.has(binding.projectId) && !cwds.has(path.resolve(binding.cwd || "."))) continue;
        const summary = nativeWorkSummary(binding, snapshot, index);
        const signature = JSON.stringify([binding.projectId, binding.cwd, summary.state, [...summary.activeThreads].sort(),
          summary.activeTerminals, summary.pendingPermissions, summary.incomplete]);
        if (this.workActivity.get(binding.workId) === signature) continue;
        this.workActivity.set(binding.workId, signature);
        this.emit("activity", { table: "ai_native_activity", work: binding.workId, repo: binding.repo, project: binding.project });
        const busy = summary.incomplete || summary.activeThreads.length || summary.pendingPermissions || summary.activeTerminals;
        void Promise.resolve(this.onNativeEvent?.(binding.workId, { type: busy ? "thread.running" : "thread.ended" }))
          .catch(error => this.onActivityError?.(error));
      }
    })();
    this.activityFlush = operation;
    try { await operation; } finally {
      this.activityFlush = null;
      if (!this.closed && (this.activityAll || this.activityProjects.size || this.activityCwds.size)) this.queueActivity();
    }
  }
  async activitySnapshot() {
    if (this.client.ready && this.client.snapshot) {
      if (!this.client.terminalsReady) void this.client.connect().catch(() => {});
      return this.client.snapshot();
    }
    return this.client.shell();
  }
  control() { return aiControl(this.data); }
  async authorizeInternal(supplied) {
    if (typeof supplied !== "string" || supplied.length > 128) return false;
    const { secret } = await this.control();
    return supplied.length === secret.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(secret));
  }
  async threadCredential(workId, threadId) {
    const { secret } = await this.control();
    const signature = createHmac("sha256", secret).update("frame-thread:" + workId + ":" + threadId).digest("base64url");
    return workId + "." + Buffer.from(threadId).toString("base64url") + "." + signature;
  }
  async threadContext(credential) {
    const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/.exec(credential || "");
    if (!match) return null;
    const threadId = Buffer.from(match[2], "base64url").toString("utf8"), expected = await this.threadCredential(match[1], threadId);
    if (expected.length !== credential.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(credential))) return null;
    const work = await this.workService.works.get(match[1], { active: true });
    const thread = await this.thread(work.id, threadId);
    if (!thread || !active(thread)) return null;
    const prepared = await this.workService.prepare(work.id);
    return { id: work.id, repo: work.repo, project: work.project, kind: "ai", state: "running", input: {},
      aiWork: work.id, aiThread: thread.id, runRoot: prepared.workspace.workspaceRoot };
  }
  async ensure(work) {
    if (this.closed || this.tasks?.desktopClosing) throw problem(409, "工作台正在关闭，请重新打开后创作");
    const workId = typeof work === "string" ? work : work.id;
    if (this.ensuring.has(workId)) return this.ensuring.get(workId);
    const operation = this.db.lock("ai-project:" + workId, () => this.ensureOwned(workId));
    this.ensuring.set(workId, operation);
    try { return await operation; } finally { this.ensuring.delete(workId); }
  }
  async ensureOwned(workId) {
    const prepared = await this.workService.prepare(workId), cwd = prepared.workspace.workspaceRoot;
    if (await fs.realpath(cwd) !== cwd) throw problem(409, "作品工作目录已发生变化");
    const runtime = await runtimeIdentity();
    if (this.runtimePrepared.get(cwd) !== runtime.fingerprint) {
      await prepareAiRuntime({ db: this.db, workspaceRoot: cwd, repo: prepared.work.repo, runCommand: this.runCommand });
      this.runtimePrepared.set(cwd, runtime.fingerprint);
    }
    await this.control();
    const shell = await this.client.shell();
    const existing = shell.projects.find(project => samePath(project.workspaceRoot, cwd));
    const projectId = prepared.binding.projectId || existing?.id || workId;
    if (existing && existing.id !== projectId || prepared.binding.cwd && !samePath(prepared.binding.cwd, cwd))
      throw problem(409, "原生项目绑定发生变化，请检查当前作品目录");
    if (!existing) {
      if (shell.projects.some(project => project.id === projectId)) throw problem(409, "原生项目 ID 已用于其他目录");
      const project = { id: projectId, title: prepared.work.title, workspaceRoot: cwd, createdAt: new Date().toISOString() };
      await this.client.dispatch({ type: "project.create", commandId: randomUUID(), projectId, title: project.title,
        workspaceRoot: cwd, createdAt: project.createdAt });
      this.client.projects?.set(projectId, project);
    }
    const config = await this.client.config(), environmentId = config.environment.environmentId;
    if (!prepared.binding.requested) await this.store.requestWork(workId);
    const binding = await this.store.updateRuntime(workId, { state: "ready", projectId, environmentId, cwd,
      runtimeFingerprint: runtime.fingerprint, error: null });
    return { ...prepared.workspace, projectId, environmentId, cwd, runtimeFingerprint: binding.runtimeFingerprint, state: "ready" };
  }
  async thread(workId, threadId, { nativeProjectId, cwd, allowDraft = false } = {}) {
    z.string().min(1).max(256).parse(threadId);
    const prepared = await this.workService.prepare(workId), binding = await this.store.getWork(workId);
    if (!binding?.projectId) throw problem(409, "作品原生项目尚未准备完成");
    if (nativeProjectId !== undefined && nativeProjectId !== binding.projectId || cwd !== undefined && !samePath(cwd, prepared.workspace.workspaceRoot))
      throw problem(403, "聊天所属原生项目或目录与当前作品不符");
    const { projects, threads } = await this.client.shell(), thread = threads.find(value => value.id === threadId);
    const project = projects.find(value => value.id === binding.projectId);
    if (!project || !samePath(project.workspaceRoot, prepared.workspace.workspaceRoot)) throw problem(403, "原生项目目录已改变");
    if (!thread) return allowDraft ? { id: threadId, projectId: binding.projectId, worktreePath: null } : null;
    if (thread.projectId !== binding.projectId || thread.worktreePath && !samePath(thread.worktreePath, prepared.workspace.workspaceRoot))
      throw problem(403, "原生聊天不属于当前作品的唯一工作区");
    return thread;
  }
  async nativeContext({ threadId, nativeProjectId, cwd }) {
    z.string().min(1).max(4096).parse(cwd); z.string().min(1).max(256).parse(threadId);
    const root = path.resolve(cwd), binding = await this.db.one("SELECT work_id FROM ai_work_bindings WHERE cwd=$1", [root]);
    if (!binding) return null;
    const work = await this.workService.works.get(binding.work_id, { active: true });
    const thread = await this.thread(work.id, threadId, { nativeProjectId, cwd });
    if (!thread) throw problem(403, "FRAME 原生聊天身份不存在");
    return { version: 1, workId: work.id, project: work.project, instructions: creatorPrompt(work.project), env: {
      FRAME_PROJECT: work.project, FRAME_WORK_ID: work.id, FRAME_THREAD_ID: thread.id,
      FRAME_AGENT_URL: process.env.FRAME_CALLBACK_URL || (this.localMode ? process.env.FRAME_PUBLIC_URL || process.env.FRAME_ORIGIN || "http://127.0.0.1:3000" : "http://frame-web:3000"),
      FRAME_AGENT_TOKEN: await this.threadCredential(work.id, thread.id),
      FRAME_REFERENCE_ROOT: path.join(this.data, "ai", work.id, "references"),
      FRAME_SHARED_RUNTIME_ROOT: process.env.FRAME_SHARED_RUNTIME_ROOT || (this.localMode ? path.resolve(".") : "/opt/frame"),
    } };
  }
  async observe(workId) {
    const binding = await this.store.getWork(workId);
    if (!binding?.projectId) return { state: binding?.state || "cold", activeThreads: [], incomplete: false };
    try {
      return { ...nativeWorkSummary(binding, await this.activitySnapshot()), checkedAt: new Date().toISOString() };
    } catch { return { state: "failed", activeThreads: [], incomplete: true }; }
  }
  async active({ repo, project } = {}) {
    const rows = await this.store.listWorks({ requested: true, limit: 10000 });
    const scoped = rows.filter(row => (!repo || row.repo === repo) && (!project || row.project === project));
    if (!scoped.length) return [];
    let snapshot;
    try { snapshot = await this.activitySnapshot(); } catch {}
    const result = [], index = nativeActivityIndex(snapshot);
    for (const binding of scoped) {
      const summary = nativeWorkSummary(binding, snapshot, index);
      if (summary.incomplete || summary.activeThreads.length || summary.pendingPermissions || summary.activeTerminals)
        result.push({ id: binding.workId, workId: binding.workId, repo: binding.repo, project: binding.project, kind: "ai",
          state: summary.incomplete ? "blocked" : "running", native: summary, nativeExecution: true });
    }
    return result;
  }
  async tick() {
    if (this.closed || this.ticking) return this.ticking;
    const operation = (async () => {
      for (const binding of await this.store.listWorks({ requested: true, limit: 10000 })) {
        const work = await this.db.one("SELECT id,deleted FROM works WHERE id=$1", [binding.workId]);
        if (!work || work.deleted) { await this.onStopped?.(binding.workId); await this.store.updateRuntime(binding.workId, { requested: false, state: "stopped" }); continue; }
        try { await this.onReconcile?.(binding.workId); }
        catch (error) { await this.store.updateRuntime(binding.workId, { state: "failed", error: "原生服务暂不可用" }); }
      }
    })(); this.ticking = operation;
    try { await operation; } finally { this.ticking = null; }
  }
  async cancelWork(workId) {
    const binding = await this.store.getWork(workId); if (!binding?.projectId) return { stopped: 0 };
    const { threads, terminals = [], terminalsReady } = await this.client.shell();
    if (!terminalsReady) throw problem(503, "原生终端状态尚未同步，请重试停止作品");
    const own = threads.filter(thread => thread.projectId === binding.projectId && active(thread));
    for (const thread of own) {
      await this.thread(workId, thread.id);
      await this.client.dispatch({ type: "thread.turn.interrupt", commandId: randomUUID(), threadId: thread.id, createdAt: new Date().toISOString() });
    }
    const threadIds = new Set(threads.filter(thread => thread.projectId === binding.projectId).map(thread => thread.id));
    const ownTerminals = terminals.filter(terminal => threadIds.has(terminal.threadId) && ["starting", "running"].includes(terminal.status));
    for (const terminal of ownTerminals) await this.client.rpc("terminal.close", { threadId: terminal.threadId, terminalId: terminal.terminalId });
    await this.onStopped?.(workId);
    return { stopped: own.length + ownTerminals.length };
  }
  async cancelValidation(workId, reportId) {
    z.uuid().parse(reportId); if (this.localMode) return;
    await this.tasks.assertLeadership();
    const binding = await this.store.getWork(workId); if (!binding?.cwd) return;
    const script = `const fs=require('node:fs'),path=require('node:path');(async()=>{
      const [cwd,project,id]=process.argv.slice(1),file=path.join(cwd,'projects',project,'.cache/validation',id+'.json');
      let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code==='ENOENT')return;throw e}
      if(value.reportId!==id||!Number.isSafeInteger(value.pid)||value.pid<2)throw Error('Validation process identity changed');
      const current=()=>{let cmd;try{cmd=fs.readFileSync('/proc/'+value.pid+'/cmdline','utf8')}catch(e){if(e.code==='ENOENT')return false;throw e}
        if(!cmd)return false;if(!cmd.includes('/opt/frame/server/ai-validate.mjs')||!cmd.includes('"reportId":"'+id+'"'))throw Error('Validation process identity changed');return true;};
      if(current()){process.kill(value.pid,'SIGTERM');const until=Date.now()+5000;
        while(current()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));if(current())process.kill(value.pid,'SIGKILL');}
      fs.rmSync(file,{force:true});})().catch(e=>{console.error(e.message);process.exitCode=1});`;
    await this.runCommand("docker", ["exec", this.container, "node", "-e", script, binding.cwd, binding.project, reportId], { timeout: 15000, max: 65536 });
  }
  beginClose() { this.closed = true; clearImmediate(this.activityTimer); this.activityTimer = null; }
  async close() { this.beginClose(); this.client.close(); await Promise.allSettled([...this.ensuring.values(), this.activityFlush]); this.removeAllListeners(); }
}
