import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, timingSafeEqual, createHmac } from "node:crypto";
import { command } from "./process.mjs";
import { executionRuntime } from "./execution-runtime.mjs";
import { confinedAsync, exists } from "./project-files.mjs";
import { hash, token, problem } from "./security.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";
import { linkSharedRuntime, sharedRuntimeNames } from "../scripts/shared-runtime.mjs";
import { publicText } from "./public-data.mjs";
import { paseoCallbackUrl, paseoDaemonOptions, paseoUnavailable, inspectPaseoContainer } from "./paseo-runtime-options.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const activeStates = new Set(["running", "initializing"]);
const startupConcurrency = 2;
const repositoryBusy = error => error?.statusCode === 409 && error.message === "Repository is busy";
const terminalBusy = terminal => !terminal.activity || terminal.activity.state === "working" ||
  terminal.activity.attentionReason === "needs_input" ||
  terminal.activity.state === "attention" && terminal.activity.attentionReason !== "finished";

// Native sessions receive system/runtime settings; FRAME service credentials stay in the API process.
export function paseoProcessEnvironment(parent = process.env) {
  const names = new Set(["PATH", "Path", "LANG", "LANGUAGE", "TZ", "USER", "LOGNAME",
    "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
    "APPDATA", "LOCALAPPDATA", "USERPROFILE", "PROGRAMFILES", "ProgramFiles",
    "ProgramFiles(x86)", "ProgramW6432", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]);
  return Object.fromEntries(Object.entries(parent).filter(([name, value]) =>
    typeof value === "string" && (names.has(name) || /^LC_[A-Z_]+$/.test(name))));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nativeRoot = () => path.resolve(process.env.FRAME_PASEO_ROOT || path.join(root, ".cache/paseo-runtime"));
const uuid = value => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || ""))
    throw problem(400, "Invalid work identity");
  return value;
};

export async function atomicPaseoJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomUUID() + ".tmp";
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
}

/** The controller owns processes; API callers only request their work's stable daemon. */
export class PaseoManager {
  constructor({ db, data, store, workService, tasks, connections, localMode = process.env.FRAME_LOCAL_MODE === "1",
    clientFactory, runCommand = command, idleMs = 20 * 60 * 1000, startTimeoutMs = 90000 } = {}) {
    Object.assign(this, { db, data, store, workService, tasks, connections, localMode, clientFactory, runCommand, idleMs, startTimeoutMs });
    this.clients = new Map(); this.connecting = new Map(); this.profileRevisions = new Map(); this.profileSyncs = new Map(); this.clientScope = "frame-" + (process.env.FRAME_ROLE || "local") + "-" + randomUUID(); this.starting = new Map(); this.runningStarts = 0; this.startWaiters = []; this.speechRequests = new Map(); this.children = new Map(); this.ensuring = new Map(); this.observing = new Map(); this.runtimePreparations = new Map(); this.closed = false;
  }
  async controlPath(workId) {
    return confinedAsync(this.data, "paseo/" + uuid(workId) + "/control.json");
  }
  async control(workId, { create = false } = {}) {
    const file = await this.controlPath(workId);
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (value.version !== 1 || value.workId !== workId || !/^[a-zA-Z0-9_-]{32,128}$/.test(value.capability))
        throw problem(409, "Paseo control identity changed");
      return value;
    } catch (error) {
      if (error.code !== "ENOENT" || !create) throw error;
      const value = { version: 1, workId, capability: token() };
      await atomicPaseoJson(file, value);
      return value;
    }
  }
  async authorize(workId, supplied) {
    if (typeof supplied !== "string" || supplied.length > 128) return false;
    const value = await this.control(workId).catch(() => null);
    if (!value) return false;
    const a = Buffer.from(hash(value.capability)), b = Buffer.from(hash(supplied));
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async agentCredential(workId, agentId) {
    const { capability } = await this.control(workId);
    const encoded = Buffer.from(agentId).toString("base64url");
    const signature = createHmac("sha256", capability).update("frame-agent:" + workId + ":" + agentId).digest("base64url");
    return workId + "." + encoded + "." + signature;
  }
  async resolveAgentWorkspace(workId, cwd) {
    const prepared = await this.workService.resolve(workId) || await this.workService.prepare(workId);
    const workspace = prepared.workspace;
    const nativeRoot = this.localMode ? workspace.workspaceRoot : "/workspace";
    const normalized = path.resolve(cwd);
    if (normalized !== nativeRoot && !normalized.startsWith(nativeRoot + path.sep))
      throw problem(403, "所有对话必须使用当前作品的唯一工作区；保留的历史工作树仅可恢复源码");
    const hostCwd = normalized === nativeRoot ? workspace.workspaceRoot :
      await confinedAsync(workspace.workspaceRoot, path.relative(nativeRoot, normalized).replaceAll("\\", "/"));
    if (await fs.realpath(hostCwd) !== hostCwd) throw problem(403, "Native workspace path changed");
    return { hostCwd, checkoutRoot: workspace.workspaceRoot, nativeCheckout: nativeRoot, prepared };
  }
  async agentContext(credential) {
    const match = /^([0-9a-f-]{36})\.([a-zA-Z0-9_-]{1,1024})\.([a-zA-Z0-9_-]{43})$/.exec(credential || "");
    if (!match) return null;
    const agentId = Buffer.from(match[2], "base64url").toString("utf8");
    const expected = await this.agentCredential(match[1], agentId).catch(() => null);
    if (!expected || expected.length !== credential.length ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(credential))) return null;
    const work = await this.workService.works.get(match[1], { active: true });
    const agent = await this.agent(work.id, agentId);
    if (!agent || !activeStates.has(agent.status)) return null;
    const workspace = await this.resolveAgentWorkspace(work.id, agent.cwd);
    return { id: work.id, repo: work.repo, project: work.project, kind: "paseo",
      state: "running", input: {}, paseoWork: work.id, paseoAgent: agent.id, runRoot: workspace.checkoutRoot };
  }
  async ensure(work) {
    if (this.tasks.desktopClosing) throw problem(409, "工作台正在退出，请重新打开后再开始创作。");
    const workId = typeof work === "string" ? work : work.id;
    if (this.ensuring.has(workId)) return this.ensuring.get(workId);
    const operation = this.ensureOwned(workId);
    this.ensuring.set(workId, operation);
    try { return await operation; }
    finally { if (this.ensuring.get(workId) === operation) this.ensuring.delete(workId); }
  }
  async ensureOwned(workId) {
    const existing = await this.store.getWork(workId);
    const prepared = await this.workService.resolve(workId, { binding: existing }) || await this.workService.prepare(workId);
    await this.store.requestWork(workId);
    if (this.localMode && existing?.state !== "ready") await this.start(workId);
    const deadline = Date.now() + this.startTimeoutMs;
    while (!this.closed && Date.now() < deadline) {
      const binding = await this.store.getWork(workId);
      if (binding?.state === "ready" && binding.workspaceId && binding.serverId) {
        await this.syncProfiles(workId, binding);
        return { generation: binding.daemonGeneration, workspaceId: binding.workspaceId, serverId: binding.serverId,
          workspaceRoot: prepared.workspace.workspaceRoot, projectRoot: prepared.workspace.projectRoot,
          runtimeRoot: root, runtimeFingerprint: binding.runtimeFingerprint, state: "ready" };
      }
      if (binding?.state === "failed") throw paseoUnavailable("failed", binding.error);
      await sleep(200);
    }
    throw paseoUnavailable("waiting");
  }
  async client(workId, binding = null) {
    if (this.connecting.has(workId)) return this.connecting.get(workId);
    const operation = this.connectClient(workId, binding);
    this.connecting.set(workId, operation);
    try { return await operation; }
    finally { if (this.connecting.get(workId) === operation) this.connecting.delete(workId); }
  }
  async connectClient(workId, binding = null) {
    binding ||= await this.store.getWork(workId);
    if (!binding?.endpoint) throw problem(503, "Paseo daemon is not connected");
    const old = this.clients.get(workId);
    const identity = binding.daemonGeneration + ":" + binding.endpoint;
    if (old?.identity === identity) return old.client;
    await old?.client.close().catch(() => {});
    const { capability } = await this.control(workId);
    let client;
    if (this.clientFactory) client = await this.clientFactory({ workId, binding, password: capability });
    else {
      const { DaemonClient } = await import(pathToFileURL(path.join(nativeRoot(), "node_modules/@getpaseo/client/dist/daemon-client.js")).href);
      const { default: WebSocket } = await import("ws");
      client = new DaemonClient({ url: binding.endpoint.replace(/^http/, "ws") + "/ws",
        clientId: this.clientScope + "-" + workId, clientType: "cli", password: capability,
        connectTimeoutMs: 10000, reconnect: { enabled: false },
        webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }),
      });
    }
    try { await client.connect(); }
    catch (error) { await client.close().catch(() => {}); throw error; }
    this.clients.set(workId, { identity, client });
    return client;
  }
  async agent(workId, agentId) {
    const client = await this.client(workId);
    const result = await client.fetchAgent({ agentId, timeout: 10000 });
    return result?.agent || null;
  }
  async observe(workId, { refresh = false } = {}) {
    const binding = await this.store.getWork(workId);
    if (!binding) return { state: "cold", activeAgents: [], pendingPermissions: 0, activeTerminals: 0 };
    if (!refresh && binding.lastObserved && Date.now() - new Date(binding.lastObserved).getTime() < 3000)
      return { state: binding.state, ...binding.nativeSummary };
    if (binding.state !== "ready") return { state: binding.state, activeAgents: [], pendingPermissions: 0, activeTerminals: 0,
      incomplete: !!binding.container,
      ...(binding.error ? { error: binding.error } : {}) };
    const identity = workId + ":" + binding.daemonGeneration;
    if (this.observing.has(identity)) return this.observing.get(identity);
    const operation = this.observeBinding(workId, binding);
    this.observing.set(identity, operation);
    try { return await operation; }
    finally { if (this.observing.get(identity) === operation) this.observing.delete(identity); }
  }
  async observeBinding(workId, binding) {
    let agents, terminals, schedules;
    try {
      const client = await this.client(workId, binding);
      [agents, terminals, schedules] = await Promise.all([
        client.fetchAgents({ page: { limit: 200 }, timeout: 10000 }),
        client.listTerminals(undefined, undefined, { workspaceId: binding.workspaceId }), client.scheduleList(),
      ]);
    } catch (error) {
      if (!error.leadershipLost && !repositoryBusy(error)) error.paseoNativeFailure = true;
      throw error;
    }
    const rows = agents.entries.map(entry => entry.agent || entry);
    const activeAgents = rows.filter(agent => activeStates.has(agent.status) || agent.pendingPermissions?.length || agent.status === "permission").map(agent => agent.id);
    const pendingPermissions = rows.reduce((sum, agent) => sum + (agent.pendingPermissions?.length || (agent.status === "permission" ? 1 : 0)), 0);
    const activeTerminals = (terminals.terminals || []).filter(terminalBusy).length;
    const scheduled = (schedules.schedules || schedules.entries || []).filter(item => item.status === "active" || item.state === "active" || item.enabled === true).length;
    const summary = { activeAgents, pendingPermissions, activeTerminals, scheduled,
      // Paginated uncertainty prevents eviction or automatic apply; it does not hide extra agents.
      incomplete: agents.pageInfo?.hasMore === true, checkedAt: new Date().toISOString() };
    await this.store.updateRuntime(workId, { lastObserved: summary.checkedAt, nativeSummary: summary },
      { expectedDaemonGeneration: binding.daemonGeneration });
    return { state: "ready", ...summary };
  }
  async notify(workId, event) {
    if (this.closed) return;
    await this.store.updateRuntime(workId, { lastObserved: null });
    this.onNativeEvent?.(workId, event);
  }
  async profiles() {
    const connections = await this.connections.list();
    return Object.fromEntries(connections.filter(c => c.enabled !== false && c.configured && ["claude", "codex"].includes(c.tool) &&
      (!c.models?.length || c.models.some(model => model.enabled !== false)))
      .map(c => ["frame-" + c.id, {
        extends: c.tool, label: c.name, enabled: true,
        // Explicit empty arrays clear old replacements and restore native catalog discovery.
        models: (c.models || []).filter(model => model.enabled !== false)
          .map(model => ({ id: model.id, label: model.name || model.id, ...(model.id === c.model ? { isDefault: true } : {}) })),
      }]));
  }
  async syncProfiles(workId, binding = null, desired = null) {
    if (this.profileSyncs.has(workId)) return this.profileSyncs.get(workId);
    const sync = this.syncProfilesLocked(workId, binding, desired);
    this.profileSyncs.set(workId, sync);
    try { return await sync; }
    finally { if (this.profileSyncs.get(workId) === sync) this.profileSyncs.delete(workId); }
  }
  async syncProfilesLocked(workId, binding, desired) {
    binding ||= await this.store.getWork(workId);
    if (binding?.state !== "ready") return;
    desired ||= await this.profiles();
    const identity = binding.daemonGeneration + ":" + hash(JSON.stringify(desired));
    if (this.profileRevisions.get(workId) === identity) return;
    const client = await this.client(workId, binding);
    const current = (await client.getDaemonConfig()).config.providers;
    const removeProviders = Object.keys(current).filter(id => id.startsWith("frame-") && !Object.hasOwn(desired, id));
    const providers = Object.fromEntries(Object.entries(desired).filter(([id, value]) =>
      Object.entries(value).some(([key, field]) => JSON.stringify(current[id]?.[key]) !== JSON.stringify(field))));
    if (removeProviders.length || Object.keys(providers).length) {
      // The official config RPC serializes persistence and refreshes its live provider registry.
      // Active sessions keep their own launch credentials; no daemon restart or config-file race.
      await client.patchDaemonConfig({ providers, ...(removeProviders.length ? { removeProviders } : {}) });
    }
    this.profileRevisions.set(workId, identity);
  }
  async network() {
    if (process.env.FRAME_PASEO_NETWORK) return process.env.FRAME_PASEO_NETWORK;
    const container = JSON.parse(await this.runCommand("docker", ["inspect", "--format", "{{json .}}", process.env.HOSTNAME],
      { timeout: 10000, max: 256 * 1024 }));
    const networks = Object.keys(container.NetworkSettings.Networks || {});
    if (networks.length !== 1) throw Error("Configure FRAME_PASEO_NETWORK for a controller connected to multiple networks");
    return networks[0];
  }
  host(relative) {
    const base = process.env.FRAME_HOST_DATA;
    if (!base || !path.isAbsolute(base)) throw Error("FRAME_HOST_DATA is required for Docker work environments");
    return path.join(base, relative);
  }
  async prepareRuntime(workspaceRoot, work, runtime) {
    const previous = this.runtimePreparations.get(work.repo) || Promise.resolve();
    const preparation = previous.catch(() => {}).then(async () => {
      await this.assertStartupOwner();
      return this.prepareRuntimeLocked(workspaceRoot, work, runtime);
    });
    this.runtimePreparations.set(work.repo, preparation);
    try { return await preparation; }
    finally { if (this.runtimePreparations.get(work.repo) === preparation) this.runtimePreparations.delete(work.repo); }
  }
  async prepareRuntimeLocked(workspaceRoot, work, runtime) {
    // Shared immutable runtime paths are linked once. There is no project copy or second Git index.
    return this.db.lock("git-layout:" + work.repo, async () => {
      const common = (await this.runCommand("git", ["rev-parse", "--git-common-dir"], { cwd: workspaceRoot, timeout: 10000 })).trim();
      const gitCommon = path.resolve(workspaceRoot, common);
      linkSharedRuntime(workspaceRoot, root, { mutableIndex: true });
      const linked = [];
      for (const name of sharedRuntimeNames)
        if (await exists(path.join(root, name))) linked.push("/" + name);
      const excludes = path.join(gitCommon, "info/exclude");
      await fs.mkdir(path.dirname(excludes), { recursive: true });
      const previous = await fs.readFile(excludes, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return ""; });
      const existing = new Set(previous.split(/\r?\n/));
      const missing = linked.filter(name => !existing.has(name));
      if (missing.length) await fs.appendFile(excludes, (previous && !previous.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
      const marker = await confinedAsync(this.data, "paseo/" + work.id + "/runtime.json");
      await atomicPaseoJson(marker, { fingerprint: runtime.fingerprint, project: work.project, gitCommon });
      return { gitCommon };
    });
  }
  hostPath(file) {
    const relative = path.relative(path.resolve(this.data), path.resolve(file));
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep))
      throw Error("Paseo host path is outside FRAME data");
    return this.host(relative);
  }
  async sharedSpeechRoot() {
    this.speechModelsPromise ||= import("../integrations/paseo/speech-models.mjs").then(({ createSharedSpeechModels }) =>
      createSharedSpeechModels({ data: this.data, runtimeRoot: nativeRoot(), assertLeadership: () => this.assertStartupOwner() }));
    return (await this.speechModelsPromise).start();
  }
  async resumeSharedSpeech(binding) {
    if (!binding.requested) return;
    const request = binding.daemonGeneration + ":" + binding.touched;
    if (this.speechRequests.get(binding.workId) === request) return;
    await this.assertStartupOwner();
    // requestWork alone changes touched; native events only change updated/lastObserved.
    // Record this user request before awaiting so one failed download is not retried every scan.
    this.speechRequests.set(binding.workId, request);
    try { await this.sharedSpeechRoot(); }
    catch (error) {
      if (error.leadershipLost || this.closed) {
        if (this.speechRequests.get(binding.workId) === request) this.speechRequests.delete(binding.workId);
        throw error;
      }
      console.error("Paseo shared speech preparation:", binding.workId,
        "Shared speech cache unavailable; reopen the work to retry. Chat remains available.");
    }
  }
  async assertStartupOwner() {
    if (this.closed) throw Object.assign(Error("Paseo controller is stopping"), { leadershipLost: true });
    if (!this.localMode) await this.tasks.assertLeadership();
  }
  async withStartupSlot(callback) {
    // Reserve synchronously: an asynchronous lease check must not admit a third launch.
    if (this.runningStarts >= startupConcurrency) await new Promise((resolve, reject) => this.startWaiters.push({ resolve, reject }));
    else this.runningStarts++;
    try { await this.assertStartupOwner(); return await callback(); }
    finally {
      const next = this.startWaiters.shift();
      if (next) next.resolve(); // Transfer the reserved slot directly to the FIFO waiter.
      else this.runningStarts--;
    }
  }
  async start(workId, { profiles } = {}) {
    if (this.starting.has(workId)) return this.starting.get(workId);
    const start = this.withStartupSlot(() => this.db.lock("paseo-daemon:" + workId, () => this.startLocked(workId, profiles)));
    this.starting.set(workId, start);
    try { return await start; }
    finally { if (this.starting.get(workId) === start) this.starting.delete(workId); }
  }
  scheduleStart(workId, profiles) {
    if (this.closed || this.starting.has(workId) || this.starting.size >= startupConcurrency) return;
    void this.start(workId, { profiles }).catch(error => {
      if (!error.leadershipLost && !this.closed) console.error("Paseo startup request:", workId,
        paseoUnavailable("failed", error.message).message);
    });
  }
  async startLocked(workId, desiredProfiles) {
    let binding, daemonGeneration, control, phase = "prepare";
    try {
      await this.assertStartupOwner();
      binding = await this.store.getWork(workId);
      await this.workService.works.get(workId, { active: true });
      if (binding?.state === "ready") {
        try {
          await this.resumeSharedSpeech(binding);
          await this.observe(workId, { refresh: true }); return binding;
        }
        catch (error) {
          if (error.leadershipLost || !error.paseoNativeFailure) throw error;
          await this.assertStartupOwner();
          await this.dropClient(workId);
        }
      }
      const { work, workspace } = await this.workService.prepare(workId);
      binding ||= await this.store.getWork(workId);
      if (!binding) throw Error("Paseo work registration is missing");
      phase = "runtime";
      const runtime = this.localMode ? { ...(await runtimeIdentity()), image: null, local: true }
        : await executionRuntime({ data: this.data, task: { kind: "paseo" }, command: this.runCommand });
      // Layout preparation can briefly contend with another work in the same repo.
      // It does not own a daemon generation until every launch prerequisite is ready.
      const runtimeMounts = await this.prepareRuntime(workspace.workspaceRoot, work, runtime);
      await this.assertStartupOwner();
      const refreshed = await this.store.getWork(workId);
      if (refreshed?.daemonGeneration !== binding.daemonGeneration || !refreshed.requested || refreshed.state === "stopped")
        throw Object.assign(Error("Paseo startup was superseded"), { paseoStartupSuperseded: true });
      binding = refreshed;
      const nextGeneration = String(BigInt(binding.daemonGeneration || "0") + 1n);
      const admittedStart = await this.store.updateRuntime(workId, { state: "starting", daemonGeneration: nextGeneration, error: null,
        runtimeFingerprint: runtime.fingerprint, image: runtime.image }, { expectedDaemonGeneration: binding.daemonGeneration });
      if (!admittedStart) return;
      binding = admittedStart; daemonGeneration = nextGeneration;
      phase = "configuration";
      control = await this.control(workId, { create: true });
      const home = await confinedAsync(this.data, "paseo/" + workId + "/home");
      await fs.mkdir(path.join(home, ".paseo"), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(workspace.base, "references"), { recursive: true, mode: 0o700 });
      const configPath = path.join(home, ".paseo/config.json");
      const old = await fs.readFile(configPath, "utf8").then(JSON.parse).catch(error => {
        if (error.code !== "ENOENT") throw error; return {};
      });
      const profiles = await (desiredProfiles || this.profiles());
      const userProfiles = Object.fromEntries(Object.entries(old.agents?.providers || {}).filter(([id]) => !id.startsWith("frame-")));
      await atomicPaseoJson(configPath, { ...old,
        daemon: paseoDaemonOptions(old.daemon),
        features: { ...old.features, webUi: { ...old.features?.webUi, enabled: false } },
        agents: { ...old.agents, providers: { ...userProfiles, ...profiles } },
        pluginsEnabled: true, plugins: { ...old.plugins, frame: { source: "directory",
          path: this.localMode ? path.join(root, "integrations/paseo/frame-plugin") : "/opt/frame/integrations/paseo/frame-plugin", enabled: true } },
      });
      const callbackUrl = paseoCallbackUrl(workId, { localMode: this.localMode });
      await this.assertStartupOwner();
      const sharedModels = await this.sharedSpeechRoot();
      await this.assertStartupOwner();
      phase = "launch";
      let endpoint, container = null;
      if (this.localMode) {
        const port = await new Promise((resolve, reject) => { const server = net.createServer();
          server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); });
        endpoint = "http://127.0.0.1:" + port;
        const child = spawn(process.execPath, [path.join(root, "integrations/paseo/daemon-entry.mjs")], {
          cwd: workspace.workspaceRoot, windowsHide: true, env: { ...paseoProcessEnvironment(), HOME: home, PASEO_HOME: path.join(home, ".paseo"),
            PASEO_LISTEN: "127.0.0.1:" + port, FRAME_PASEO_CONTROL: await this.controlPath(workId),
            FRAME_PASEO_ROOT: nativeRoot(), FRAME_PASEO_WORK_ID: workId, FRAME_REFERENCE_ROOT: path.join(workspace.base, "references"),
            FRAME_PASEO_URL: callbackUrl, FRAME_SHARED_RUNTIME_ROOT: path.resolve(root), FRAME_SHARED_RUNTIME_FINGERPRINT: runtime.fingerprint,
            FRAME_PASEO_SHARED_MODELS: sharedModels, FRAME_PASEO_SHARED_MODELS_READONLY: "1",
          }, stdio: ["ignore", "ignore", "pipe"],
        });
        child.stderr.on("data", () => {}); // Native structured logs remain in its own private Paseo home.
        child.frameGeneration = daemonGeneration;
        this.children.set(workId, child);
        child.once("exit", () => { if (this.children.get(workId) === child) this.children.delete(workId); });
        container = String(child.pid);
      } else {
        container = "frame-paseo-" + workId;
        const existing = await inspectPaseoContainer(this.runCommand, container);
        if (existing) {
          const existingGeneration = existing.Config.Labels?.["frame.paseo.generation"];
          if (existing.Config.Labels?.["frame.paseo.work"] !== workId || !/^(0|[1-9][0-9]*)$/.test(existingGeneration || "") ||
              BigInt(existingGeneration) >= BigInt(daemonGeneration))
            throw Error("Paseo container work or generation identity conflict");
          await this.tasks.assertLeadership();
          await this.runCommand("docker", ["stop", "--time", "45", container], { timeout: 60000 });
          await this.assertStartupOwner();
          await this.runCommand("docker", ["rm", container], { timeout: 10000 });
        }
        const network = await this.network();
        endpoint = "http://" + container + ":6767";
        const args = ["run", "-d", "--name", container, "--label", "frame.paseo.work=" + workId,
          "--label", "frame.paseo.generation=" + daemonGeneration, "--label", "frame.paseo.runtime=" + runtime.fingerprint,
          "--memory", "4g", "--cpus", "2", "--pids-limit", "512", "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges", "--user", "1000:1000", "--network", network,
          "--mount", "type=bind,source=" + this.hostPath(workspace.workspaceRoot) + ",target=/workspace",
          "--mount", "type=bind,source=" + this.hostPath(workspace.workspaceRoot) + ",target=" + workspace.workspaceRoot,
          "--mount", "type=bind,source=" + this.hostPath(runtimeMounts.gitCommon) + ",target=" + runtimeMounts.gitCommon,
          "--mount", "type=bind,source=" + this.host("paseo/" + workId + "/home") + ",target=/paseo-home",
          "--mount", "type=bind,source=" + this.host("paseo/" + workId + "/control.json") + ",target=/paseo-control/control.json,readonly",
          "--mount", "type=bind,source=" + this.host("tools") + ",target=/tools,readonly",
          "--mount", "type=bind,source=" + this.host("paseo-models") + ",target=/paseo-models,readonly",
          "--mount", "type=bind,source=" + this.host("paseo/" + workId + "/references") + ",target=/frame-references,readonly",
          "-e", "FRAME_REFERENCE_ROOT=/frame-references", "-e", "FRAME_PROJECT=" + work.project,
          "-e", "HOME=/paseo-home", "-e", "PASEO_HOME=/paseo-home/.paseo",
          "-e", "PASEO_LISTEN=0.0.0.0:6767", "-e", "FRAME_PASEO_ROOT=/opt/paseo",
          "-e", "FRAME_PASEO_CONTROL=/paseo-control/control.json", "-e", "FRAME_PASEO_WORK_ID=" + workId,
          "-e", "FRAME_PASEO_URL=" + callbackUrl,
          "-e", "FRAME_SHARED_RUNTIME_ROOT=/opt/frame", "-e", "FRAME_SHARED_RUNTIME_FINGERPRINT=" + runtime.fingerprint,
          "-e", "FRAME_PASEO_SHARED_MODELS=/paseo-models", "-e", "FRAME_PASEO_SHARED_MODELS_READONLY=1",
          "-w", "/workspace", runtime.image, "node", "/opt/frame/integrations/paseo/daemon-entry.mjs"];
        await this.runCommand("chown", ["-R", "1000:1000", home], { timeout: 120000 });
        await this.runCommand("chown", ["1000:1000", workspace.base, path.join(workspace.base, "references"), await this.controlPath(workId)], { timeout: 10000 });
        await this.tasks.assertLeadership();
        await this.runCommand("docker", args, { timeout: 120000, max: 256 * 1024 });
      }
      await this.assertStartupOwner();
      phase = "health";
      await this.store.updateRuntime(workId, { endpoint, container }, { expectedDaemonGeneration: daemonGeneration });
      const deadline = Date.now() + this.startTimeoutMs;
      let health = false, healthStatus = null;
      while (Date.now() < deadline && !this.closed) {
        await this.assertStartupOwner();
        const current = await this.store.getWork(workId);
        if (current?.daemonGeneration !== daemonGeneration || current.state !== "starting")
          throw Error("Paseo startup was superseded");
        health = await fetch(endpoint + "/api/health", { headers: { Authorization: "Bearer " + control.capability }, signal: AbortSignal.timeout(2000) })
          .then(async response => { healthStatus = response.status; await response.body?.cancel(); return response.ok; })
          .catch(() => { healthStatus = null; return false; });
        if (health) break;
        await sleep(250);
      }
      if (!health) throw Error("Paseo daemon did not become ready" + (healthStatus == null ? " (health connection unavailable)" : " (health HTTP " + healthStatus + ")"));
      await this.assertStartupOwner();
      phase = "registration";
      const current = await this.store.getWork(workId);
      if (current?.daemonGeneration !== daemonGeneration || current.state !== "starting")
        throw Error("Paseo startup was superseded");
      let registeredWorkspace, serverId, lastError;
      while (Date.now() < deadline && !this.closed) {
        await this.assertStartupOwner();
        const current = await this.store.getWork(workId);
        if (current?.daemonGeneration !== daemonGeneration || current.state !== "starting")
          throw Error("Paseo startup was superseded");
        try {
          const client = await this.client(workId);
          registeredWorkspace = await client.openProject(this.localMode ? workspace.workspaceRoot : "/workspace");
          if (registeredWorkspace.error || !registeredWorkspace.workspace?.id)
            throw Error(registeredWorkspace.error || "Paseo work registration failed");
          serverId = client.getLastServerInfoMessage()?.serverId;
          if (!serverId) throw Error("Paseo worker identity is not ready");
          // Verify initial native RPCs inside the bounded registration retry loop.
          // Readers can only observe ready after the complete runtime is usable.
          await this.observeBinding(workId, { ...current, workspaceId: registeredWorkspace.workspace.id, serverId, endpoint, container });
          break;
        } catch (error) {
          if (error.leadershipLost) throw error;
          await this.assertStartupOwner();
          lastError = error; await this.dropClient(workId); await sleep(250);
        }
      }
      if (!serverId) throw Error(lastError?.message || "Paseo worker did not become ready");
      await this.assertStartupOwner();
      const admitted = await this.store.updateRuntime(workId, { state: "ready", workspaceId: registeredWorkspace.workspace.id, serverId,
        endpoint, container, error: null }, { expectedDaemonGeneration: daemonGeneration });
      if (!admitted) throw Error("Paseo startup was superseded");
    } catch (error) {
      // A former leader cannot stop a daemon or overwrite the new controller's result.
      if (error.leadershipLost || error.paseoStartupSuperseded || this.closed || repositoryBusy(error) || binding?.state === "ready" && !daemonGeneration) throw error;
      await this.assertStartupOwner();
      const expected = daemonGeneration || binding?.daemonGeneration;
      const current = await this.store.getWork(workId);
      if (expected != null && current?.daemonGeneration === expected) {
        await this.dropClient(workId);
        let cleaned = false;
        if (daemonGeneration) {
          try { cleaned = await this.cleanupFailedStart(workId, daemonGeneration); }
          catch (cleanupError) {
            if (cleanupError.leadershipLost) throw cleanupError;
            await this.assertStartupOwner();
            console.error("Paseo startup cleanup:", workId, "generation=" + expected,
              publicText(cleanupError.message, { limit: 1000, env: { ...process.env, FRAME_PASEO_TOKEN: control?.capability } }));
          }
        }
        await this.assertStartupOwner();
        const safe = publicText(error.message || "Paseo startup failed", {
          limit: 900, env: { ...process.env, FRAME_PASEO_TOKEN: control?.capability },
        });
        const message = "Paseo startup (" + phase + "): " + safe;
        const failed = await this.store.updateRuntime(workId, { state: "failed", error: message,
          ...(cleaned ? { endpoint: null, container: null } : {}) },
          { expectedDaemonGeneration: expected });
        if (failed) console.error("Paseo startup:", workId, "generation=" + expected, message);
      }
      throw error;
    }
  }
  async cleanupFailedStart(workId, generation) {
    if (this.localMode) {
      const child = this.children.get(workId);
      if (!child) return true;
      if (child.frameGeneration !== generation) throw Error("Paseo cleanup generation changed");
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(5000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
      if (this.children.get(workId) === child) this.children.delete(workId);
      return true;
    } else {
      await this.tasks.assertLeadership();
      const name = "frame-paseo-" + workId;
      const container = await inspectPaseoContainer(this.runCommand, name);
      if (!container) return true;
      if (container.Config.Labels?.["frame.paseo.work"] !== workId ||
          container.Config.Labels?.["frame.paseo.generation"] !== generation)
        throw Error("Paseo cleanup work or generation identity changed");
      await this.assertStartupOwner();
      if (container.State.Running) await this.runCommand("docker", ["stop", "--time", "10", name], { timeout: 20000 });
      await this.assertStartupOwner();
      await this.runCommand("docker", ["rm", name], { timeout: 10000 });
      return true;
    }
  }
  async dropClient(workId) {
    const old = this.clients.get(workId); this.clients.delete(workId);
    this.profileRevisions.delete(workId);
    await old?.client.close().catch(() => {});
  }
  async stop(workId, { requested = false, expectedDaemonGeneration, expectedTouched } = {}) {
    const binding = await this.store.getWork(workId);
    if (!binding) return;
    if (expectedDaemonGeneration !== undefined && binding.daemonGeneration !== expectedDaemonGeneration ||
        expectedTouched !== undefined && binding.touched !== expectedTouched) return false;
    if (!this.localMode) {
      await this.tasks.assertLeadership();
      if (binding.container) {
        const c = JSON.parse(await this.runCommand("docker", ["inspect", "--format", "{{json .}}", binding.container], { max: 256 * 1024 }));
        if (c.Config.Labels?.["frame.paseo.work"] !== workId) throw Error("Refusing to stop another work's daemon");
        await this.assertStartupOwner();
        await this.runCommand("docker", ["stop", "--time", "45", binding.container], { timeout: 60000 });
        await this.assertStartupOwner();
        await this.runCommand("docker", ["rm", binding.container], { timeout: 10000 });
      }
    } else this.children.get(workId)?.kill("SIGTERM");
    await this.assertStartupOwner();
    await this.onStopped?.(workId);
    await this.dropClient(workId);
    await this.assertStartupOwner();
    await this.store.updateRuntime(workId, { state: "stopped", requested, endpoint: null, container: null,
      daemonGeneration: String(BigInt(binding.daemonGeneration || "0") + 1n) },
      { expectedDaemonGeneration: binding.daemonGeneration });
    this.speechRequests.delete(workId);
    return true;
  }
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      if (!this.localMode) await this.tasks.assertLeadership();
      const rows = await this.store.listWorks({ states: ["cold", "starting", "ready", "stopped", "failed"] });
      // Reuse one catalog read per scan, but handle its failure inside each generation's startup.
      const currentRuntime = runtimeIdentity(), profiles = this.profiles();
      void currentRuntime.catch(() => {}); void profiles.catch(() => {});
      let warm = rows.filter(row => row.state === "ready").length;
      for (const row of rows) {
        if (this.closed) break;
        await this.assertStartupOwner();
        const stopRequested = await this.db.setting("paseo-stop:" + row.workId);
        if (stopRequested) {
          // A delayed stop belongs to one generation and cannot stop a newly reopened daemon.
          const matching = String(stopRequested.generation) === row.daemonGeneration;
          if (matching) await this.stop(row.workId);
          await this.assertStartupOwner();
          await this.db.pool.query("DELETE FROM settings WHERE key=$1 AND value=$2::jsonb",
            ["paseo-stop:" + row.workId, JSON.stringify(stopRequested)]);
          if (matching) continue;
        }
        let work;
        try { work = await this.workService.works.get(row.workId); }
        catch (error) {
          if (error.statusCode !== 404) {
            if (error.leadershipLost) throw error;
            if (!repositoryBusy(error)) console.error("Paseo work lookup:", row.workId, publicText(error.message, { limit: 1000 }));
            continue;
          }
        }
        if (!work || work.deleted) {
          this.speechRequests.delete(row.workId);
          if (row.container) await this.stop(row.workId);
          continue;
        }
        if (row.requested && ["cold", "starting"].includes(row.state)) {
          // Do not hold the scan (or unrelated cancellation/profile work) for a 90-second launch.
          this.scheduleStart(row.workId, profiles);
          continue;
        }
        if (row.state !== "ready") continue;
        try {
          await this.resumeSharedSpeech(row);
          await this.syncProfiles(row.workId, row, await profiles);
          let summary;
          try { summary = await this.observe(row.workId, { refresh: true }); }
          catch (error) {
            if (!error.paseoNativeFailure) throw error;
            await this.assertStartupOwner();
            const failed = await this.store.updateRuntime(row.workId, { state: "failed", error: "Paseo connection lost; source and native history retained" },
              { expectedDaemonGeneration: row.daemonGeneration });
            if (failed) await this.dropClient(row.workId);
            continue;
          }
          const idle = !summary.incomplete && !summary.activeAgents.length && !summary.pendingPermissions && !summary.activeTerminals;
          const validationBusy = (await this.store.listValidations(row.workId, { states: ["running"] })).length > 0;
          if (idle && !validationBusy && row.runtimeFingerprint !== (await currentRuntime).fingerprint) {
            if (await this.stop(row.workId, { requested: true, expectedDaemonGeneration: row.daemonGeneration, expectedTouched: row.touched }) !== false)
              this.scheduleStart(row.workId, profiles);
          } else if (idle && !summary.scheduled && !validationBusy &&
              Date.now() - new Date(row.touched).getTime() > (warm > 4 ? 60000 : this.idleMs)) {
            if (await this.stop(row.workId, { expectedDaemonGeneration: row.daemonGeneration, expectedTouched: row.touched }) !== false) warm--;
          } else {
            try { await this.onReconcile?.(row.workId, summary); }
            catch (error) {
              if (error.leadershipLost) throw error;
              // Source checks have their own reports; their failure cannot invalidate a healthy daemon.
              if (!repositoryBusy(error)) console.error("Paseo workspace reconciliation:", row.workId,
                publicText(error.message, { limit: 1000 }));
            }
          }
        } catch (error) {
          if (error.leadershipLost) throw error;
          if (repositoryBusy(error)) continue;
          console.error("Paseo controller reconciliation:", row.workId, publicText(error.message, { limit: 1000 }));
        }
      }
    } finally { this.ticking = false; }
  }
  async active({ repo, project, profileId, refresh = true } = {}) {
    const rows = await this.store.listWorks({ states: ["starting", "ready", "failed"] });
    const result = [];
    for (const row of rows) {
      if (repo && row.repo !== repo || project && row.project !== project) continue;
      let summary = row.nativeSummary || {};
      if (row.state === "failed" && row.container) summary = { ...summary, incomplete: true };
      if (row.state === "ready") {
        // Realtime readers reuse the controller's recent observation; writing an
        // identical summary here would trigger another subscription refresh.
        try { summary = await this.observe(row.workId, { refresh }); }
        catch { summary = { ...summary, incomplete: true }; }
      }
      if (row.state !== "starting" && !summary.incomplete && !summary.activeAgents?.length &&
          !summary.pendingPermissions && !summary.activeTerminals) continue;
      if (profileId && !summary.incomplete && row.state !== "starting") {
        try {
          const agents = await Promise.all((summary.activeAgents || []).map(id => this.agent(row.workId, id)));
          if (!agents.some(agent => agent?.provider === profileId)) continue;
        } catch { summary = { ...summary, incomplete: true }; }
      }
      result.push({ workId: row.workId, repo: row.repo, project: row.project, state: row.state,
        activeAgents: summary.activeAgents || [], pendingPermissions: summary.pendingPermissions || 0,
        activeTerminals: summary.activeTerminals || 0, incomplete: summary.incomplete || row.state === "starting" });
    }
    return result;
  }
  async cancelValidation(workId, reportId) {
    if (!/^[0-9a-f-]{36}$/i.test(reportId || "")) throw Error("Invalid validation identity");
    if (this.localMode) return; // The local command owns an AbortSignal and its child process groups.
    await this.tasks.assertLeadership();
    const binding = await this.store.getWork(workId);
    if (binding?.state !== "ready" || !binding.container) return;
    const script = `const fs=require('node:fs'),path=require('node:path');
      (async()=>{const [project,id]=process.argv.slice(1),file=path.join('/workspace/projects',project,'.cache/validation',id+'.json');
      let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code==='ENOENT')return;throw e}
      if(value.reportId!==id||!Number.isSafeInteger(value.pid)||value.pid<2)throw Error('Validation process identity changed');
      const current=()=>{let cmd;try{cmd=fs.readFileSync('/proc/'+value.pid+'/cmdline','utf8')}catch(e){if(e.code==='ENOENT')return false;throw e}
        if(!cmd)return false;if(!cmd.includes('/opt/frame/server/paseo-validate.mjs')||!cmd.includes('"reportId":"'+id+'"'))throw Error('Validation process identity changed');return true;};
      if(current()){process.kill(value.pid,'SIGTERM');const until=Date.now()+5000;
        while(current()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));
        if(current())process.kill(value.pid,'SIGKILL');}
      fs.rmSync(file,{force:true});})().catch(e=>{console.error(e.message);process.exitCode=1});`;
    await this.runCommand("docker", ["exec", binding.container, "node", "-e", script, binding.project, reportId], { timeout: 15000, max: 65536 });
  }

  async cancelWork(workId) {
    const binding = await this.store.getWork(workId);
    if (!binding || !["starting", "ready", "failed"].includes(binding.state)) return { stopped: 0 };
    if (binding.state !== "ready") {
      if (this.localMode) await this.stop(workId);
      else await this.db.setting("paseo-stop:" + workId, { generation: binding.daemonGeneration });
      return { stopped: 1 };
    }
    const client = await this.client(workId);
    const [agents, terminals] = await Promise.all([
      client.fetchAgents({ page: { limit: 200 } }),
      client.listTerminals(undefined, undefined, { workspaceId: binding.workspaceId }),
    ]);
    if (agents.pageInfo?.hasMore) throw problem(409, "请在 Paseo 中选择并停止其余创作，再重试停止作品。");
    const running = agents.entries.map(entry => entry.agent || entry)
      .filter(agent => activeStates.has(agent.status) || agent.pendingPermissions?.length);
    const terminalRows = (terminals.terminals || []).filter(terminalBusy);
    await Promise.all(running.map(agent => client.cancelAgent(agent.id)));
    await Promise.all(terminalRows.map(terminal => client.killTerminal(terminal.id)));
    await this.notify(workId, { type: "agent.turn_ended" });
    return { stopped: running.length + terminalRows.length };
  }
  beginClose() {
    this.closed = true;
    const error = Object.assign(Error("Paseo controller is stopping"), { leadershipLost: true });
    for (const waiter of this.startWaiters.splice(0)) waiter.reject(error);
    this.speechClosing ||= this.speechModelsPromise?.then(models => models.close());
    void this.speechClosing?.catch(error => console.error("Paseo shared speech stop:", publicText(error.message, { limit: 1000 })));
  }
  async close() {
    this.beginClose();
    await Promise.allSettled([...this.starting.values(), ...this.profileSyncs.values(), ...this.connecting.values(), this.speechClosing]);
    await Promise.allSettled([...this.clients.keys()].map(id => this.dropClient(id)));
    // Container daemons survive an API/controller restart; their supervisor persists native receipts.
    if (this.localMode) for (const child of this.children.values()) child.kill("SIGTERM");
  }
}
