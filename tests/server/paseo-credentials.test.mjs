import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./paseo-test-fixture.mjs";
import { PaseoManager } from "../../server/paseo-manager.mjs";
import { paseoSessionEnvironment } from "../../server/paseo-credentials.mjs";

async function setup(t, overrides = {}) {
  const f = await fixture(t);
  const prepared = await f.workService.prepare(f.work.id);
  const connectionId = randomUUID();
  let config = { id: connectionId, tool: "codex", mode: "api", enabled: true,
    name: "Fixture profile", model: "model-a", models: [{ id: "model-a" }, { id: "model-b" }],
    apiKey: "fixture-secret-never-persist", baseUrl: "https://fixture.invalid/v1", auth_generation: "2", ...overrides };
  let agent = null;
  const manager = new PaseoManager({ ...f, localMode: true, tasks: {}, connections: {} });
  manager.store = { getWork: async () => ({ workspaceId: "main-workspace" }) };
  manager.agent = async () => agent;
  await manager.control(f.work.id, { create: true });
  const options = { workId: f.work.id, manager, workService: f.workService, data: f.data,
    connections: { resolve: async id => { assert.equal(id, connectionId); return config; } },
    db: f.db, secrets: {}, localMode: true };
  const request = { version: 1, agentId: "agent-a", workspaceId: "main-workspace",
    provider: "frame-" + connectionId, cwd: prepared.workspace.workspaceRoot, reason: "create", purpose: "interactive" };
  return { ...f, prepared, options, request, setConfig: next => { config = { ...config, ...next }; }, setAgent: next => { agent = next; } };
}

test("Native profile credentials stay session-only and endpoint/auth changes fail closed", async t => {
  const f = await setup(t);
  const response = await paseoSessionEnvironment({ ...f.options, request: f.request });
  assert.equal(response.env.OPENAI_API_KEY, "fixture-secret-never-persist");
  assert.equal(response.env.CODEX_API_KEY, response.env.OPENAI_API_KEY);
  assert.equal(response.env.OPENAI_BASE_URL, "https://fixture.invalid/v1");
  assert.equal(response.env.FRAME_PROJECT, f.work.project);
  assert.equal(response.env.FRAME_PASEO_WORK_ID, f.work.id);
  const saved = await fs.readFile(path.join(f.data, "paseo", f.work.id, "launches/agent-a.json"), "utf8");
  assert.equal(saved.includes("fixture-secret"), false);
  assert.equal(JSON.parse(saved).selection.authGeneration, "2");
  assert.equal((await fs.stat(path.dirname(response.env.CODEX_HOME))).mode & 0o077, 0);
  f.setAgent({ id: "agent-a", provider: f.request.provider, cwd: f.request.cwd, model: "model-b" });
  await paseoSessionEnvironment({ ...f.options, request: { ...f.request, reason: "resume" } });
  f.setConfig({ baseUrl: "https://changed.invalid" });
  await assert.rejects(paseoSessionEnvironment({ ...f.options, request: { ...f.request, reason: "refresh" } }), error => error.code === "EXECUTION_SELECTION_CHANGED");
  f.setConfig({ baseUrl: "https://fixture.invalid/v1", auth_generation: "3" });
  await assert.rejects(paseoSessionEnvironment({ ...f.options, request: { ...f.request, reason: "refresh" } }), error => error.code === "EXECUTION_SELECTION_CHANGED");
});

test("Credential admission rejects foreign cwd/profile/agent and linked workspace escape", async t => {
  const f = await setup(t);
  await assert.rejects(paseoSessionEnvironment({ ...f.options, request: { ...f.request, cwd: f.prepared.workspace.workspaceRoot + "-foreign" } }), error => error.statusCode === 403);
  f.setAgent({ id: "agent-a", provider: "other-provider", cwd: f.request.cwd });
  await assert.rejects(paseoSessionEnvironment({ ...f.options, request: { ...f.request, reason: "resume" } }), error => error.statusCode === 404);
  await assert.rejects(paseoSessionEnvironment({ ...f.options, request: { ...f.request, workspaceId: "foreign-workspace" } }), error => error.statusCode === 409);
  const outside = path.join(f.directory, "foreign-workspace");
  await fs.mkdir(outside);
  const linked = path.join(f.prepared.workspace.workspaceRoot, "linked-foreign-workspace");
  await fs.symlink(outside, linked);
  await assert.rejects(paseoSessionEnvironment({ ...f.options, request: { ...f.request, cwd: linked } }), error => error.statusCode === 400 && /Links and special files/.test(error.message));
});

test("Official profile copies only private regular credential files into its isolated generation", async t => {
  const f = await setup(t, { mode: "official", apiKey: undefined });
  const auth = path.join(f.directory, "native-auth");
  await fs.mkdir(auth);
  await fs.writeFile(path.join(auth, "auth.json"), '{"fixture":"official-secret"}');
  await fs.writeFile(path.join(auth, "config.toml"), "private user preference");
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = auth;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const opened = await paseoSessionEnvironment({ ...f.options, request: f.request });
  assert.equal(opened.env.OPENAI_API_KEY, undefined);
  assert.equal((await fs.stat(path.join(opened.env.CODEX_HOME, "auth.json"))).mode & 0o077, 0);
  assert.deepEqual(await fs.readdir(opened.env.CODEX_HOME), [".frame-auth-generation", "auth.json"]);
  assert.equal(await fs.readFile(path.join(opened.env.CODEX_HOME, "auth.json"), "utf8"), '{"fixture":"official-secret"}');
  f.setConfig({ auth_generation: "3" });
  await fs.rm(path.join(auth, "auth.json"));
  await fs.symlink(path.join(auth, "config.toml"), path.join(auth, "auth.json"));
  await assert.rejects(paseoSessionEnvironment({ ...f.options, request: { ...f.request, agentId: "new-agent" } }), /credential file is invalid/);
});


test("All native agents map to the authoritative checkout and historical worktrees are rejected", async t => {
  const f = await setup(t), manager = f.options.manager, root = f.prepared.workspace.workspaceRoot;
  const nested = path.join(root, "projects/fixture");
  const local = await manager.resolveAgentWorkspace(f.work.id, nested);
  assert.equal(local.checkoutRoot, root); assert.equal(local.hostCwd, nested);
  const credential = await manager.agentCredential(f.work.id, "native-agent");
  f.setAgent({ id: "native-agent", status: "running", cwd: nested });
  assert.equal((await manager.agentContext(credential)).runRoot, root);
  await assert.rejects(manager.resolveAgentWorkspace(f.work.id, path.join(f.prepared.workspace.base, "home/.paseo/worktrees/project-hash/native-tree")), error => error.statusCode === 403);
  manager.localMode = false;
  const linux = await manager.resolveAgentWorkspace(f.work.id, "/workspace/projects/fixture");
  assert.equal(linux.hostCwd, nested); assert.equal(linux.checkoutRoot, root);
  await assert.rejects(manager.resolveAgentWorkspace(f.work.id, "/paseo-home/.paseo/worktrees/project-hash/native-tree"), error => error.statusCode === 403);
});

test("Selected desktop official CLI environment is session-only, provider-specific and identity-frozen", async t => {
  const f = await setup(t, { mode: "official", apiKey: undefined });
  const names = ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  } });
  process.env.CODEX_API_KEY = "desktop-codex-fixture";
  delete process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = "https://desktop-fixture.invalid/v1";
  process.env.ANTHROPIC_API_KEY = "another-provider-fixture";
  process.env.ANTHROPIC_AUTH_TOKEN = "another-auth-fixture";
  const response = await paseoSessionEnvironment({ ...f.options, request: f.request });
  assert.equal(response.env.CODEX_API_KEY, "desktop-codex-fixture");
  assert.equal(response.env.OPENAI_BASE_URL, "https://desktop-fixture.invalid/v1");
  assert.equal(response.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(response.env.ANTHROPIC_AUTH_TOKEN, undefined);
  const record = await fs.readFile(path.join(f.data, "paseo", f.work.id, "launches/agent-a.json"), "utf8");
  assert.equal(record.includes("desktop-codex-fixture"), false);
  assert.match(JSON.parse(record).localAuthIdentity, /^[a-f0-9]{64}$/);
  f.setAgent({ id: "agent-a", provider: f.request.provider, cwd: f.request.cwd, model: "model-a" });
  await paseoSessionEnvironment({ ...f.options, request: { ...f.request, reason: "resume" } });
  process.env.CODEX_API_KEY = "rotated-desktop-fixture";
  await assert.rejects(paseoSessionEnvironment({ ...f.options, request: { ...f.request, reason: "refresh" } }),
    error => error.statusCode === 409 && /登录身份已变化/.test(error.message));
});

test("A session follows native catalog models when no FRAME replacements are configured", async t => {
  const f = await setup(t, { model: "", models: [] });
  await paseoSessionEnvironment({ ...f.options, request: f.request });
  f.setAgent({ id: "agent-a", provider: f.request.provider, cwd: f.request.cwd, model: "native-discovered-model" });
  const resumed = await paseoSessionEnvironment({ ...f.options, request: { ...f.request, reason: "resume" } });
  assert.equal(resumed.env.CODEX_API_KEY, "fixture-secret-never-persist");
  const record = JSON.parse(await fs.readFile(path.join(f.data, "paseo", f.work.id, "launches/agent-a.json"), "utf8"));
  assert.equal(record.selection.model, "native-discovered-model");
  f.setConfig({ models: [{ id: "allowed-only", name: "Allowed", enabled: true }], model: "allowed-only" });
  await assert.rejects(paseoSessionEnvironment({ ...f.options, request: { ...f.request, reason: "refresh" } }),
    error => error.statusCode === 400);
});
