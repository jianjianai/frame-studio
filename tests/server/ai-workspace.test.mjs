import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fixture, until } from "./ai-test-fixture.mjs";
import { AiWorkspace } from "../../server/ai-workspace.mjs";
import { treeHash } from "../../server/project-files.mjs";
import { createServices } from "../../server/services.mjs";
import { sqliteDatabase } from "../../server/sqlite.mjs";

async function watcher(t) {
  const f = await fixture(t), { workspace } = await f.workService.prepare(f.work.id);
  const native = { state: "ready", activeThreads: [], activeTerminals: 0, pendingPermissions: 0, incomplete: false };
  const counts = { validate: 0 }, errors = [];
  const manager = { ensure: async () => ({ ...workspace, runtimeFingerprint: "d".repeat(64) }), observe: async () => native };
  const validate = async report => { counts.validate++; return { status: "passed", modeFingerprint: report.revision }; };
  const controller = new AiWorkspace({ ...f, manager, validate, debounceMs: 30, reconcileMs: 60000,
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
  await assert.rejects(fs.stat(path.join(f.data, "ai", f.work.id, "draft")), { code: "ENOENT" });
  assert.equal((await f.db.one("SELECT count(*) AS n FROM tasks")).n, 0);
  assert.deepEqual(f.errors, []);
});
test("Native activity defers costly validation while saved revisions remain visible", async t => {
  const f = await watcher(t); f.native.activeThreads = ["agent"];
  await fs.writeFile(path.join(f.canonical, "scene.ts"), "export const terminal=true;");
  await f.controller.reconcile(f.work.id);
  assert.equal(f.counts.validate, 0);
  assert.equal((await f.store.getWork(f.work.id)).generation, "1");
  f.native.activeThreads = []; f.native.incomplete = true;
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
  const controller = new AiWorkspace({ ...f,
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

async function scheduledWorks(t, count) {
  let controller;
  t.after(() => controller?.close());
  const f = await fixture(t), root = path.dirname(f.canonical), works = [f.work], sources = new Map([[f.work.id, f.canonical]]);
  for (let index = 1; index < count; index++) {
    const work = { ...f.work, id: randomUUID(), project: "fixture-" + index }, source = path.join(root, work.project);
    await fs.cp(f.canonical, source, { recursive: true });
    await fs.writeFile(path.join(source, "project.ts"), "export default {id:'" + work.project + "',title:'Fixture',duration:2,fps:12,load:()=>import('./scene')};");
    await f.db.pool.query("INSERT INTO works(id,repo,project,title) VALUES($1,$2,$3,'Fixture')", [work.id,work.repo,work.project]);
    works.push(work); sources.set(work.id,source);
  }
  for (const work of works) await f.store.ensureWork({ workId:work.id, repo:work.repo, project:work.project,
    revision:await treeHash(sources.get(work.id), { includeExecutableMode:true }) });
  const native = new Map(works.map(work => [work.id,{ state:"ready",activeThreads:[],activeTerminals:0,pendingPermissions:0,incomplete:false }]));
  const gates = new Map(), calls = [], failures = new Set(), errors = [], cancellations = [];
  let active = 0, peak = 0;
  const manager = { localMode:true, tasks:{ limits:{concurrency:2},lease:{held:true} },
    ensure:async value => ({ projectRoot:sources.get(typeof value === "string" ? value : value.id), runtimeFingerprint:"d".repeat(64) }),
    observe:async id => native.get(id), cancelValidation:async (...args) => cancellations.push(args) };
  controller = new AiWorkspace({ ...f, works:{get:async id => works.find(work => work.id === id)}, manager,
    debounceMs:60000, reconcileMs:60000, onError:(work,error) => errors.push({work,error}),
    validate:async (report,{signal}) => {
      calls.push(report); active++; peak=Math.max(peak,active);
      let abort;
      try {
        if (failures.has(report.workId)) throw Error("Scheduled validator failed");
        await new Promise((resolve,reject) => {
          gates.set(report.workId,{resolve,signal}); abort=() => reject(signal.reason);
          signal.addEventListener("abort",abort,{once:true}); if (signal.aborted) abort();
        });
        return {status:"passed",modeFingerprint:report.revision};
      } finally { signal.removeEventListener("abort",abort); gates.delete(report.workId); active--; }
    },
  });
  const start = async () => { for (const work of works) await controller.start(work.id); await until(() => calls.length === 2); };
  const release = async index => { const gate = await until(() => gates.get(works[index].id)); gate.resolve(); };
  const edit = async (index,text) => { await fs.writeFile(path.join(sources.get(works[index].id),"scene.ts"),text); await controller.reconcile(works[index].id); };
  const report = async (index,state) => (await f.store.listValidations(works[index].id,{states:[state]}))[0];
  return {...f,controller,works,sources,native,calls,failures,errors,cancellations,gates,start,release,edit,report,
    counts:() => ({active,peak})};
}

test("Shared validation uses two FIFO slots, coalesces works and yields changed revisions behind waiting works", async t => {
  const f = await scheduledWorks(t,6); await f.start();
  assert.equal(f.controller.concurrency,2); assert.deepEqual(f.counts(),{active:2,peak:2});
  assert.equal(f.controller.queue.size,4);
  const originalFirst=await f.report(0,"running"), originalThird=await f.report(2,"queued");
  for (let index=2;index<6;index++) assert.ok(await f.report(index,"queued"));
  f.controller.kick(f.works[2].id); f.controller.kick(f.works[2].id);
  await f.edit(0,"export const version='new-active';");
  await f.edit(2,"export const version='latest-waiting';");
  const latestThird=(await f.store.getWork(f.works[2].id)).revision;
  assert.equal(f.controller.queue.size,4,"Repeated requests retain one FIFO entry per waiting work");
  await f.release(0); await until(() => f.calls.length === 3);
  assert.equal(f.calls[2].workId,f.works[2].id); assert.equal(f.calls[2].revision,latestThird);
  assert.equal((await f.store.getValidation(originalFirst.id)).state,"stale");
  assert.equal((await f.store.getValidation(originalThird.id)).state,"stale");
  await f.release(1); await until(() => f.calls.length === 4);
  await f.release(2); await until(() => f.calls.length === 5);
  await f.release(3); await until(() => f.calls.length === 6);
  await f.release(4); await until(() => f.calls.length === 7);
  assert.deepEqual(f.calls.map(report=>report.workId),[...f.works.map(work=>work.id),f.works[0].id]);
  await f.release(5); await f.release(0);
  await until(() => f.controller.activeWorkers === 0 && f.controller.queue.size === 0);
  assert.deepEqual(f.counts(),{active:0,peak:2});
  for (let index=0;index<6;index++) assert.ok(await f.report(index,"passed"));
  assert.deepEqual(f.errors,[]); assert.equal((await f.db.one("SELECT count(*) AS n FROM tasks")).n,0);
});

test("Queued cancellation and stop do not start validators; active stop releases a slot and close aborts only owned checks", async t => {
  const f = await scheduledWorks(t,6); await f.start();
  await f.controller.stop(f.works[2].id);
  assert.equal(f.controller.queue.has(f.works[2].id),false); assert.ok(await f.report(2,"queued"));
  const cancelled=await f.report(3,"queued"), queued=f.controller.queue.get(f.works[3].id), signal=new AbortController();
  const waiting=f.controller.request(f.works[3].id,{wait:true,signal:signal.signal});
  const checked=assert.rejects(waiting,/Queue check cancelled/);
  await until(() => f.controller.queue.get(f.works[3].id) !== queued);
  signal.abort(Error("Queue check cancelled")); await checked;
  assert.equal((await f.store.getValidation(cancelled.id)).state,"cancelled");
  assert.equal(f.controller.queue.has(f.works[3].id),false);
  assert.deepEqual(f.cancellations,[],"A cancelled queued receipt has no native process to stop");
  await f.controller.stop(f.works[0].id); await until(() => f.calls.length === 3);
  assert.equal(f.calls[2].workId,f.works[4].id); assert.equal(f.gates.get(f.works[1].id).signal.aborted,false);
  assert.ok(await f.report(5,"queued"));
  await f.controller.close();
  assert.equal(f.controller.activeWorkers,0); assert.equal(f.controller.queue.size,0); assert.equal(f.controller.entries.size,0);
  assert.deepEqual(f.calls.map(report=>report.workId),[f.works[0].id,f.works[1].id,f.works[4].id]);
  assert.ok(await f.report(0,"cancelled")); assert.ok(await f.report(1,"cancelled")); assert.ok(await f.report(4,"cancelled"));
  assert.ok(await f.report(5,"queued")); assert.deepEqual(f.counts(),{active:0,peak:2}); assert.deepEqual(f.errors,[]);
});

test("A busy waiting work and a failed validator release their slots without blocking later works", async t => {
  const f = await scheduledWorks(t,5); await f.start();
  f.native.get(f.works[2].id).incomplete=true; f.failures.add(f.works[3].id);
  await f.release(0); await until(() => f.gates.has(f.works[4].id));
  assert.deepEqual(f.calls.map(report=>report.workId),[f.works[0].id,f.works[1].id,f.works[3].id,f.works[4].id]);
  assert.ok(await f.report(2,"queued")); assert.ok(await f.report(3,"failed"));
  f.native.get(f.works[2].id).incomplete=false; await f.controller.reconcile(f.works[2].id);
  await f.release(4); await until(() => f.gates.has(f.works[2].id));
  await f.release(1); await f.release(2);
  await until(() => f.controller.activeWorkers === 0 && f.controller.queue.size === 0);
  assert.deepEqual(f.counts(),{active:0,peak:2}); assert.equal(f.errors.length,1);
  assert.match(f.errors[0].error.message,/Scheduled validator failed/);
  for (const index of [0,1,2,4]) assert.ok(await f.report(index,"passed"));
});

test("A running cancellation finishes native cleanup before a retry can reuse its report id", async t => {
  const f = await scheduledWorks(t,3); await f.start();
  const report=await f.report(0,"running"), signal=new AbortController();
  let finishCancellation, cancellationStarted=false;
  f.controller.manager.cancelValidation=async (workId,reportId) => {
    f.cancellations.push([workId,reportId]); cancellationStarted=true;
    await new Promise(resolve => { finishCancellation=resolve; });
  };
  const waiting=f.controller.request(f.works[0].id,{wait:true,signal:signal.signal});
  const checked=assert.rejects(waiting,/Running cancellation race/);
  try {
    await until(() => f.controller.entries.get(f.works[0].id).pending);
    signal.abort(Error("Running cancellation race")); await until(() => cancellationStarted);
    assert.equal((await f.store.getValidation(report.id)).state,"cancelled");
    assert.equal((await f.controller.retry(f.works[0].id,report.id)).id,report.id);
    assert.equal(f.controller.activeWorkers,2,"Native cleanup retains the old attempt's admission slot");
    assert.deepEqual(f.calls.map(row=>row.workId),[f.works[0].id,f.works[1].id]);
    assert.equal(f.gates.get(f.works[1].id).signal.aborted,false);
    await f.release(1); await until(() => f.calls.length === 3);
    assert.equal(f.calls[2].workId,f.works[2].id);
    finishCancellation(); await checked; await until(() => f.calls.length === 4);
    assert.equal(f.calls[3].workId,f.works[0].id); assert.equal(f.calls[3].id,report.id);
    await f.release(2); await f.release(0);
    await until(() => f.controller.activeWorkers === 0);
    assert.deepEqual(f.cancellations,[[f.works[0].id,report.id]]); assert.deepEqual(f.errors,[]);
    assert.equal((await f.store.getValidation(report.id)).state,"passed");
  } finally { finishCancellation?.(); }
});

test("Cancellation during a queued report claim aborts admission before its validator starts", async t => {
  const f = await scheduledWorks(t,3); await f.start();
  const report=await f.report(2,"queued"), queued=f.controller.queue.get(f.works[2].id), signal=new AbortController();
  const update=f.store.updateValidation.bind(f.store);
  let finishClaim, claimStarted=false;
  f.store.updateValidation=async (id,patch) => {
    const saved=await update(id,patch);
    if (id === report.id && patch.state === "running" && saved) {
      claimStarted=true; await new Promise(resolve => { finishClaim=resolve; });
    }
    return saved;
  };
  const waiting=f.controller.request(f.works[2].id,{wait:true,signal:signal.signal});
  const checked=assert.rejects(waiting,/Claim cancellation race/);
  try {
    await until(() => f.controller.queue.get(f.works[2].id) !== queued);
    await f.release(0); await until(() => claimStarted);
    signal.abort(Error("Claim cancellation race")); await checked;
    assert.equal((await f.store.getValidation(report.id)).state,"cancelled");
    assert.equal(f.controller.entries.get(f.works[2].id).validation.controller.signal.aborted,true);
    finishClaim(); await until(() => f.controller.activeWorkers === 1);
    assert.deepEqual(f.calls.map(row=>row.workId),[f.works[0].id,f.works[1].id]);
    await f.release(1); await until(() => f.controller.activeWorkers === 0);
    assert.deepEqual(f.errors,[]); assert.deepEqual(f.counts(),{active:0,peak:2});
  } finally { finishClaim?.(); }
});

test("Retrying a queued receipt waits for its cancellation response while other works use the freed slot", async t => {
  const f = await scheduledWorks(t,4); await f.start();
  const report=await f.report(2,"queued"), queued=f.controller.queue.get(f.works[2].id), signal=new AbortController();
  const update=f.store.updateValidation.bind(f.store);
  let finishCancellation, cancellationStarted=false;
  f.store.updateValidation=async (id,patch) => {
    const saved=await update(id,patch);
    if (id === report.id && patch.state === "cancelled" && patch.from.length === 1 && patch.from[0] === "queued" && saved) {
      cancellationStarted=true; await new Promise(resolve => { finishCancellation=resolve; });
    }
    return saved;
  };
  const waiting=f.controller.request(f.works[2].id,{wait:true,signal:signal.signal});
  const checked=assert.rejects(waiting,/Queued receipt retry/);
  try {
    await until(() => f.controller.queue.get(f.works[2].id) !== queued);
    signal.abort(Error("Queued receipt retry")); await until(() => cancellationStarted);
    assert.equal((await f.controller.retry(f.works[2].id,report.id)).id,report.id);
    await f.release(0); await until(() => f.calls.length === 3);
    assert.equal(f.calls[2].workId,f.works[3].id,"The next work can bypass cleanup without admitting the old receipt");
    assert.equal(f.controller.queue.has(f.works[2].id),true);
    finishCancellation(); await checked; await f.release(1); await until(() => f.calls.length === 4);
    assert.equal(f.calls[3].id,report.id); assert.equal(f.gates.get(f.works[2].id).signal.aborted,false);
    await f.release(2); await f.release(3); await until(() => f.controller.activeWorkers === 0);
    assert.equal((await f.store.getValidation(report.id)).state,"passed");
    assert.deepEqual(f.cancellations,[]); assert.deepEqual(f.errors,[]);
  } finally { finishCancellation?.(); }
});

test("A failed claim yields through FIFO instead of reclaiming a retried receipt during delayed queued cancellation", async t => {
  const f=await scheduledWorks(t,4); await f.start();
  const report=await f.report(2,"queued"), queued=f.controller.queue.get(f.works[2].id), signal=new AbortController();
  const update=f.store.updateValidation.bind(f.store), drain=f.controller.drain.bind(f.controller);
  let beginClaim, finishClaim, finishCancellation, claimReached=false, claimReturned=false, cancellationStarted=false,
    drainFinished=false, claimAttempts=0;
  const claimPermission=new Promise(resolve=>{beginClaim=resolve;});
  const claimResponse=new Promise(resolve=>{finishClaim=resolve;});
  const cancellationResponse=new Promise(resolve=>{finishCancellation=resolve;});
  f.controller.drain=async id => { const value=await drain(id); if (id === report.workId) drainFinished=true; return value; };
  f.store.updateValidation=async (id,patch) => {
    if (id === report.id && patch.state === "running" && ++claimAttempts === 1) {
      claimReached=true; await claimPermission;
      const saved=await update(id,patch);
      assert.equal(saved,null,"The queued cancellation wins the actual database claim");
      claimReturned=true; await claimResponse; return saved;
    }
    const saved=await update(id,patch);
    if (id === report.id && patch.state === "cancelled" && patch.from[0] === "queued" && saved) {
      cancellationStarted=true; await cancellationResponse;
    }
    return saved;
  };
  const waiting=f.controller.request(report.workId,{wait:true,signal:signal.signal});
  const checked=assert.rejects(waiting,/Combined claim cancellation/);
  try {
    await until(()=>f.controller.queue.get(report.workId) !== queued);
    await f.release(0); await until(()=>claimReached);
    signal.abort(Error("Combined claim cancellation")); await until(()=>cancellationStarted);
    beginClaim(); await until(()=>claimReturned);
    assert.equal((await f.controller.retry(report.workId,report.id)).id,report.id);
    finishClaim(); await until(()=>drainFinished || f.calls.some(row=>row.workId === report.workId));
    assert.equal(drainFinished,true,"A failed claim cannot start the retry inside its old drain");
    assert.equal(claimAttempts,1); assert.equal(f.calls.length,2);
    assert.ok(f.controller.entries.get(report.workId).cancellation);
    finishCancellation(); await checked; await until(()=>f.calls.length === 3);
    assert.equal(f.calls[2].workId,f.works[3].id,"The retry rejoins FIFO after the work already waiting");
    await f.release(1); await until(()=>f.calls.length === 4);
    assert.equal(f.calls[3].id,report.id); assert.equal(f.gates.get(report.workId).signal.aborted,false);
    await f.release(2); await f.release(3); await until(()=>f.controller.activeWorkers === 0);
    assert.equal((await f.store.getValidation(report.id)).state,"passed");
    assert.deepEqual(f.cancellations,[]); assert.deepEqual(f.errors,[]);
  } finally { beginClaim(); finishClaim(); finishCancellation(); await checked; }
});

test("Domain assembly shares the existing task concurrency setting with native workspace validation", async () => {
  const data=await fs.mkdtemp(path.join(os.tmpdir(),"frame-validation-cap-")), previous=process.env.FRAME_TASK_CONCURRENCY;
  let services, db;
  try {
    process.env.FRAME_TASK_CONCURRENCY="3";
    db=await sqliteDatabase(path.join(data,"frame.sqlite"));
    services=await createServices({db,data,masterKey:"52".repeat(32),initialize:false});
    assert.equal(services.tasks.limits.concurrency,3);
    assert.equal(services.aiWorkspace.concurrency,services.tasks.limits.concurrency);
    assert.equal(services.aiWorkspace.activeWorkers,0); assert.equal(services.aiWorkspace.queue.size,0);
  } finally {
    if (services) await services.close(); else await db?.pool.end();
    await fs.rm(data,{recursive:true,force:true});
    if (previous === undefined) delete process.env.FRAME_TASK_CONCURRENCY; else process.env.FRAME_TASK_CONCURRENCY=previous;
  }
});
