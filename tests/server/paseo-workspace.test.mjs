import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fixture, until } from "./paseo-test-fixture.mjs";
import { PaseoWorkspace } from "../../server/paseo-workspace.mjs";
import { treeHash } from "../../server/project-files.mjs";

async function watcher(t) {
  const f = await fixture(t), { workspace } = await f.workService.prepare(f.work.id);
  const native = { state: "ready", activeAgents: [], activeTerminals: 0, pendingPermissions: 0, incomplete: false };
  const counts = { validate: 0 }, errors = [];
  const manager = { ensure: async () => ({ ...workspace, runtimeFingerprint: "d".repeat(64) }), observe: async () => native };
  const validate = async report => { counts.validate++; return { status: "passed", modeFingerprint: report.revision }; };
  const controller = new PaseoWorkspace({ ...f, manager, validate, debounceMs: 30, reconcileMs: 60000,
    onError: (_work, error) => errors.push(error) });
  t.after(() => controller.close());
  await controller.start(f.work.id);
  await until(async () => (await f.store.listValidations(f.work.id, { states: ["passed"] }))[0]);
  counts.validate = 0;
  return { ...f, workspace, controller, manager, native, counts, errors, validate };
}
const latest = async (f, state) => (await f.store.listValidations(f.work.id, { states: [state] }))[0];
test("Debounced editor saves validate the sole source without a candidate, task, copy, apply or container", async t => {
  const f = await watcher(t);
  for (let i = 0; i < 4; i++) await fs.writeFile(path.join(f.canonical, "scene.ts"), "export const editor=" + i + ";");
  await until(async () => { const report = await latest(f, "passed"); return report.generation === "1" ? report : null; });
  assert.equal(f.counts.validate, 1);
  assert.equal((await f.store.getWork(f.work.id)).revision, await treeHash(f.canonical, { includeExecutableMode: true }));
  await assert.rejects(fs.stat(path.join(f.data, "runs")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(f.data, "paseo", f.work.id, "draft")), { code: "ENOENT" });
  assert.equal((await f.db.one("SELECT count(*) AS n FROM tasks")).n, 0);
  assert.deepEqual(f.errors, []);
});
test("Native activity defers costly validation while saved revisions remain visible", async t => {
  const f = await watcher(t); f.native.activeAgents = ["agent"];
  await fs.writeFile(path.join(f.canonical, "scene.ts"), "export const terminal=true;");
  await f.controller.reconcile(f.work.id);
  assert.equal(f.counts.validate, 0);
  assert.equal((await f.store.getWork(f.work.id)).generation, "1");
  f.native.activeAgents = []; f.native.incomplete = true;
  await f.controller.reconcile(f.work.id); assert.equal(f.counts.validate, 0);
  f.native.incomplete = false; await f.controller.reconcile(f.work.id);
  await until(async () => (await latest(f, "passed"))?.generation === "1");
  assert.equal(f.counts.validate, 1);
});
test("Concurrent source changes mark the old report stale and never overwrite the latest edits", async t => {
  const f = await watcher(t);
  let release, first = true;
  const blocked = new Promise(resolve => { release = resolve; });
  f.controller.validate = async report => { const result = await f.validate(report); if (first) { first = false; await blocked; } return result; };
  await fs.writeFile(path.join(f.canonical, "scene.ts"), "export const version=1;");
  await f.controller.reconcile(f.work.id);
  const old = await until(() => latest(f, "running"));
  await fs.writeFile(path.join(f.canonical, "scene.ts"), "export const version=2;");
  await f.controller.reconcile(f.work.id); release();
  await until(async () => (await latest(f, "passed"))?.generation === "2");
  assert.equal((await f.store.getValidation(old.id)).state, "stale");
  assert.match(await fs.readFile(path.join(f.canonical, "scene.ts"), "utf8"), /version=2/);
  assert.equal(f.counts.validate, 2);
});
test("Failed checks preserve source and retry only the current revision", async t => {
  const f = await watcher(t);
  f.controller.validate = async () => { throw Error("Actual runtime failure"); };
  await fs.writeFile(path.join(f.canonical, "scene.ts"), "export const retry=true;");
  await f.controller.reconcile(f.work.id);
  const failed = await until(() => latest(f, "failed"));
  assert.match(await fs.readFile(path.join(f.canonical, "scene.ts"), "utf8"), /retry=true/);
  f.controller.validate = f.validate;
  assert.equal((await f.controller.retry(f.work.id, failed.id)).id, failed.id);
  await until(async () => (await f.store.getValidation(failed.id)).state === "passed");
  await fs.writeFile(path.join(f.canonical, "scene.ts"), "export const changed=true;");
  await f.controller.reconcile(f.work.id);
  await assert.rejects(f.controller.retry(f.work.id, failed.id), /不能重试|已更新/);
});
test("Restored identical source reuses a valid report and updates its generation", async t => {
  const f = await watcher(t), original = await fs.readFile(path.join(f.canonical, "scene.ts"));
  await fs.writeFile(path.join(f.canonical, "scene.ts"), "export const altered=true;");
  await f.controller.reconcile(f.work.id);
  await until(async () => (await latest(f, "passed"))?.generation === "1");
  await fs.writeFile(path.join(f.canonical, "scene.ts"), original);
  await f.controller.reconcile(f.work.id);
  await until(async () => (await latest(f, "passed"))?.generation === "2");
  assert.equal(f.counts.validate, 1);
});


test("API validation only queues the authoritative revision and never starts a privileged worker", async t => {
  const f = await fixture(t), { workspace } = await f.workService.prepare(f.work.id);
  let starts = 0;
  const controller = new PaseoWorkspace({ ...f,
    manager: { ensure: async () => ({ ...workspace, runtimeFingerprint: "d".repeat(64) }), tasks: { lease: { held: false } } },
    validate: async () => { starts++; throw Error("API cannot execute validators"); },
  });
  t.after(() => controller.close());
  const report = await controller.request(f.work.id);
  assert.equal(report.state, "queued");
  assert.equal(report.revision, await treeHash(f.canonical, { includeExecutableMode: true }));
  assert.equal(controller.entries.size, 0); assert.equal(starts, 0);
  await fs.writeFile(path.join(f.canonical, "scene.ts"), "export const changed=true;");
  assert.equal((await controller.request(f.work.id, { wait: true, reportId: report.id })).state, "stale");
});

test("controller validation requests wait for the shared report and cancellation stops only that check", async t => {
  const f = await watcher(t); f.manager.localMode = true;
  await fs.writeFile(path.join(f.canonical, "scene.ts"), "export const request=true;");
  const passed = await f.controller.request(f.work.id, { wait: true });
  assert.equal(passed.state, "passed");
  let signalSeen;
  f.controller.validate = async (_report, { signal }) => {
    signalSeen = signal;
    await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
    });
  };
  await fs.writeFile(path.join(f.canonical, "scene.ts"), "export const cancel=true;");
  const controller = new AbortController(), waiting = f.controller.request(f.work.id, { wait: true, signal: controller.signal });
  const checked = assert.rejects(waiting, /stop requested check/);
  const report = await until(() => latest(f, "running"));
  controller.abort(Error("stop requested check"));
  await checked;
  assert.equal(signalSeen.aborted, true);
  assert.equal((await f.store.getValidation(report.id)).state, "cancelled");
  assert.equal(f.controller.entries.has(f.work.id), true);
  assert.equal(f.controller.entries.get(f.work.id).controller.signal.aborted, false);
});
