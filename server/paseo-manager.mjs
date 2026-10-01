import fs from "node:fs/promises";
import { constants } from "node:fs";
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

const root = fileURLToPath(new URL("../", import.meta.url));
const activeStates = new Set(["running", "initializing"]);
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

// Git metadata is intentionally excluded from public project-file APIs.
async function readOwnedGitMetadata(base, relative) {
  const file = path.resolve(base, relative);
  if (!file.startsWith(path.resolve(base) + path.sep) ||
      await fs.realpath(path.dirname(file)) !== path.dirname(file))
    throw problem(403, "Native Git registration path changed");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096)
      throw problem(403, "Native Git registration is invalid");
    const value = await handle.readFile("utf8");
    const current = await fs.lstat(file);
    if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino)
      throw problem(403, "Native Git registration changed");
    return value.trim();
  } finally { await handle.close(); }
}

/** The controller owns processes; API callers only request their work's stable daemon. */
export class PaseoManager {
  constructor({ db, data, store, workService, tasks, connections, localMode = process.env.FRAME_LOCAL_MODE === "1",
    clientFactory, runCommand = command, idleMs = 20 * 60 * 1000, startTimeoutMs = 90000 } = {}) {
    Object.assign(this, { db, data, store, workService, tasks, connections, localMode, clientFactory, runCommand, idleMs, startTimeoutMs });
    this.clients = new Map(); this.connecting = new Map(); this.profileRevisions = new Map(); this.profileSyncs = new Map(); this.clientScope = "frame-" + (process.env.FRAME_ROLE || "local") + "-" + randomUUID(); this.starting = new Map(); this.children = new Map(); this.closed = false;
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
    const prepared = await this.workService.prepare(workId);
    const nativeDraft = this.localMode ? prepared.draft.draftRoot : "/workspace";
    const nativeHome = this.localMode ? path.join(prepared.draft.base, "home") : "/paseo-home";
    const normalized = path.resolve(cwd);
    let hostCwd, checkoutRoot, nativeCheckout;
    if (normalized === nativeDraft || normalized.startsWith(nativeDraft + path.sep)) {
      hostCwd = normalized === nativeDraft ? prepared.draft.draftRoot :
        await confinedAsync(prepared.draft.draftRoot, path.relative(nativeDraft, normalized).replaceAll("\\", "/"));
      checkoutRoot = prepared.draft.draftRoot; nativeCheckout = nativeDraft;
    } else {
      const nativeTrees = path.join(nativeHome, ".paseo/worktrees");
      if (!normalized.startsWith(nativeTrees + path.sep)) throw problem(403, "Native workspace does not belong to this work");
      const hostTrees = path.join(prepared.draft.base, "home/.paseo/worktrees");
      hostCwd = await confinedAsync(hostTrees, path.relative(nativeTrees, normalized).replaceAll("\\", "/"));
      let current = hostCwd;
      while (current !== hostTrees && !await exists(path.join(current, ".git"))) current = path.dirname(current);
      if (current === hostTrees) throw problem(403, "Native worktree registration is missing");
      const registration = (await readOwnedGitMetadata(current, ".git")).match(/^gitdir: (.+)$/);
      const nativeGitRoot = path.join(nativeDraft, ".git/worktrees");
      if (!registration || path.dirname(path.resolve(registration[1])) !== path.resolve(nativeGitRoot))
        throw problem(403, "Native worktree belongs to another repository");
      const backpointer = await readOwnedGitMetadata(prepared.draft.draftRoot,
        ".git/worktrees/" + path.basename(registration[1]) + "/gitdir");
      nativeCheckout = path.join(nativeTrees, path.relative(hostTrees, current));
      if (path.resolve(backpointer) !== path.resolve(nativeCheckout, ".git"))
        throw problem(403, "Native worktree registration changed");
      checkoutRoot = current;
      const modules = path.join(checkoutRoot, "node_modules");
      const shared = path.join(root, "node_modules");
      let installed = await fs.lstat(modules).catch(error => {
        if (error.code !== "ENOENT") throw error; return null;
      });
      if (!installed) {
        try { await fs.symlink(shared, modules, process.platform === "win32" ? "junction" : "dir"); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        installed = await fs.lstat(modules);
      }
      if (!installed.isSymbolicLink() || await fs.realpath(modules) !== await fs.realpath(shared))
        throw problem(409, "Native worktree dependencies are not the shared FRAME runtime");
    }
    const actual = await fs.realpath(hostCwd);
    if (actual !== hostCwd) throw problem(403, "Native workspace path changed");
    return { hostCwd, checkoutRoot, nativeCheckout, prepared };
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
    const prepared = await this.workService.prepare(typeof work === "string" ? work : work.id);
    await this.store.requestWork(prepared.work.id);
    if (this.localMode) await this.start(prepared.work.id);
    const deadline = Date.now() + this.startTimeoutMs;
    while (!this.closed && Date.now() < deadline) {
      const binding = await this.store.getWork(prepared.work.id);
      if (binding?.state === "ready" && binding.workspaceId && binding.serverId) {
        await this.syncProfiles(prepared.work.id, binding);
        return { generation: binding.daemonGeneration, workspaceId: binding.workspaceId, serverId: binding.serverId,
          draftRoot: prepared.draft.draftRoot, projectRoot: prepared.draft.projectRoot,
          runtimeRoot: root, runtimeFingerprint: binding.runtimeFingerprint, state: "ready" };
      }
      if (binding?.state === "failed") throw problem(503, binding.error || "Paseo startup failed; reopen to retry");
      await sleep(200);
    }
    throw problem(503, "Paseo is still starting; reconnect to this work");
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
    const client = await this.client(workId, binding);
    const [agents, terminals, schedules] = await Promise.all([
      client.fetchAgents({ page: { limit: 200 }, timeout: 10000 }),
      client.listTerminals(undefined, undefined, { workspaceId: binding.workspaceId }), client.scheduleList(),
    ]);
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
  async prepareRuntime(draftRoot, work, runtime) {
    // Once per runtime identity; source projects and native state are never reset.
    const marker = path.join(draftRoot, ".frame-runtime.json");
    const previous = await fs.readFile(marker, "utf8").then(JSON.parse).catch(error => {
      if (error.code !== "ENOENT") throw error; return null;
    });
    if (previous?.fingerprint === runtime.fingerprint) return;
    for (const name of ["src", "scripts", "templates", "docs", "public", "package.json", "pnpm-lock.yaml",
      "pnpm-workspace.yaml", ".npmrc", "tsconfig.json", "index.html", "vite.config.ts", "vitest.config.ts", "AGENTS.md"])
      if (await exists(path.join(root, name))) await fs.cp(path.join(root, name), path.join(draftRoot, name), { recursive: true });
    const modules = path.join(draftRoot, "node_modules");
    if (!(await exists(modules))) await fs.symlink(path.join(root, "node_modules"), modules, process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(path.join(draftRoot, ".gitignore"), ["node_modules", ".cache/", "projects/*/.cache/", "projects/*/exports/",
      "projects/*/.history/", "/.frame-runtime.json"].join("\n") + "\n");
    await atomicPaseoJson(marker, { fingerprint: runtime.fingerprint, project: work.project });
  }
  async start(workId) {
    if (this.starting.has(workId)) return this.starting.get(workId);
    const start = this.db.lock("paseo-daemon:" + workId, () => this.startLocked(workId));
    this.starting.set(workId, start);
    try { return await start; } finally { this.starting.delete(workId); }
  }
  async startLocked(workId) {
    if (!this.localMode) await this.tasks.assertLeadership();
    const { work, draft } = await this.workService.prepare(workId);
    let binding = await this.store.getWork(workId);
    if (binding.state === "ready") {
      try { await this.observe(workId, { refresh: true }); return binding; }
      catch { await this.dropClient(workId); }
    }
    const runtime = this.localMode ? { ...(await runtimeIdentity()), image: null, local: true }
      : await executionRuntime({ data: this.data, task: { kind: "paseo" }, command: this.runCommand });
    const daemonGeneration = String(BigInt(binding.daemonGeneration || "0") + 1n);
    binding = await this.store.updateRuntime(workId, { state: "starting", daemonGeneration, error: null,
      runtimeFingerprint: runtime.fingerprint, image: runtime.image }, { expectedDaemonGeneration: binding.daemonGeneration });
    if (!binding) return;
    try {
      const control = await this.control(workId, { create: true });
      const home = await confinedAsync(this.data, "paseo/" + workId + "/home");
      await fs.mkdir(path.join(home, ".paseo"), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(draft.base, "references"), { recursive: true, mode: 0o700 });
      await this.prepareRuntime(draft.draftRoot, work, runtime);
      const configPath = path.join(home, ".paseo/config.json");
      const old = await fs.readFile(configPath, "utf8").then(JSON.parse).catch(error => {
        if (error.code !== "ENOENT") throw error; return {};
      });
      const profiles = await this.profiles();
      const userProfiles = Object.fromEntries(Object.entries(old.agents?.providers || {}).filter(([id]) => !id.startsWith("frame-")));
      await atomicPaseoJson(configPath, { ...old,
        daemon: { ...old.daemon, relay: { ...old.daemon?.relay, enabled: false } },
        features: { ...old.features, webUi: { ...old.features?.webUi, enabled: false } },
        agents: { ...old.agents, providers: { ...userProfiles, ...profiles } },
        pluginsEnabled: true, plugins: { ...old.plugins, frame: { source: "directory",
          path: this.localMode ? path.join(root, "integrations/paseo/frame-plugin") : "/opt/frame/integrations/paseo/frame-plugin", enabled: true } },
      });
      let endpoint, container = null;
      if (this.localMode) {
        const port = await new Promise((resolve, reject) => { const server = net.createServer();
          server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); });
        endpoint = "http://127.0.0.1:" + port;
        const child = spawn(process.execPath, [path.join(root, "integrations/paseo/daemon-entry.mjs")], {
          cwd: draft.draftRoot, windowsHide: true, env: { ...paseoProcessEnvironment(), HOME: home, PASEO_HOME: path.join(home, ".paseo"),
            PASEO_LISTEN: "127.0.0.1:" + port, FRAME_PASEO_CONTROL: await this.controlPath(workId),
            FRAME_PASEO_ROOT: nativeRoot(), FRAME_PASEO_WORK_ID: workId, FRAME_REFERENCE_ROOT: path.join(draft.base, "references"),
            FRAME_PASEO_URL: (process.env.FRAME_AGENT_URL || process.env.FRAME_PUBLIC_URL) + "/api/paseo/internal/" + workId,
          }, stdio: ["ignore", "ignore", "pipe"],
        });
        child.stderr.on("data", () => {}); // Native structured logs remain in its own private Paseo home.
        child.frameGeneration = daemonGeneration;
        this.children.set(workId, child);
        child.once("exit", () => { if (this.children.get(workId) === child) this.children.delete(workId); });
        container = String(child.pid);
      } else {
        container = "frame-paseo-" + workId;
        const existing = await this.runCommand("docker", ["inspect", "--format", "{{json .}}", container],
          { timeout: 10000, max: 256 * 1024 }).then(JSON.parse).catch(() => null);
        if (existing) {
          if (existing.Config.Labels?.["frame.paseo.work"] !== workId) throw Error("Paseo container identity conflict");
          await this.tasks.assertLeadership();
          await this.runCommand("docker", ["stop", "--time", "45", container], { timeout: 60000 });
          await this.runCommand("docker", ["rm", container], { timeout: 10000 });
        }
        const network = await this.network();
        endpoint = "http://" + container + ":6767";
        const args = ["run", "-d", "--name", container, "--label", "frame.paseo.work=" + workId,
          "--label", "frame.paseo.generation=" + daemonGeneration, "--label", "frame.paseo.runtime=" + runtime.fingerprint,
          "--memory", "4g", "--cpus", "2", "--pids-limit", "512", "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges", "--user", "1000:1000", "--network", network,
          "--mount", "type=bind,source=" + this.host("paseo/" + workId + "/draft") + ",target=/workspace",
          "--mount", "type=bind,source=" + this.host("paseo/" + workId + "/home") + ",target=/paseo-home",
          "--mount", "type=bind,source=" + this.host("paseo/" + workId + "/control.json") + ",target=/paseo-control/control.json,readonly",
          "--mount", "type=bind,source=" + this.host("tools") + ",target=/tools,readonly",
          "--mount", "type=bind,source=" + this.host("paseo/" + workId + "/references") + ",target=/frame-references,readonly",
          "-e", "FRAME_REFERENCE_ROOT=/frame-references",
          "-e", "HOME=/paseo-home", "-e", "PASEO_HOME=/paseo-home/.paseo",
          "-e", "PASEO_LISTEN=0.0.0.0:6767", "-e", "FRAME_PASEO_ROOT=/opt/paseo",
          "-e", "FRAME_PASEO_CONTROL=/paseo-control/control.json", "-e", "FRAME_PASEO_WORK_ID=" + workId,
          "-e", "FRAME_PASEO_URL=" + (process.env.FRAME_AGENT_URL || process.env.FRAME_PUBLIC_URL) + "/api/paseo/internal/" + workId,
          "-w", "/workspace", runtime.image, "node", "/opt/frame/integrations/paseo/daemon-entry.mjs"];
        // Existing platform read-only interfaces are visible; only this work's project tree is writable.
        for (const name of ["src", "scripts", "docs", "templates", "public", "node_modules", "package.json", "pnpm-lock.yaml",
          "pnpm-workspace.yaml", ".npmrc", "tsconfig.json", "vite.config.ts", "vitest.config.ts", "AGENTS.md"])
          if (await exists(path.join(root, name))) {
            const at = args.indexOf("-w");
            args.splice(at, 0, "--mount", "type=bind,source=" + this.host("paseo/" + workId + "/draft/" + name) + ",target=/workspace/" + name + ",readonly");
          }
        // node_modules is an image-owned link; bind its actual image directory through the mounted draft is unnecessary.
        const nm = args.findIndex(arg => arg.includes("draft/node_modules,target="));
        if (nm >= 0) args.splice(nm - 1, 2);
        await this.runCommand("chown", ["-R", "1000:1000", draft.base], { timeout: 120000 });
        await this.tasks.assertLeadership();
        await this.runCommand("docker", args, { timeout: 120000, max: 256 * 1024 });
      }
      await this.store.updateRuntime(workId, { endpoint, container }, { expectedDaemonGeneration: daemonGeneration });
      const deadline = Date.now() + this.startTimeoutMs;
      let health = false;
      while (Date.now() < deadline && !this.closed) {
        const current = await this.store.getWork(workId);
        if (current?.daemonGeneration !== daemonGeneration || current.state !== "starting")
          throw Error("Paseo startup was superseded");
        health = await fetch(endpoint + "/api/health", { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false);
        if (health) break;
        await sleep(250);
      }
      if (!health) throw Error("Paseo daemon did not become ready");
      const current = await this.store.getWork(workId);
      if (current?.daemonGeneration !== daemonGeneration || current.state !== "starting")
        throw Error("Paseo startup was superseded");
      let workspace, serverId, lastError;
      while (Date.now() < deadline && !this.closed) {
        const current = await this.store.getWork(workId);
        if (current?.daemonGeneration !== daemonGeneration || current.state !== "starting")
          throw Error("Paseo startup was superseded");
        try {
          const client = await this.client(workId);
          workspace = await client.openProject(this.localMode ? draft.draftRoot : "/workspace");
          if (workspace.error || !workspace.workspace?.id)
            throw Error(workspace.error || "Paseo work registration failed");
          serverId = client.getLastServerInfoMessage()?.serverId;
          if (!serverId) throw Error("Paseo worker identity is not ready");
          break;
        } catch (error) { lastError = error; await this.dropClient(workId); await sleep(250); }
      }
      if (!serverId) throw Error(lastError?.message || "Paseo worker did not become ready");
      const admitted = await this.store.updateRuntime(workId, { state: "ready", workspaceId: workspace.workspace.id, serverId,
        endpoint, container, error: null }, { expectedDaemonGeneration: daemonGeneration });
      if (!admitted) throw Error("Paseo startup was superseded");
      await this.observe(workId, { refresh: true });
    } catch (error) {
      await this.dropClient(workId);
      await this.cleanupFailedStart(workId, daemonGeneration).catch(() => {});
      await this.store.updateRuntime(workId, { state: "failed", endpoint: null, container: null, error: String(error.message).slice(0, 1000) },
        { expectedDaemonGeneration: daemonGeneration });
      throw error;
    }
  }
  async cleanupFailedStart(workId, generation) {
    if (this.localMode) {
      const child = this.children.get(workId);
      if (child?.frameGeneration !== generation) return;
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(5000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
      if (this.children.get(workId) === child) this.children.delete(workId);
    } else {
      await this.tasks.assertLeadership();
      const name = "frame-paseo-" + workId;
      const container = await this.runCommand("docker", ["inspect", "--format", "{{json .}}", name],
        { timeout: 10000, max: 256 * 1024 }).then(JSON.parse).catch(() => null);
      if (!container || container.Config.Labels?.["frame.paseo.work"] !== workId ||
          container.Config.Labels?.["frame.paseo.generation"] !== generation) return;
      if (container.State.Running) await this.runCommand("docker", ["stop", "--time", "10", name], { timeout: 20000 });
      await this.runCommand("docker", ["rm", name], { timeout: 10000 });
    }
  }
  async dropClient(workId) {
    const old = this.clients.get(workId); this.clients.delete(workId);
    this.profileRevisions.delete(workId);
    await old?.client.close().catch(() => {});
  }
  async stop(workId, { requested = false } = {}) {
    const binding = await this.store.getWork(workId);
    if (!binding) return;
    if (!this.localMode) {
      await this.tasks.assertLeadership();
      if (binding.container) {
        const c = JSON.parse(await this.runCommand("docker", ["inspect", "--format", "{{json .}}", binding.container], { max: 256 * 1024 }));
        if (c.Config.Labels?.["frame.paseo.work"] !== workId) throw Error("Refusing to stop another work's daemon");
        await this.runCommand("docker", ["stop", "--time", "45", binding.container], { timeout: 60000 });
        await this.runCommand("docker", ["rm", binding.container], { timeout: 10000 });
      }
    } else this.children.get(workId)?.kill("SIGTERM");
    await this.onStopped?.(workId);
    await this.dropClient(workId);
    await this.store.updateRuntime(workId, { state: "stopped", requested, endpoint: null, container: null,
      daemonGeneration: String(BigInt(binding.daemonGeneration || "0") + 1n) },
      { expectedDaemonGeneration: binding.daemonGeneration });
  }
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      if (!this.localMode) await this.tasks.assertLeadership();
      const rows = await this.store.listWorks({ states: ["cold", "starting", "ready", "stopped", "failed"] });
      const currentRuntime = await runtimeIdentity();
      const profiles = await this.profiles();
      let warm = rows.filter(row => row.state === "ready").length;
      for (const row of rows) {
        if (this.closed) break;
        const stopRequested = await this.db.setting("paseo-stop:" + row.workId);
        if (stopRequested) {
          // A delayed stop belongs to one generation and cannot stop a newly reopened daemon.
          const matching = String(stopRequested.generation) === row.daemonGeneration;
          if (matching) await this.stop(row.workId);
          await this.db.pool.query("DELETE FROM settings WHERE key=$1 AND value=$2::jsonb",
            ["paseo-stop:" + row.workId, JSON.stringify(stopRequested)]);
          if (matching) continue;
        }
        const work = await this.workService.works.get(row.workId).catch(() => null);
        if (!work || work.deleted) { if (row.container) await this.stop(row.workId); continue; }
        if (row.requested && ["cold", "starting"].includes(row.state)) {
          await this.start(row.workId).catch(() => {}); continue;
        }
        if (row.state !== "ready") continue;
        try {
          await this.syncProfiles(row.workId, row, profiles);
          const summary = await this.observe(row.workId, { refresh: true });
          const idle = !summary.incomplete && !summary.activeAgents.length && !summary.pendingPermissions && !summary.activeTerminals;
          const candidateBusy = (await this.store.listCandidates(row.workId, { states: ["validating", "publishing"] })).length > 0;
          if (idle && !candidateBusy && row.runtimeFingerprint !== currentRuntime.fingerprint) {
            await this.stop(row.workId, { requested: true });
            await this.start(row.workId);
          } else if (idle && !summary.scheduled && !candidateBusy &&
              Date.now() - new Date(row.touched).getTime() > (warm > 4 ? 60000 : this.idleMs)) {
            await this.stop(row.workId); warm--;
          } else await this.onReconcile?.(row.workId, summary);
        } catch (error) {
          await this.store.updateRuntime(row.workId, { state: "failed", error: "Paseo connection lost; draft and history retained" });
          await this.dropClient(row.workId);
        }
      }
    } finally { this.ticking = false; }
  }
  async active({ repo, project, profileId } = {}) {
    const rows = await this.store.listWorks({ states: ["starting", "ready", "failed"] });
    const result = [];
    for (const row of rows) {
      if (repo && row.repo !== repo || project && row.project !== project) continue;
      let summary = row.nativeSummary || {};
      if (row.state === "failed" && row.container) summary = { ...summary, incomplete: true };
      if (row.state === "ready") {
        try { summary = await this.observe(row.workId, { refresh: true }); }
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
  beginClose() { this.closed = true; }
  async close() {
    this.beginClose();
    await Promise.allSettled([...this.starting.values(), ...this.profileSyncs.values(), ...this.connecting.values()]);
    await Promise.allSettled([...this.clients.keys()].map(id => this.dropClient(id)));
    // Container daemons survive an API/controller restart; their supervisor persists native receipts.
    if (this.localMode) for (const child of this.children.values()) child.kill("SIGTERM");
  }
}
