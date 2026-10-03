import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { fixture, until } from "./paseo-test-fixture.mjs";
import { holdSharedSpeechPreparation } from "./paseo-speech-model-fixture.mjs";
import { PaseoManager, paseoProcessEnvironment } from "../../server/paseo-manager.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
async function runtimePath() {
  const candidates = [process.env.FRAME_PASEO_ROOT, "/opt/paseo", path.join(root, ".cache/paseo-runtime")].filter(Boolean);
  for (const candidate of candidates) {
    if (await fs.stat(path.join(candidate, "node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js")).catch(() => null)) return candidate;
  }
  throw Error("Install the pinned Paseo native runtime before running actual manager integration tests");
}

async function managedFixture(t, options = {}) {
  let manager;
  t.after(async () => {
    const children = [...(manager?.children.values() || [])];
    await manager?.close();
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      let timer;
      try { await Promise.race([once(child, "exit"), new Promise(resolve => { timer = setTimeout(resolve, 4000); })]); }
      finally { clearTimeout(timer); }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }));
  });
  const f = await fixture(t);
  const selectedRuntime = await runtimePath();
  const previous = process.env.FRAME_PASEO_ROOT;
  process.env.FRAME_PASEO_ROOT = selectedRuntime;
  t.after(() => { if (previous === undefined) delete process.env.FRAME_PASEO_ROOT; else process.env.FRAME_PASEO_ROOT = previous; });
  manager = new PaseoManager({ ...f, localMode: true, tasks: {}, connections: { list: async () => [] }, startTimeoutMs: 45000, ...options });
  await holdSharedSpeechPreparation(manager, { runtimeRoot: selectedRuntime });
  return { ...f, manager, selectedRuntime };
}

test("Actual pinned daemon SDK registers one work, rejects alternate workspaces, cancels terminals and restarts with history intact", { timeout: 120000 }, async t => {
  const f = await managedFixture(t);
  const ready = await Promise.all(Array.from({ length: 4 }, () => f.manager.ensure(f.work)));
  assert.equal(new Set(ready.map(value => value.generation)).size, 1);
  assert.equal(new Set(ready.map(value => value.serverId)).size, 1);
  assert.equal(f.manager.children.size, 1);
  const first = await f.store.getWork(f.work.id);
  assert.equal(first.state, "ready");
  const client = await f.manager.client(f.work.id);
  assert.strictEqual(await f.manager.client(f.work.id), client);
  const summary = await f.manager.observe(f.work.id, { refresh: true });
  assert.equal(summary.incomplete, false);
  assert.deepEqual(summary.activeAgents, []);
  assert.equal(summary.activeTerminals, 0);
  assert.equal(await f.manager.authorize(f.work.id, "foreign-capability"), false);
  const control = await f.manager.control(f.work.id);
  assert.equal(await f.manager.authorize(f.work.id, control.capability), true);
  assert.equal((await fs.stat(await f.manager.controlPath(f.work.id))).mode & 0o077, 0);
  const checkout = ready[0].workspaceRoot;
  const resolved = await f.manager.resolveAgentWorkspace(f.work.id, checkout);
  assert.equal(resolved.checkoutRoot, checkout);
  assert.equal(resolved.hostCwd, checkout);
  await assert.rejects(f.manager.resolveAgentWorkspace(f.work.id, path.join(f.data, "paseo", f.work.id, "home/.paseo/worktrees/alternate")), error => error.statusCode === 403);
  const originalAgent = f.manager.agent;
  f.manager.agent = async (_id, agentId) => ({ id: agentId, status: "running", cwd: checkout });
  const credential = await f.manager.agentCredential(f.work.id, "active-worktree-agent");
  assert.equal((await f.manager.agentContext(credential)).runRoot, checkout);
  assert.equal(await f.manager.agentContext(credential.slice(0, -1) + (credential.endsWith("A") ? "B" : "A")), null);
  const other = await f.manager.agentCredential(f.work.id, "other-agent");
  assert.notEqual(other, credential);
  f.manager.agent = originalAgent;
  const terminal = await client.createTerminal(ready[0].workspaceRoot, "Owned long-running terminal", undefined,
    { workspaceId: first.workspaceId, command: process.execPath, args: ["-e", "const fs=require('node:fs');fs.mkdirSync('projects/fixture/.cache',{recursive:true});fs.writeFileSync('projects/fixture/.cache/runtime-env.json',JSON.stringify({root:process.env.FRAME_SHARED_RUNTIME_ROOT,fingerprint:process.env.FRAME_SHARED_RUNTIME_FINGERPRINT}));process.stdout.write('owned-test');setInterval(()=>{},1000)"] });
  assert.ok(terminal.terminal?.id, JSON.stringify(terminal));
  const nativeEnvironment = await until(async () => fs.readFile(path.join(f.canonical, ".cache/runtime-env.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; }));
  assert.deepEqual(nativeEnvironment, { root: path.resolve(root), fingerprint: first.runtimeFingerprint });
  await until(async () => (await f.manager.observe(f.work.id, { refresh: true })).activeTerminals > 0, "Native terminal was never observed working", 10000);
  const active = await f.manager.active({ repo: f.work.repo, project: f.work.project });
  assert.equal(active.length, 1);
  assert.equal(active[0].workId, f.work.id);
  const cancelled = await f.manager.cancelWork(f.work.id);
  assert.equal(cancelled.stopped, 1);
  await until(async () => (await f.manager.observe(f.work.id, { refresh: true })).activeTerminals === 0, "Native terminal remained active after cancel", 10000);
  const prepared = await f.workService.prepare(f.work.id);
  await fs.writeFile(path.join(prepared.workspace.projectRoot, "scene.ts"), "export const durableManualEdit=true;");
  const child = f.manager.children.get(f.work.id);
  await f.manager.stop(f.work.id);
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  const stopped = await f.store.getWork(f.work.id);
  assert.equal(stopped.state, "stopped");
  const reopened = await f.manager.ensure(f.work.id);
  assert.equal(BigInt(reopened.generation), BigInt(stopped.daemonGeneration) + 1n);
  assert.equal(await fs.readFile(path.join(prepared.workspace.projectRoot, "scene.ts"), "utf8"), "export const durableManualEdit=true;");
  assert.equal((await f.manager.control(f.work.id)).capability, control.capability);
});

function stateManager({ summary = {}, row = {}, schedules = [], validations = [] } = {}) {
  const binding = { workId: "owned-work", repo: "repo", project: "film", state: "ready", daemonGeneration: "1",
    endpoint: "http://owned.invalid", workspaceId: "workspace", touched: new Date(0).toISOString(), runtimeFingerprint: "old", ...row };
  const changes = [], actions = [];
  const store = { getWork: async () => binding, listWorks: async () => [binding], listValidations: async () => validations,
    updateRuntime: async (_id, patch) => { changes.push(patch); Object.assign(binding, patch); return binding; } };
  const manager = new PaseoManager({ store, data: "/unused", localMode: true, tasks: {}, db: { setting: async () => null },
    workService: { works: { get: async () => ({ id: binding.workId }) } }, connections: { list: async () => [] } });
  const config = { providers: {} };
  const client = { getDaemonConfig: async () => ({ config }), patchDaemonConfig: async patch => {
    Object.assign(config.providers, patch.providers || {});
    for (const id of patch.removeProviders || []) delete config.providers[id];
    return { config };
  }, fetchAgents: async () => ({ entries: summary.agents || [], pageInfo: { hasMore: !!summary.incomplete } }),
    fetchAgent: async ({ agentId }) => ({ agent: (summary.agents || []).find(agent => agent.id === agentId) || null }),
    listTerminals: async () => ({ terminals: summary.terminals || [] }), scheduleList: async () => ({ schedules }) };
  manager.client = async () => client;
  manager.stop = async id => { actions.push(["stop", id]); };
  manager.start = async id => { actions.push(["start", id]); };
  return { manager, binding, actions, changes };
}

test("Idle eviction and runtime upgrades respect active agents, permissions, terminals, schedules, validations and incomplete pagination", async () => {
  for (const summary of [{ agents: [{ id: "a", status: "running" }] }, { agents: [{ id: "a", status: "idle", pendingPermissions: [{}] }] },
    { terminals: [{ id: "t", activity: { state: "working" } }] }, { terminals: [{ id: "unknown-terminal", activity: null }] },
    { terminals: [{ id: "waiting-terminal", activity: { state: "idle", attentionReason: "needs_input" } }] }, { incomplete: true }]) {
    const f = stateManager({ summary });
    await f.manager.tick();
    assert.deepEqual(f.actions, []);
  }
  const candidate = stateManager({ validations: [{ state: "running" }] });
  await candidate.manager.tick();
  assert.deepEqual(candidate.actions, []);
  const idle = stateManager();
  await idle.manager.tick();
  assert.deepEqual(idle.actions, [["stop", "owned-work"], ["start", "owned-work"]]);
  const { runtimeIdentity } = await import("../../scripts/runtime-identity.mjs");
  const scheduled = stateManager({ row: { runtimeFingerprint: (await runtimeIdentity()).fingerprint }, schedules: [{ enabled: true }] });
  await scheduled.manager.tick();
  assert.deepEqual(scheduled.actions, []);
});

test("Cancelling an actual daemon during startup invalidates readiness and promptly releases its process", { timeout: 30000 }, async t => {
  const f = await managedFixture(t, { startTimeoutMs: 15000 });
  const opening = f.manager.ensure(f.work).then(value => ({ value }), error => ({ error }));
  const child = await until(() => f.manager.children.get(f.work.id), "Owned daemon did not spawn", 10000);
  const begun = Date.now();
  assert.deepEqual(await f.manager.cancelWork(f.work.id), { stopped: 1 });
  const result = await opening;
  assert.ok(result.error, "Cancelled startup must not admit a ready daemon");
  assert.ok(Date.now() - begun < 5000, "Cancelled startup waited for the full readiness timeout");
  assert.equal((await f.store.getWork(f.work.id)).state, "stopped");
  await until(() => child.exitCode !== null || child.signalCode !== null, "Cancelled native process remains alive", 5000);
  assert.equal(f.manager.children.size, 0);
  assert.equal(f.manager.clients.size, 0);
});

test("Failure after spawning an actual daemon clears only that generation's processes and clients", { timeout: 20000 }, async t => {
  let closed = 0, spawned;
  const f = await managedFixture(t, { startTimeoutMs: 5000, clientFactory: async () => ({
    connect: async () => {}, close: async () => { closed++; }, openProject: async () => { throw Error("Owned deliberate registration failure"); },
  }) });
  const originalSet = f.manager.children.set.bind(f.manager.children);
  f.manager.children.set = (id, child) => { spawned = child; return originalSet(id, child); };
  await assert.rejects(f.manager.ensure(f.work), /registration failure|did not become ready/);
  assert.ok(spawned);
  await until(() => spawned.exitCode !== null || spawned.signalCode !== null, "Failed native process remains alive", 5000);
  assert.equal(f.manager.children.size, 0);
  assert.equal(f.manager.clients.size, 0);
  const binding = await f.store.getWork(f.work.id);
  assert.equal(binding.state, "failed");
  assert.equal(binding.endpoint, null);
  assert.equal(binding.container, null);
  assert.ok(closed > 0, "Failed SDK clients were not closed");
});

test("Native provider catalog exposes enabled labels/models without profile secrets or endpoints", async () => {
  const manager = new PaseoManager({ connections: { list: async () => [
    { id: "profile-a", tool: "codex", configured: true, name: "Allowed", model: "selected", apiKey: "private-key",
      baseUrl: "https://private-endpoint.invalid", models: [{ id: "selected", name: "Model" }, { id: "disabled", enabled: false }] },
    { id: "disabled", tool: "claude", configured: true, enabled: false },
    { id: "unconfigured", tool: "claude", configured: false },
  ] } });
  const profiles = await manager.profiles();
  assert.deepEqual(profiles, { "frame-profile-a": { extends: "codex", label: "Allowed", enabled: true,
    models: [{ id: "selected", label: "Model", isDefault: true }] } });
  const publicJson = JSON.stringify(profiles);
  assert.equal(publicJson.includes("private-key"), false);
  assert.equal(publicJson.includes("private-endpoint"), false);
});


test("Provider activity admission includes native agents waiting for permissions", async () => {
  const pending = stateManager({ summary: { agents: [{ id: "permission-agent", status: "idle",
    provider: "frame-pending-profile", pendingPermissions: [{ id: "permission" }] }] } });
  assert.equal((await pending.manager.active({ profileId: "frame-pending-profile" })).length, 1);
  assert.equal((await pending.manager.active({ profileId: "frame-foreign-profile" })).length, 0);
});


test("Actual SDK synchronizes live FRAME profiles, names and model replacements without restarting or deleting native profiles", { timeout: 120000 }, async t => {
  let connections = [];
  const f = await managedFixture(t, { connections: { list: async () => connections } });
  await f.manager.ensure(f.work);
  const first = await f.store.getWork(f.work.id);
  const child = f.manager.children.get(f.work.id);
  const client = await f.manager.client(f.work.id);
  const personal = { extends: "codex", label: "Native personal profile", enabled: true, models: [] };
  await client.patchDaemonConfig({ providers: { "personal-codex": personal } });
  const id = randomUUID(), added = randomUUID();
  connections = [{ id, tool: "codex", configured: true, enabled: true, name: "Initial FRAME name", model: "model-a",
    models: [{ id: "model-a", name: "Model A" }, { id: "hidden", enabled: false }],
    apiKey: "private-profile-key", baseUrl: "https://private-profile.invalid" }];
  await f.manager.syncProfiles(f.work.id);
  const providers = (await client.getDaemonConfig()).config.providers;
  assert.equal(providers["frame-" + id].label, "Initial FRAME name");
  assert.deepEqual(providers["frame-" + id].models, [{ id: "model-a", label: "Model A", isDefault: true }]);
  assert.deepEqual((await client.listProviderModels("frame-" + id)).models.map(model => model.id), ["model-a"]);
  connections = [{ ...connections[0], name: "Renamed FRAME profile", model: "model-b", models: [{ id: "model-b", name: "Model B" }] },
    { id: added, tool: "claude", configured: true, name: "Added FRAME profile", model: "added-model", models: [{ id: "added-model" }], apiKey: "another-private-key" }];
  await Promise.all([f.manager.syncProfiles(f.work.id), f.manager.syncProfiles(f.work.id)]);
  const renamed = (await client.getDaemonConfig()).config.providers;
  assert.equal(renamed["frame-" + id].label, "Renamed FRAME profile");
  assert.deepEqual((await client.listProviderModels("frame-" + id)).models.map(model => model.id), ["model-b"]);
  assert.ok(renamed["frame-" + added]);
  connections = [{ ...connections[0], models: [] }];
  await f.manager.syncProfiles(f.work.id);
  assert.deepEqual((await client.getDaemonConfig()).config.providers["frame-" + id].models, []);
  connections = [{ ...connections[0], enabled: false }];
  await f.manager.syncProfiles(f.work.id);
  const final = (await client.getDaemonConfig()).config.providers;
  assert.equal(final["frame-" + id], undefined);
  assert.equal(final["frame-" + added], undefined);
  assert.equal(final["personal-codex"].label, personal.label);
  const publicConfig = JSON.stringify(final);
  assert.equal(publicConfig.includes("private-profile-key"), false);
  assert.equal(publicConfig.includes("another-private-key"), false);
  assert.equal(publicConfig.includes("private-profile.invalid"), false);
  const latest = await f.store.getWork(f.work.id);
  assert.equal(latest.daemonGeneration, first.daemonGeneration);
  assert.equal(latest.serverId, first.serverId);
  assert.equal(f.manager.children.get(f.work.id).pid, child.pid);
  assert.strictEqual(await f.manager.client(f.work.id), client);
});

test("Native process environment preserves system settings without inheriting service or provider credentials", () => {
  const env = paseoProcessEnvironment({ PATH: "/fixture/bin", Path: "C:\\fixture", LC_ALL: "zh_CN.UTF-8",
    HTTPS_PROXY: "http://fixture-proxy:8080", NODE_EXTRA_CA_CERTS: "/fixture/ca.pem", SystemRoot: "C:\\Windows",
    FRAME_MASTER_KEY: "private-master", DATABASE_URL: "private-db", FRAME_TEST_DATABASE_URL: "private-test-db",
    OPENAI_API_KEY: "private-key", ANTHROPIC_AUTH_TOKEN: "private-auth", PASEO_PASSWORD: "foreign-password",
    CODEX_HOME: "/foreign-home", NODE_OPTIONS: "--require=/foreign-hook" });
  assert.deepEqual(env, { PATH: "/fixture/bin", Path: "C:\\fixture", LC_ALL: "zh_CN.UTF-8",
    HTTPS_PROXY: "http://fixture-proxy:8080", NODE_EXTRA_CA_CERTS: "/fixture/ca.pem", SystemRoot: "C:\\Windows" });
});
