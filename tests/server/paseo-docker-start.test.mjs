import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PaseoManager } from "../../server/paseo-manager.mjs";
import { paseoCallbackUrl, paseoDaemonOptions, paseoUnavailable, inspectPaseoContainer } from "../../server/paseo-runtime-options.mjs";
import { operationError } from "../../src/contracts/errors.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function fakeManager({ count = 1, prepare, runCommand, tasks } = {}) {
  const rows = Array.from({ length: count }, () => ({ workId: randomUUID(), state: "cold", requested: true,
    daemonGeneration: "0", endpoint: null, container: null, error: null }));
  const updates = [], commands = [], logs = [];
  const store = {
    getWork: async id => rows.find(row => row.workId === id),
    listWorks: async () => rows,
    listValidations: async () => [],
    updateRuntime: async (id, patch, { expectedDaemonGeneration } = {}) => {
      const row = rows.find(row => row.workId === id);
      if (expectedDaemonGeneration != null && row.daemonGeneration !== expectedDaemonGeneration) return null;
      updates.push({ id, patch, expectedDaemonGeneration }); Object.assign(row, patch); return row;
    },
    requestWork: async () => {},
  };
  const workService = {
    works: { get: async id => ({ id }) },
    resolve: async () => null,
    prepare: prepare || (async id => ({ work: { id }, workspace: {} })),
  };
  const manager = new PaseoManager({ store, workService, data: "/unused", localMode: false,
    tasks: tasks || { assertLeadership: async () => {} }, connections: { list: async () => [] },
    db: { lock: async (_key, fn) => fn(), setting: async () => null, pool: { query: async (...args) => logs.push(args) } },
    runCommand: async (...args) => { commands.push(args); return runCommand ? runCommand(...args) : ""; },
  });
  return { manager, rows, updates, commands, logs };
}

test("Managed Docker Host policy preserves native daemon options and callback origin has exact deployment/local fallbacks", () => {
  const options = { hostnames: ["old.invalid"], listen: "custom:1234", relay: { enabled: true, url: "https://relay.invalid" }, arbitraryNativeOption: 42 };
  assert.deepEqual(paseoDaemonOptions(options), { ...options, hostnames: true, relay: { enabled: false, url: "https://relay.invalid" } });
  assert.deepEqual(options.hostnames, ["old.invalid"], "Native input configuration must not be mutated");
  const id = randomUUID(), path = "/api/paseo/internal/" + id;
  assert.equal(paseoCallbackUrl(id, { env: {} }), "http://studio:3000" + path);
  assert.equal(paseoCallbackUrl(id, { env: { FRAME_AGENT_URL: "http://controller-api:3000/", FRAME_PUBLIC_URL: "https://public.invalid" } }), "http://controller-api:3000" + path);
  assert.equal(paseoCallbackUrl(id, { env: { FRAME_PUBLIC_URL: "https://public.invalid/frame/" } }), "https://public.invalid/frame" + path);
  assert.equal(paseoCallbackUrl(id, { localMode: true, env: {} }), "http://127.0.0.1:3000" + path);
  assert.equal(paseoCallbackUrl(id, { localMode: true, env: { PORT: "43180" } }), "http://127.0.0.1:43180" + path);
  assert.equal(paseoCallbackUrl(id, { localMode: true, env: { FRAME_PUBLIC_URL: "http://127.0.0.1:43173" } }), "http://127.0.0.1:43173" + path);
  for (const base of ["not a URL", "file:///tmp/file", "http://user:password@studio:3000", "http://studio:3000?token=secret", "http://studio:3000#x"])
    assert.throws(() => paseoCallbackUrl(id, { env: { FRAME_AGENT_URL: base } }), /Configure|HTTP/);
});

test("Public startup failures expose finite stage and retry guidance, never raw native output", async () => {
  const detail = "Paseo startup (runtime): password=private-native-secret /private/fs docker output";
  const failure = operationError(paseoUnavailable("failed", detail));
  assert.equal(failure.status, 503);
  assert.equal(failure.code, "PASEO_START_FAILED");
  assert.equal(failure.retryable, true);
  assert.match(failure.error, /运行环境检查/);
  assert.equal(JSON.stringify(failure).includes("private-native-secret"), false);
  assert.equal(JSON.stringify(failure).includes("/private/fs"), false);
  assert.equal(operationError(paseoUnavailable("waiting")).code, "PASEO_START_WAITING");
  const f = fakeManager();
  Object.assign(f.rows[0], { state: "failed", error: detail });
  await assert.rejects(f.manager.ensure(f.rows[0].workId), error =>
    operationError(error).error === failure.error && error.expose === true);
});

test("Preparation failures at generation zero are recorded safely and do not mutate a container", async t => {
  const secret = "private-environment-secret-123456789";
  const old = process.env.FRAME_TEST_TOKEN;
  process.env.FRAME_TEST_TOKEN = secret;
  t.after(() => { if (old === undefined) delete process.env.FRAME_TEST_TOKEN; else process.env.FRAME_TEST_TOKEN = old; });
  const messages = [];
  t.mock.method(console, "error", (...args) => messages.push(args.join(" ")));
  const f = fakeManager({ prepare: async () => { throw Error("prepare failed: " + secret); } });
  await assert.rejects(f.manager.start(f.rows[0].workId), /prepare failed/);
  assert.equal(f.rows[0].state, "failed");
  assert.equal(f.rows[0].daemonGeneration, "0");
  assert.match(f.rows[0].error, /^Paseo startup \(prepare\):/);
  assert.match(f.rows[0].error, /redacted/);
  assert.equal(JSON.stringify(messages).includes(secret), false);
  assert.equal(f.commands.length, 0);
  assert.equal(f.manager.starting.size, 0);
});

test("A transient repository lock conflict leaves startup retryable without a failed generation or container cleanup", async () => {
  const busy = Object.assign(Error("Repository is busy"), { statusCode: 409 });
  const f = fakeManager({ prepare: async () => { throw busy; } });
  await assert.rejects(f.manager.start(f.rows[0].workId), error => error === busy);
  assert.equal(f.rows[0].state, "cold");
  assert.equal(f.rows[0].daemonGeneration, "0");
  assert.equal(f.updates.length, 0);
  assert.equal(f.commands.length, 0);
  assert.equal(f.manager.starting.size, 0);
});

test("Healthy ready startup checks the native daemon before any workspace preparation", async () => {
  const f = fakeManager({ prepare: async () => { throw Object.assign(Error("Repository is busy"), { statusCode: 409 }); } });
  Object.assign(f.rows[0], { state: "ready", daemonGeneration: "7", endpoint: "http://owned.invalid", workspaceId: "workspace", serverId: "server" });
  let observed = 0;
  f.manager.resumeSharedSpeech = async () => {};
  f.manager.observe = async () => { observed++; return { state: "ready" }; };
  const ready = await Promise.all(Array.from({ length: 12 }, () => f.manager.start(f.rows[0].workId)));
  assert.equal(observed, 1);
  assert(ready.every(binding => binding === f.rows[0]));
  assert.equal(f.updates.length, 0);
  assert.equal(f.commands.length, 0);
});

test("Source reconciliation errors do not invalidate or disconnect a healthy ready daemon", async t => {
  t.mock.method(console, "error", () => {});
  const { runtimeIdentity } = await import("../../scripts/runtime-identity.mjs");
  for (const error of [Object.assign(Error("Repository is busy"), { statusCode: 409 }), Error("Owned source check failure")]) {
    const f = fakeManager();
    Object.assign(f.rows[0], { state: "ready", daemonGeneration: "9", endpoint: "http://owned.invalid", requested: true,
      runtimeFingerprint: (await runtimeIdentity()).fingerprint, touched: new Date().toISOString() });
    let disconnected = 0;
    f.manager.resumeSharedSpeech = async () => {};
    f.manager.syncProfiles = async () => {};
    f.manager.observe = async () => ({ state: "ready", activeAgents: [], activeTerminals: 0, pendingPermissions: 0, incomplete: false });
    f.manager.onReconcile = async () => { throw error; };
    f.manager.dropClient = async () => { disconnected++; };
    await f.manager.tick();
    assert.equal(f.rows[0].state, "ready");
    assert.equal(f.rows[0].daemonGeneration, "9");
    assert.equal(f.updates.length, 0);
    assert.equal(f.commands.length, 0);
    assert.equal(disconnected, 0);
  }
});

test("Provider configuration and validation metadata errors retain ready state while native RPC failures invalidate it", async t => {
  t.mock.method(console, "error", () => {});
  for (const failure of ["workMetadata", "profiles", "syncProfiles", "listValidations", "observationPersistence", "nativeRpc"]) {
    const f = fakeManager();
    Object.assign(f.rows[0], { state: "ready", daemonGeneration: "4", endpoint: "http://owned.invalid", touched: new Date().toISOString() });
    let disconnected = 0;
    const ownError = () => { throw Error("Owned " + failure + " failure"); };
    f.manager.resumeSharedSpeech = async () => {};
    f.manager.syncProfiles = async () => {};
    f.manager.client = async () => ({ fetchAgents: async () => ({ entries: [], pageInfo: {} }),
      listTerminals: async () => ({ terminals: [] }), scheduleList: async () => ({ schedules: [] }) });
    f.manager.dropClient = async () => { disconnected++; };
    if (failure === "workMetadata") f.manager.workService.works.get = async () => ownError();
    if (failure === "profiles") f.manager.profiles = async () => ownError();
    if (failure === "syncProfiles") f.manager.syncProfiles = async () => ownError();
    if (failure === "listValidations") f.manager.store.listValidations = async () => ownError();
    if (failure === "nativeRpc") f.manager.client = async () => ownError();
    if (failure === "observationPersistence") {
      const save = f.manager.store.updateRuntime;
      f.manager.store.updateRuntime = async (id, patch, options) => patch.lastObserved ? ownError() : save(id, patch, options);
    }
    await f.manager.tick();
    assert.equal(f.rows[0].state, failure === "nativeRpc" ? "failed" : "ready", failure);
    assert.equal(disconnected, failure === "nativeRpc" ? 1 : 0, failure);
  }
});

test("Idle eviction rechecks the current generation and last open time before stopping a scanned work", async t => {
  t.mock.method(console, "error", () => {});
  const { runtimeIdentity } = await import("../../scripts/runtime-identity.mjs");
  for (const change of ["touched", "daemonGeneration"]) {
    const f = fakeManager();
    Object.assign(f.rows[0], { state: "ready", daemonGeneration: "5", endpoint: "http://owned.invalid",
      runtimeFingerprint: (await runtimeIdentity()).fingerprint, touched: new Date(0).toISOString() });
    // SQL list rows are a snapshot, whereas stop must read the current binding.
    f.manager.store.listWorks = async () => f.rows.map(row => ({ ...row }));
    f.manager.resumeSharedSpeech = async () => {};
    f.manager.syncProfiles = async () => {};
    f.manager.observe = async () => {
      f.rows[0][change] = change === "touched" ? new Date().toISOString() : "6";
      return { activeAgents: [], activeTerminals: 0, pendingPermissions: 0, incomplete: false };
    };
    await f.manager.tick();
    assert.equal(f.rows[0].state, "ready", change);
    assert.equal(f.commands.length, 0, change);
    assert.equal(f.updates.length, 0, change);
  }
});

test("Runtime inspection failure is generation-fenced before launch and no longer leaves an unexplained cold binding", async t => {
  t.mock.method(console, "error", () => {});
  const f = fakeManager({ runCommand: async () => { throw Error("Owned runtime inspection failure"); } });
  await assert.rejects(f.manager.start(f.rows[0].workId), /runtime inspection failure/);
  assert.equal(f.rows[0].state, "failed");
  assert.equal(f.rows[0].daemonGeneration, "0");
  assert.match(f.rows[0].error, /^Paseo startup \(runtime\):/);
  assert.deepEqual(f.commands.map(([, args]) => args.slice(0, 2)), [["image", "inspect"]]);
});

test("Lost leadership and superseded preparation do not write failures or issue container mutations", async () => {
  for (const superseded of [false, true]) {
    const gate = deferred();
    let owned = true;
    const f = fakeManager({ prepare: async id => { await gate.promise; throw Error("Late preparation failure"); },
      tasks: { assertLeadership: async () => { if (!owned) throw Object.assign(Error("Lease lost"), { leadershipLost: true }); } } });
    const opening = f.manager.start(f.rows[0].workId);
    await turn();
    if (superseded) f.rows[0] = { ...f.rows[0], state: "ready", daemonGeneration: "8", serverId: "new-controller" };
    else owned = false;
    gate.resolve();
    await assert.rejects(opening, superseded ? /Late preparation failure/ : error => error.leadershipLost === true);
    assert.equal(f.updates.length, 0);
    assert.equal(f.commands.length, 0);
    assert.equal(f.rows[0].state, superseded ? "ready" : "cold");
  }
});

test("Startup reservations bound actual concurrent work locks to two and deduplicate one work", async () => {
  const f = fakeManager({ count: 5 });
  const gates = f.rows.map(() => deferred()), calls = [], locks = [];
  let active = 0, max = 0;
  f.manager.db.lock = async (key, callback) => { locks.push(key); return callback(); };
  f.manager.startLocked = async id => {
    calls.push(id); active++; max = Math.max(max, active);
    try { await gates[f.rows.findIndex(row => row.workId === id)].promise; }
    finally { active--; }
  };
  const pending = f.rows.map(row => f.manager.start(row.workId));
  pending.push(f.manager.start(f.rows[0].workId));
  await turn();
  assert.equal(active, 2); assert.equal(calls.length, 2); assert.equal(locks.length, 2);
  for (let i = 0; i < gates.length; i++) { gates[i].resolve(); await turn(); }
  await Promise.all(pending);
  assert.equal(max, 2);
  assert.equal(calls.length, 5);
  assert.equal(new Set(locks).size, 5);
  assert.equal(f.manager.runningStarts, 0);
  assert.equal(f.manager.starting.size, 0);
});

test("A controller scan schedules only two starts without blocking stop requests, or rereading provider profiles per work", async t => {
  const f = fakeManager({ count: 6 }), gates = new Map(), calls = [];
  let profileReads = 0;
  f.manager.profiles = async () => { profileReads++; return {}; };
  f.manager.startLocked = async (id, profiles) => {
    assert.deepEqual(await profiles, {});
    calls.push(id);
    const gate = deferred(); gates.set(id, gate); await gate.promise;
    Object.assign(f.rows.find(row => row.workId === id), { state: "failed" });
  };
  const stopped = { workId: randomUUID(), state: "starting", daemonGeneration: "4" };
  f.rows.push(stopped);
  f.manager.db.setting = async key => key.endsWith(stopped.workId) ? { generation: "4" } : null;
  f.manager.stop = async id => { assert.equal(id, stopped.workId); stopped.state = "stopped"; };
  t.after(async () => { for (const gate of gates.values()) gate.resolve(); await f.manager.close(); });
  await Promise.race([f.manager.tick(), new Promise((_, reject) => setTimeout(() => reject(Error("Tick waited for a daemon startup")), 2000).unref())]);
  await turn();
  assert.equal(stopped.state, "stopped");
  assert.equal(calls.length, 2);
  assert.equal(profileReads, 1);
  await f.manager.tick();
  assert.equal(calls.length, 2, "A later scan must not launch duplicates or exceed the two slots");
  for (let batch = 0; batch < 3; batch++) {
    for (const gate of gates.values()) gate.resolve();
    await turn(); await f.manager.tick(); await turn();
  }
  for (const gate of gates.values()) gate.resolve();
  await turn();
  assert.equal(new Set(calls).size, 6);
});

test("Closing a manager rejects queued starts without launching extra work or leaking reservations", async () => {
  const f = fakeManager({ count: 4 }), gate = deferred();
  let calls = 0;
  f.manager.startLocked = async () => { calls++; await gate.promise; };
  const pending = f.rows.map(row => f.manager.start(row.workId).then(() => "ok", error => error.leadershipLost ? "closed" : Promise.reject(error)));
  await turn();
  f.manager.beginClose();
  gate.resolve();
  assert.deepEqual(await Promise.all(pending), ["ok", "ok", "closed", "closed"]);
  assert.equal(calls, 2); assert.equal(f.manager.runningStarts, 0);
});

async function fakeDockerLaunch(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "frame-paseo-docker-start-"));
  const f = fakeManager();
  f.manager.data = directory;
  const id = f.rows[0].workId, base = path.join(directory, "paseo", id);
  const home = path.join(base, "home/.paseo");
  await fs.mkdir(home, { recursive: true });
  const original = { daemon: { listen: "custom-native", hostnames: ["native.invalid"], relay: { customNative: true } },
    providers: { customNativeSpeech: { modelsDir: "/custom/models" } },
    agents: { providers: { personal: { extends: "claude", label: "Personal" }, "frame-old": { extends: "codex" } } },
    plugins: { personalPlugin: { enabled: true } } };
  await fs.writeFile(path.join(home, "config.json"), JSON.stringify(original));
  const capability = "private-work-capability-12345678901234567890";
  f.manager.workService.prepare = async () => ({ work: { id }, workspace: { base, workspaceRoot: path.join(directory, "works", id) } });
  f.manager.prepareRuntime = async () => ({ gitCommon: path.join(directory, "repos", "fixture", ".git") });
  f.manager.sharedSpeechRoot = async () => { await fs.mkdir(path.join(directory, "paseo-models")); return path.join(directory, "paseo-models"); };
  f.manager.control = async () => ({ version: 1, workId: id, capability });
  f.manager.host = relative => path.join(directory, relative);
  f.manager.network = async () => "owned-fixture-network";
  f.manager.startTimeoutMs = 20;
  f.manager.runCommand = async (bin, args) => {
    f.commands.push([bin, args]);
    if (args[0] === "image") return JSON.stringify({ Id: "sha256:" + "a".repeat(64), Config: { Labels: {} } });
    if (args[0] === "inspect") throw Error("Error: No such object: frame-paseo-" + id);
    return "owned-test-container";
  };
  t.after(async () => { await f.manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
  t.mock.method(console, "error", (...args) => f.logs.push(args.join(" ")));
  return { ...f, id, home, capability, original };
}

test("Repository layout contention occurs before generation admission and cannot consume a daemon generation", async t => {
  const f = await fakeDockerLaunch(t);
  const busy = Object.assign(Error("Repository is busy"), { statusCode: 409 });
  f.manager.prepareRuntime = async () => { throw busy; };
  await assert.rejects(f.manager.start(f.id), error => error === busy);
  assert.equal(f.rows[0].state, "cold");
  assert.equal(f.rows[0].daemonGeneration, "0");
  assert.equal(f.updates.length, 0);
  assert.equal(f.commands.filter(([, args]) => args[0] === "run").length, 0);
});

test("Stop during repository preparation prevents subsequent generation admission or launch", async t => {
  const f = await fakeDockerLaunch(t), begun = deferred(), release = deferred();
  f.manager.prepareRuntime = async () => { begun.resolve(); await release.promise; return { gitCommon: "/unused/.git" }; };
  const starting = f.manager.start(f.id);
  await begun.promise;
  await f.manager.stop(f.id);
  release.resolve();
  await assert.rejects(starting, error => error.paseoStartupSuperseded === true);
  assert.equal(f.rows[0].state, "stopped");
  assert.equal(f.rows[0].requested, false);
  assert.equal(f.rows[0].daemonGeneration, "1");
  assert.equal(f.updates.some(({ patch }) => patch.state === "starting" || patch.state === "failed"), false);
  assert.equal(f.commands.filter(([, args]) => args[0] === "run").length, 0);
});

test("Short runtime preparation queues serialize only the same repository and release failed predecessors", async () => {
  const f = fakeManager(), blocked = deferred(), entered = deferred();
  const calls = [], active = new Map(), max = new Map();
  f.manager.prepareRuntimeLocked = async (_root, work) => {
    calls.push(work.id);
    active.set(work.repo, (active.get(work.repo) || 0) + 1);
    max.set(work.repo, Math.max(max.get(work.repo) || 0, active.get(work.repo)));
    try {
      if (work.id === "first") { entered.resolve(); await blocked.promise; throw Error("Owned preparation failure"); }
      return work.id;
    } finally { active.set(work.repo, active.get(work.repo) - 1); }
  };
  const first = f.manager.prepareRuntime("/unused", { id: "first", repo: "shared" }, {}).catch(error => error.message);
  await entered.promise;
  const second = f.manager.prepareRuntime("/unused", { id: "second", repo: "shared" }, {});
  const third = f.manager.prepareRuntime("/unused", { id: "third", repo: "shared" }, {});
  assert.equal(await f.manager.prepareRuntime("/unused", { id: "other", repo: "independent" }, {}), "other");
  assert.deepEqual(calls, ["first", "other"]);
  blocked.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), ["Owned preparation failure", "second", "third"]);
  assert.equal(max.get("shared"), 1);
  assert.equal(f.manager.runtimePreparations.size, 0);
});

test("Initial native RPC retry completes before ready is published and keeps generation one", async t => {
  const f = await fakeDockerLaunch(t), checking = deferred(), release = deferred();
  let observations = 0, closed = 0;
  f.manager.startTimeoutMs = 5000;
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, body: { cancel: async () => {} } }));
  f.manager.clientFactory = async () => ({ connect: async () => {}, close: async () => { closed++; },
    openProject: async () => ({ workspace: { id: "owned-workspace" } }),
    getLastServerInfoMessage: () => ({ serverId: "owned-server" }),
    fetchAgents: async () => {
      if (++observations === 1) throw Error("Owned transient initial RPC error");
      checking.resolve(); await release.promise;
      return { entries: [], pageInfo: { hasMore: false } };
    }, listTerminals: async () => ({ terminals: [] }), scheduleList: async () => ({ schedules: [] }),
  });
  const starting = f.manager.start(f.id);
  await checking.promise;
  assert.equal(f.rows[0].state, "starting");
  assert.equal(f.rows[0].daemonGeneration, "1");
  assert.equal(f.updates.some(({ patch }) => patch.state === "ready" || patch.state === "failed"), false);
  release.resolve(); await starting;
  assert.equal(f.rows[0].state, "ready");
  assert.equal(f.rows[0].daemonGeneration, "1");
  assert.equal(f.rows[0].nativeSummary.incomplete, false);
  assert.equal(f.updates.filter(({ patch }) => patch.state === "ready").length, 1);
  assert.equal(f.commands.filter(([, args]) => args[0] === "run").length, 1);
  assert.equal(closed, 1);
});

test("The actual manager launch writes Host policy, keeps native settings, injects private callback/shared RO mounts and records health HTTP status", async t => {
  const f = await fakeDockerLaunch(t), requests = [];
  let now = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push([url, options]); now = 5000;
    return { ok: false, status: 403, body: { cancel: async () => {} } };
  });
  await assert.rejects(f.manager.start(f.id), /health HTTP 403/);
  const config = JSON.parse(await fs.readFile(path.join(f.home, "config.json"), "utf8"));
  assert.equal(config.daemon.hostnames, true);
  assert.equal(config.daemon.listen, "custom-native");
  assert.equal(config.daemon.relay.customNative, true);
  assert.equal(config.daemon.relay.enabled, false);
  assert.deepEqual(config.providers, f.original.providers);
  assert.deepEqual(config.agents.providers.personal, f.original.agents.providers.personal);
  assert.equal(config.agents.providers["frame-old"], undefined);
  assert.deepEqual(config.plugins.personalPlugin, f.original.plugins.personalPlugin);
  const launch = f.commands.find(([bin, args]) => bin === "docker" && args[0] === "run")[1];
  assert.ok(launch.includes("FRAME_PASEO_URL=http://studio:3000/api/paseo/internal/" + f.id));
  assert.ok(launch.includes("FRAME_SHARED_RUNTIME_ROOT=/opt/frame"));
  assert.ok(launch.includes("FRAME_SHARED_RUNTIME_FINGERPRINT=" + f.rows[0].runtimeFingerprint));
  assert.ok(launch.includes("FRAME_PASEO_SHARED_MODELS=/paseo-models"));
  assert.ok(launch.includes("FRAME_PASEO_SHARED_MODELS_READONLY=1"));
  assert.ok(launch.some(arg => arg.endsWith("paseo-models,target=/paseo-models,readonly")));
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1].headers.Authorization, "Bearer " + f.capability);
  assert.equal(f.rows[0].state, "failed");
  assert.match(f.rows[0].error, /^Paseo startup \(health\):.*HTTP 403/);
  assert.equal(f.rows[0].container, null);
  assert.equal(JSON.stringify(f.logs).includes(f.capability), false);
});

test("Lost lease during health leaves the generation for the next controller and performs no cleanup or failed-state write", async t => {
  const f = await fakeDockerLaunch(t);
  let owned = true, cleanup = 0;
  f.manager.tasks.assertLeadership = async () => { if (!owned) throw Object.assign(Error("Lease lost"), { leadershipLost: true }); };
  f.manager.cleanupFailedStart = async () => { cleanup++; };
  t.mock.method(globalThis, "fetch", async () => {
    owned = false;
    return { ok: true, status: 200, body: { cancel: async () => {} } };
  });
  await assert.rejects(f.manager.start(f.id), error => error.leadershipLost === true);
  assert.equal(f.rows[0].state, "starting");
  assert.equal(f.rows[0].daemonGeneration, "1");
  assert.equal(cleanup, 0);
  assert.equal(f.updates.some(({ patch }) => patch.state === "failed"), false);
  assert.equal(f.commands.some(([, args]) => ["stop", "rm"].includes(args[0])), false);
});

test("SDK failure redacts work capability while cleanup failure retains the container identity for recovery", async t => {
  const f = await fakeDockerLaunch(t);
  let now = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, body: { cancel: async () => {} } }));
  f.manager.client = async () => ({ openProject: async () => { now = 5000; throw Error("Native SDK Bearer " + f.capability); } });
  f.manager.cleanupFailedStart = async () => { throw Error("Owned cleanup unavailable"); };
  await assert.rejects(f.manager.start(f.id), /Native SDK/);
  assert.equal(f.rows[0].state, "failed");
  assert.equal(f.rows[0].container, "frame-paseo-" + f.id);
  assert.equal(f.rows[0].endpoint, "http://frame-paseo-" + f.id + ":6767");
  assert.match(f.rows[0].error, /^Paseo startup \(registration\):/);
  assert.equal(f.rows[0].error.includes(f.capability), false);
  assert.equal(JSON.stringify(f.logs).includes(f.capability), false);
});

test("Closing manager cancels exactly its shared speech factory once and awaits its downloader", async () => {
  const f = fakeManager(), gate = deferred();
  let calls = 0, finished = false;
  f.manager.speechModelsPromise = Promise.resolve({ close: async () => { calls++; await gate.promise; finished = true; } });
  f.manager.beginClose();
  const closing = f.manager.close();
  await turn();
  assert.equal(calls, 1);
  assert.equal(finished, false);
  gate.resolve(); await closing;
  assert.equal(finished, true);
});

test("Docker inspection recognizes only exact official not-found diagnostics and rejects unavailable/malformed/foreign responses", async () => {
  const name = "frame-paseo-" + randomUUID();
  for (const text of ["Error: No such object: " + name, "Error response from daemon: No such container: " + name])
    assert.equal(await inspectPaseoContainer(async () => { throw Error(text); }, name), null);
  for (const text of ["permission denied", "Cannot connect to the Docker daemon", "docker inspect timed out",
    "Error: No such object: " + name + "-foreign", "prefix Error: No such object: " + name,
    "Error: No such object: " + name + "\npermission denied"])
    await assert.rejects(inspectPaseoContainer(async () => { throw Error(text); }, name));
  await assert.rejects(inspectPaseoContainer(async () => "not json", name), SyntaxError);
  for (const response of ["null", "[]", "true", '"not a container"'])
    await assert.rejects(inspectPaseoContainer(async () => response, name), /Invalid Docker/);
  const container = { Id: "owned", State: { Running: true } };
  assert.deepEqual(await inspectPaseoContainer(async () => JSON.stringify(container), name), container);
});

test("Docker inspection failure during cleanup preserves the real binding, whereas exact absence clears it", async t => {
  for (const unavailable of [false, true]) {
    const f = await fakeDockerLaunch(t), originalCommand = f.manager.runCommand;
    let inspections = 0, now = 0;
    const clock = t.mock.method(Date, "now", () => now);
    const fetchMock = t.mock.method(globalThis, "fetch", async () => {
      now = 5000; return { ok: false, status: 503, body: { cancel: async () => {} } };
    });
    f.manager.runCommand = async (bin, args) => {
      if (args[0] === "inspect" && ++inspections === 2 && unavailable) throw Error("Owned Docker permission denied");
      return originalCommand(bin, args);
    };
    await assert.rejects(f.manager.start(f.id), /HTTP 503/);
    assert.equal(f.rows[0].state, "failed");
    assert.equal(f.rows[0].container, unavailable ? "frame-paseo-" + f.id : null);
    assert.equal(f.rows[0].endpoint, unavailable ? "http://frame-paseo-" + f.id + ":6767" : null);
    if (unavailable) assert.ok(f.logs.some(message => message.includes("Owned Docker permission denied")));
    fetchMock.mock.restore(); clock.mock.restore();
  }
});

test("Cleanup never removes a foreign work or newer daemon generation or clears its binding", async t => {
  const f = await fakeDockerLaunch(t), originalCommand = f.manager.runCommand;
  let inspections = 0, now = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => {
    now = 5000; return { ok: false, status: 503, body: { cancel: async () => {} } };
  });
  f.manager.runCommand = async (bin, args) => {
    if (args[0] === "inspect" && ++inspections === 2)
      return JSON.stringify({ Config: { Labels: { "frame.paseo.work": f.id, "frame.paseo.generation": "2" } }, State: { Running: true } });
    return originalCommand(bin, args);
  };
  await assert.rejects(f.manager.start(f.id), /HTTP 503/);
  assert.equal(f.rows[0].container, "frame-paseo-" + f.id);
  assert.equal(f.commands.some(([, args]) => ["stop", "rm"].includes(args[0])), false);
  assert.ok(f.logs.some(message => message.includes("identity changed")));
});

test("A ready Docker work retries shared speech once per explicit reopen touch, never on agent events or every controller scan", async t => {
  const f = fakeManager();
  const { runtimeIdentity } = await import("../../scripts/runtime-identity.mjs");
  Object.assign(f.rows[0], { state: "ready", daemonGeneration: "4", touched: new Date().toISOString(),
    updated: "event-1", runtimeFingerprint: (await runtimeIdentity()).fingerprint });
  let resumes = 0;
  f.manager.sharedSpeechRoot = async () => { resumes++; throw Error("Owned failed cache initialization"); };
  f.manager.syncProfiles = async () => {};
  f.manager.observe = async () => ({ activeAgents: [], activeTerminals: 0, pendingPermissions: 0, incomplete: false });
  t.mock.method(console, "error", () => {});
  await f.manager.tick();
  assert.equal(resumes, 1);
  for (let i = 0; i < 3; i++) {
    Object.assign(f.rows[0], { updated: "event-" + i, lastObserved: new Date().toISOString(), nativeSummary: { event: i } });
    await f.manager.tick();
  }
  assert.equal(resumes, 1);
  assert.equal(f.rows[0].state, "ready", "Optional speech preparation cannot take working chat offline");
  f.rows[0].touched = new Date(Date.now() + 1).toISOString(); // The requestWork/reopen contract.
  await f.manager.tick(); await f.manager.tick();
  assert.equal(resumes, 2);
  assert.equal(f.commands.length, 0);
});

test("Local and direct ready startup paths resume shared speech while keeping the daemon generation and native client intact", async () => {
  for (const localMode of [false, true]) {
    const f = fakeManager();
    f.manager.localMode = localMode;
    Object.assign(f.rows[0], { state: "ready", daemonGeneration: "3", touched: "reopen-1" });
    let resumes = 0, observations = 0;
    f.manager.sharedSpeechRoot = async () => { resumes++; return "/owned/shared"; };
    f.manager.observe = async () => { observations++; };
    await f.manager.start(f.rows[0].workId);
    await f.manager.start(f.rows[0].workId);
    assert.equal(resumes, 1); assert.equal(observations, 2);
    f.rows[0].touched = "reopen-2";
    await f.manager.start(f.rows[0].workId);
    assert.equal(resumes, 2);
    assert.equal(f.rows[0].state, "ready");
    assert.equal(f.rows[0].daemonGeneration, "3");
    assert.equal(f.updates.length, 0);
    assert.equal(f.commands.length, 0);
  }
});
