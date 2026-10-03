import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { Tasks } from "../../server/tasks.mjs";
import { treeHash } from "../../server/project-files.mjs";
import { cleanOrphanTaskWorkspaces } from "../../server/task-workspace.mjs";
import { runtimeIdentity } from "../../scripts/runtime-identity.mjs";

async function fixture(t) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "frame-export-workspace-"));
  const db = await sqliteDatabase(path.join(data, "frame.sqlite"));
  const repo = randomUUID(), work = randomUUID(), project = "film";
  const source = path.join(data, "canonical", "projects", project);
  await fs.mkdir(path.join(source, "public"), { recursive: true });
  await fs.writeFile(path.join(source, "project.ts"), "version A");
  await fs.writeFile(path.join(source, "public", "original.wav"), "raw audio A");
  await fs.writeFile(path.join(source, "script.sh"), "echo A");
  await fs.chmod(path.join(source, "script.sh"), 0o755);
  await db.pool.query("INSERT INTO repos(id,name) VALUES($1,'Export test')", [repo]);
  await db.pool.query("INSERT INTO works(id,repo,project,title) VALUES($1,$2,$3,'Export test')", [work, repo, project]);
  const state = { image: "sha256:" + "a".repeat(64), running: false, unavailable: false, wrongOwner: false, launched: [], removed: [] };
  const runCommand = async (bin, args) => {
    if (bin !== "docker") return "";
    if (args[0] === "image") return JSON.stringify({ Id: state.image });
    if (args[0] === "run") { state.launched.push(args); return "container-id"; }
    if (args[0] === "inspect") {
      if (state.unavailable) throw Error("Cannot connect to the Docker daemon");
      const id = args.at(-1).replace("frame-task-", "");
      return JSON.stringify({ Name: "/frame-task-" + id, Config: { Labels: { "frame.task": state.wrongOwner ? randomUUID() : id } },
        Mounts: [{ Destination: "/workspace", Source: path.join(data, "runs", id) }], State: { Running: state.running, ExitCode: 0 } });
    }
    if (args[0] === "rm") state.removed.push(args.at(-1));
    return "";
  };
  const repos = { project: async () => ({ dir: source }), checkpoint: async () => "a".repeat(40),
    writable: async () => { throw Error("Frozen export admission must not require an idle work"); } };
  const tasks = new Tasks(db, data, repos, null, { runCommand });
  t.after(async () => { await db.pool.end(); await fs.rm(data, { recursive: true, force: true }); });
  return { data, db, repo, project, source, state, tasks, repos };
}

test("render freezes source, original media, executable mode, runtime and parameters before queue admission", async t => {
  const f = await fixture(t), requestKey = randomUUID(), input = { width: 1280, fps: 24, start: 1, end: 3 };
  const task = await f.tasks.create({ repo: f.repo, project: f.project, kind: "render", input, requestKey });
  assert.equal(task.state, "queued");
  assert.equal(task.frozen.sourceRevision, await treeHash(f.source, { includeExecutableMode: true }));
  assert.equal(task.frozen.image, f.state.image);
  assert.deepEqual(task.frozen.input, input);
  const isolated = path.join(f.data, "runs", task.id, "projects", f.project);
  assert.equal((await fs.stat(path.join(isolated, "script.sh"))).mode & 0o100, 0o100);
  await fs.writeFile(path.join(f.source, "project.ts"), "version B while queued");
  await fs.writeFile(path.join(f.source, "public", "original.wav"), "raw audio B");
  f.state.image = "sha256:" + "b".repeat(64);
  const replay = await f.tasks.create({ repo: f.repo, project: f.project, kind: "render", input, requestKey });
  assert.equal(replay.id, task.id);
  assert.equal((await fs.readdir(path.join(f.data, "runs"))).length, 1);
  // A fresh controller starts the saved job with the exact admission-time input.
  const controller = new Tasks(f.db, f.data, f.repos, null, { runCommand: f.tasks.command });
  await controller.start(await controller.get(task.id));
  assert.equal(await fs.readFile(path.join(isolated, "project.ts"), "utf8"), "version A");
  assert.equal(await fs.readFile(path.join(isolated, "public", "original.wav"), "utf8"), "raw audio A");
  assert(f.state.launched[0].includes(task.frozen.image));
  assert(!f.state.launched[0].includes(f.state.image));
  await f.db.lock(`${f.repo}:${f.project}`, async () => fs.writeFile(path.join(f.source, "project.ts"), "version C while encoding"));
  assert.equal(await fs.readFile(path.join(isolated, "project.ts"), "utf8"), "version A");
});

test("source changes during admission reject the mixed export and remove only its temporary snapshot", async t => {
  const f = await fixture(t);
  f.repos.checkpoint = async () => {
    await fs.writeFile(path.join(f.source, "project.ts"), "concurrent saved change");
    return "b".repeat(40);
  };
  await assert.rejects(f.tasks.create({ repo: f.repo, project: f.project, kind: "render" }), /发生变化/);
  assert.deepEqual(await fs.readdir(path.join(f.data, "runs")), []);
  assert.equal((await f.db.all("SELECT id FROM tasks")).length, 0);
  assert.equal(await fs.readFile(path.join(f.source, "project.ts"), "utf8"), "concurrent saved change");
});

test("successful export preserves downloadable artifacts and exact revision, immediately removes source and encoder caches", async t => {
  const f = await fixture(t);
  let task = await f.tasks.create({ repo: f.repo, project: f.project, kind: "render", input: { width: 1280 } });
  await f.tasks.start(task);
  const run = path.join(f.data, "runs", task.id), exports = path.join(run, "projects", f.project, "exports");
  await fs.mkdir(exports, { recursive: true });
  await fs.writeFile(path.join(exports, "film.mp4"), "completed video bytes");
  await fs.writeFile(path.join(exports, ".encoding.tmp.mp4"), "partial");
  await fs.mkdir(path.join(run, ".cache", "mix"), { recursive: true });
  await fs.writeFile(path.join(run, ".cache", "mix", "audio.wav"), "temporary mix");
  await fs.writeFile(path.join(run, "result.json"), JSON.stringify({ status: "passed" }));
  await f.tasks.complete(await f.tasks.get(task.id), 0);
  task = await f.tasks.get(task.id);
  assert.equal(task.state, "succeeded");
  assert(task.workspace_cleaned);
  assert.equal(task.result.sourceRevision, task.frozen.sourceRevision);
  assert.equal(task.result.artifacts.length, 1);
  assert.match(task.result.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(await fs.readFile(path.join(exports, "film.mp4"), "utf8"), "completed video bytes");
  assert.deepEqual(await fs.readdir(path.join(run, "projects", f.project)), ["exports"]);
  assert.deepEqual((await fs.readdir(run)).sort(), ["projects", "result.json", "task.json", "workspace.json"]);
  assert.deepEqual(f.state.removed, ["frame-task-" + task.id]);
  assert.equal(await fs.readFile(path.join(f.source, "project.ts"), "utf8"), "version A");
});

for (const state of ["failed", "cancelled"]) test(`${state} export discards all source, media, partial output and leaves diagnostics`, async t => {
  const f = await fixture(t);
  const task = await f.tasks.create({ repo: f.repo, project: f.project, kind: "render" });
  const run = path.join(f.data, "runs", task.id);
  await fs.mkdir(path.join(run, "projects", f.project, "exports"), { recursive: true });
  await fs.writeFile(path.join(run, "projects", f.project, "exports", "partial.mp4"), "partial");
  if (state === "cancelled") await f.tasks.cancel(task.id);
  else await f.tasks.failTask(task, "renderer failed");
  const saved = await f.tasks.get(task.id);
  assert.equal(saved.state, state);
  assert(saved.workspace_cleaned);
  await assert.rejects(fs.stat(path.join(run, "projects")), { code: "ENOENT" });
  assert.equal(JSON.parse(await fs.readFile(path.join(run, "task.json"), "utf8")).frozen.sourceRevision, task.frozen.sourceRevision);
});

test("cleanup survives restart and defers running, uncertain or foreign containers until a fresh identity check passes", async t => {
  const f = await fixture(t);
  const task = await f.tasks.create({ repo: f.repo, project: f.project, kind: "render" });
  await f.tasks.start(task);
  await f.db.pool.query("UPDATE tasks SET state='failed' WHERE id=$1", [task.id]);
  const source = path.join(f.data, "runs", task.id, "projects", f.project, "project.ts");
  const restarted = new Tasks(f.db, f.data, f.repos, null, { runCommand: f.tasks.command });
  f.state.running = true;
  assert.equal(await restarted.cleanup(await restarted.get(task.id)), false);
  f.state.running = false; f.state.unavailable = true;
  assert.equal(await restarted.cleanup(await restarted.get(task.id)), false);
  assert.match((await restarted.get(task.id)).cleanup_error, /Docker daemon/);
  f.state.unavailable = false; f.state.wrongOwner = true;
  assert.equal(await restarted.cleanup(await restarted.get(task.id)), false);
  assert.equal(await fs.readFile(source, "utf8"), "version A");
  assert.deepEqual(f.state.removed, []);
  f.state.wrongOwner = false;
  assert.equal(await restarted.cleanup(await restarted.get(task.id)), true);
  assert.equal((await restarted.get(task.id)).cleanup_error, null);
  await assert.rejects(fs.stat(source), { code: "ENOENT" });
});

test("publication recovery retains final output while releasing source and never rereads the current work", async t => {
  const f = await fixture(t);
  const task = await f.tasks.create({ repo: f.repo, project: f.project, kind: "render" });
  await f.tasks.start(task);
  const run = path.join(f.data, "runs", task.id), exports = path.join(run, "projects", f.project, "exports");
  await fs.mkdir(exports, { recursive: true });
  await fs.writeFile(path.join(exports, "film.mp4"), "verified output A");
  await fs.writeFile(path.join(run, "result.json"), JSON.stringify({ status: "passed" }));
  const originalQuery = f.db.pool.query;
  let failSave = true;
  f.db.pool.query = async (sql, params) => {
    if (sql.startsWith("UPDATE tasks SET state='succeeded'") && failSave) { failSave = false; throw Error("temporary database save outage"); }
    return originalQuery(sql, params);
  };
  await f.tasks.complete(await f.tasks.get(task.id), 0);
  let saved = await f.tasks.get(task.id);
  assert.equal(saved.state, "publishing");
  assert(saved.workspace_cleaned);
  await assert.rejects(fs.stat(path.join(run, "projects", f.project, "project.ts")), { code: "ENOENT" });
  await fs.writeFile(path.join(f.source, "project.ts"), "new current version B");
  f.repos.project = () => { throw Error("publication must use retained output, not current work"); };
  const recovered = new Tasks(f.db, f.data, f.repos, null, { runCommand: f.tasks.command });
  await recovered.complete(saved, 0);
  saved = await recovered.get(task.id);
  assert.equal(saved.state, "succeeded");
  assert.equal(saved.result.sourceRevision, task.frozen.sourceRevision);
  assert.equal(await fs.readFile(path.join(exports, "film.mp4"), "utf8"), "verified output A");
  assert.equal(f.state.launched.length, 1);
});

test("timeout cleans frozen files after the executor is confirmed exited", async t => {
  const f = await fixture(t);
  const task = await f.tasks.create({ repo: f.repo, project: f.project, kind: "render" });
  await f.tasks.start(task);
  await f.db.pool.query("UPDATE tasks SET started=$2 WHERE id=$1", [task.id, new Date(Date.now() - 70000000).toISOString()]);
  f.state.running = false;
  // TaskMonitor's observation reads Docker State, whereas cleanup checks full identity.
  const monitorCommand = f.tasks.monitor.command;
  f.tasks.monitor.command = async (bin, args, opts) => args[0] === "inspect" && args.includes("{{json .State}}")
    ? JSON.stringify({ Running: false, ExitCode: 137 }) : monitorCommand(bin, args, opts);
  await f.tasks.observeTask(await f.tasks.get(task.id));
  const saved = await f.tasks.get(task.id);
  assert.equal(saved.state, "failed");
  assert.match(saved.error, /运行时限/);
  assert(saved.workspace_cleaned);
  await assert.rejects(fs.stat(path.join(f.data, "runs", task.id, "projects")), { code: "ENOENT" });
});

test("the unprivileged API accepts exports only with the healthy controller's immutable runtime", async t => {
  const f = await fixture(t), previousRole = process.env.FRAME_ROLE;
  const runtime = { ...(await runtimeIdentity()), image: f.state.image };
  await f.db.setting("controller-runtime", { leader: true, checked: Date.now(), docker: { ok: true },
    runtimeFingerprint: runtime.fingerprint, executorRuntime: runtime });
  process.env.FRAME_ROLE = "api";
  f.tasks.command = () => { throw Error("API must never access Docker"); };
  try {
    const task = await f.tasks.create({ repo: f.repo, project: f.project, kind: "render" });
    assert.equal(task.frozen.image, runtime.image);
    await f.db.setting("controller-runtime", { leader: true, checked: Date.now() - 50000, docker: { ok: true },
      runtimeFingerprint: runtime.fingerprint, executorRuntime: runtime });
    await assert.rejects(f.tasks.create({ repo: f.repo, project: f.project, kind: "render" }), { statusCode: 503 });
    assert.equal((await fs.readdir(path.join(f.data, "runs"))).length, 1);
  } finally {
    if (previousRole === undefined) delete process.env.FRAME_ROLE;
    else process.env.FRAME_ROLE = previousRole;
  }
});

test("daily validation uses the existing canonical runtime and persists the exact report without any snapshot or task container", async t => {
  const f = await fixture(t);
  const task = await f.tasks.create({ repo: f.repo, project: f.project, kind: "validate" });
  const report = { id: randomUUID(), revision: "c".repeat(64), state: "passed", runtimeFingerprint: "runtime",
    result: { validation: [{ check: "project-types", status: "passed" }] } };
  f.tasks.validateWorkspace = async (_task, options) => { await options.onReport(report); return report; };
  await f.tasks.start(task);
  await f.tasks.validations.get(task.id).promise;
  const saved = await f.tasks.get(task.id);
  assert.equal(saved.state, "succeeded");
  assert.equal(saved.result.validationReportId, report.id);
  assert.equal(saved.result.sourceRevision, report.revision);
  assert.equal(saved.container, null);
  assert(saved.workspace_cleaned);
  assert.deepEqual(f.state.launched, []);
  await assert.rejects(fs.stat(path.join(f.data, "runs", task.id)), { code: "ENOENT" });
});

test("validation recovery resumes the recorded report and cancellation does not start an AI/executor environment", async t => {
  const f = await fixture(t);
  const task = await f.tasks.create({ repo: f.repo, project: f.project, kind: "validate" });
  const report = { id: randomUUID(), revision: "d".repeat(64), state: "running", runtimeFingerprint: "runtime" };
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  f.tasks.validateWorkspace = async (_task, options) => {
    await options.onReport(report);
    started();
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  };
  await f.tasks.start(task);
  await startedPromise;
  await f.tasks.close();
  const paused = await f.tasks.get(task.id);
  assert.equal(paused.state, "running");
  assert.equal(paused.result.validationReportId, report.id);
  const restarted = new Tasks(f.db, f.data, f.repos, null, { runCommand: f.tasks.command });
  restarted.validateWorkspace = async (_task, options) => {
    assert.equal(options.reportId, report.id);
    const stale = { ...report, state: "stale", error: "source changed while checking" };
    await options.onReport(stale);
    return stale;
  };
  await restarted.launchValidation(paused);
  const saved = await restarted.get(task.id);
  assert.equal(saved.state, "failed");
  assert.equal(saved.result.validationReportId, report.id);
  assert.equal(saved.error, "source changed while checking");
  assert.deepEqual(f.state.launched, []);
  assert.deepEqual(await fs.readdir(path.join(f.data, "runs")), []);
});

test("cancelling a running canonical validation aborts that report and leaves the work files intact", async t => {
  const f = await fixture(t);
  const task = await f.tasks.create({ repo: f.repo, project: f.project, kind: "validate" });
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  f.tasks.validateWorkspace = async (_task, options) => {
    await options.onReport({ id: randomUUID(), revision: "e".repeat(64), state: "running" });
    started();
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  };
  await f.tasks.start(task);
  const pending = f.tasks.validations.get(task.id).promise;
  await startedPromise;
  await f.tasks.cancel(task.id);
  await pending;
  assert.equal((await f.tasks.get(task.id)).state, "cancelled");
  assert.equal(await fs.readFile(path.join(f.source, "project.ts"), "utf8"), "version A");
  assert.deepEqual(f.state.launched, []);
});

test("orphan admission cleanup requires its exact journal and leaves retained and unrelated runs intact", async t => {
  const f = await fixture(t), orphan = randomUUID(), unrelated = randomUUID();
  const task = await f.tasks.create({ repo: f.repo, project: f.project, kind: "render" });
  for (const id of [orphan, unrelated]) await fs.mkdir(path.join(f.data, "runs", id), { recursive: true });
  await fs.writeFile(path.join(f.data, "runs", orphan, "workspace.json"), JSON.stringify({ id: orphan, kind: "render" }));
  await cleanOrphanTaskWorkspaces({ data: f.data, db: f.db, now: Date.now() + 700000 });
  assert.deepEqual((await fs.readdir(path.join(f.data, "runs"))).sort(), [task.id, unrelated].sort());
});
