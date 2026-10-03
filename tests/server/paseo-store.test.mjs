import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { migrate, migrationPlan } from "../../server/migrations.mjs";
import { PaseoStore, migratePaseo } from "../../server/paseo-store.mjs";

const sha = (digit) => digit.repeat(64);
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "frame-paseo-store-"));
  const file = path.join(dir, "local.sqlite");
  let db = await sqliteDatabase(file);
  t.after(async () => {
    await db.pool.end();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const workId = randomUUID(),
    repo = randomUUID();
  await db.pool.query("INSERT INTO repos(id,name) VALUES($1,'fixture')", [
    repo,
  ]);
  await db.pool.query(
    "INSERT INTO works(id,repo,project,title) VALUES($1,$2,'fixture','fixture')",
    [workId, repo],
  );
  const coreLedger = await db.all(
    "SELECT id,checksum FROM frame_schema_migrations ORDER BY id",
  );
  const store = await new PaseoStore({ db }).initialize();
  const input = {
    workId,
    repo,
    project: "fixture",
    revision: sha("b"),
  };
  await store.ensureWork(input);
  return {
    db,
    store,
    input,
    coreLedger,
    async reopenCore() {
      await db.pool.end();
      db = await sqliteDatabase(file);
      return db;
    },
  };
}

test("Paseo migrations keep the core ledger and existing work intact on a core reopen", async (t) => {
  const { db, store, input, coreLedger, reopenCore } = await fixture(t);
  const workBefore = await db.one("SELECT * FROM works WHERE id=$1", [
    input.workId,
  ]);
  await migratePaseo(db);
  assert.deepEqual(
    await db.all("SELECT id,checksum FROM frame_schema_migrations ORDER BY id"),
    coreLedger,
  );
  assert.equal(
    (await db.all("SELECT id FROM paseo_schema_migrations")).length,
    4,
  );
  const oldCore = await reopenCore();
  assert.deepEqual(
    await oldCore.one("SELECT * FROM works WHERE id=$1", [input.workId]),
    workBefore,
  );
  assert.equal(
    (await new PaseoStore({ db: oldCore }).getWork(input.workId))
      .revision,
    input.revision,
  );
  assert.ok(store);
});

test("Migration runner rejects arbitrary ledgers before querying and preserves existing core IDs", async () => {
  let connected = false;
  await assert.rejects(
    migrate(
      {
        connect() {
          connected = true;
        },
      },
      [],
      { ledger: "settings; DELETE FROM works" },
    ),
    /Unsupported migration ledger/,
  );
  assert.equal(connected, false);
  const core = migrationPlan();
  assert.ok(core.length > 0);
  assert.ok(core.every((item) => !item.id.includes("paseo")));
});

test("Frozen message is atomic under concurrent same-ID submissions; changed intent cannot replace it", async (t) => {
  const { store, input } = await fixture(t);
  const message = {
    workId: input.workId,
    agentId: "native-agent",
    messageId: randomUUID(),
    intentHash: sha("a"),
    envelope: { context: { time: 7 }, token: "public-fixture" },
    execution: { provider: "codex", connection: randomUUID() },
    reviewReference: { status: "unversioned" },
  };
  const rows = await Promise.all(
    Array.from({ length: 20 }, () => store.freezeMessage(message)),
  );
  assert.equal(rows.filter((row) => row.created).length, 1);
  assert.deepEqual(rows[0].message.envelope, message.envelope);
  await assert.rejects(
    store.freezeMessage({
      ...message,
      intentHash: sha("b"),
      envelope: { context: { time: 99 } },
    }),
    /different frozen intent/,
  );
  assert.deepEqual(
    (await store.getMessage(message)).envelope,
    message.envelope,
  );
  await assert.rejects(
    store.freezeMessage({ ...message, agentId: "another-native-agent" }),
    /another agent/,
  );
  assert.equal((await store.getMessageById(message)).agentId, message.agentId);
  await assert.rejects(
    store.freezeMessage({
      ...message,
      messageId: randomUUID(),
      envelope: { time: Infinity },
    }),
  );
});

test("Workspace generations remain exact decimal strings and same-revision observations are idempotent", async (t) => {
  const { db, store, input } = await fixture(t);
  await db.pool.query(
    "UPDATE paseo_work_bindings SET generation=$2 WHERE work_id=$1",
    [input.workId, 9007199254740993n],
  );
  assert.equal(
    (await store.markRevision(input.workId, { revision: input.revision }))
      .generation,
    "9007199254740993",
  );
  assert.equal(
    (await store.markRevision(input.workId, { revision: sha("e") })).generation,
    "9007199254740994",
  );
  assert.equal(
    (await store.markRevision(input.workId, { revision: sha("e") })).generation,
    "9007199254740994",
  );
  const reused = await store.ensureWork({
    ...input,
    revision: sha("f"),
  });
  assert.equal(reused.revision, sha("e"));
  await assert.rejects(
    store.updateRuntime(input.workId, { daemonGeneration: 9007199254740992 }),
  );
});

test("Runtime generation CAS blocks old controllers and explicit reconnect resets a failure once", async (t) => {
  const { store, input } = await fixture(t);
  let binding = await store.updateRuntime(
    input.workId,
    { state: "starting", daemonGeneration: "1", requested: true },
    { expectedDaemonGeneration: "0" },
  );
  assert.equal(binding.daemonGeneration, "1");
  assert.equal(
    await store.updateRuntime(
      input.workId,
      { state: "ready", endpoint: "http://wrong:6767" },
      { expectedDaemonGeneration: "0" },
    ),
    null,
  );
  assert.equal(
    await store.updateRuntime(input.workId, { daemonGeneration: "0" }),
    null,
  );
  binding = await store.updateRuntime(
    input.workId,
    { state: "failed", error: "fixture failure" },
    { expectedDaemonGeneration: "1" },
  );
  const touched = binding.touched;
  binding = await store.requestWork(input.workId);
  assert.equal(binding.state, "cold");
  assert.equal(binding.error, null);
  assert.equal(binding.requested, true);
  assert.ok(new Date(binding.touched) >= new Date(touched));
  assert.equal(
    (await store.listWorks({ states: ["cold"], requested: true })).length,
    1,
  );
  await assert.rejects(
    store.updateRuntime(input.workId, { env: { SECRET: "no" } }),
    /Unrecognized key/,
  );
});

test("Validation claims are atomic, revision-bound, and cannot replace current workspace state", async t => {
  const { store, input } = await fixture(t);
  const report = await store.createValidation({ workId: input.workId, revision: input.revision, generation: "0", runtimeFingerprint: sha("d") });
  const duplicate = await store.createValidation({ workId: input.workId, revision: input.revision, generation: "0", runtimeFingerprint: sha("d") });
  assert.equal(duplicate.id, report.id);
  const claims = await Promise.all(Array.from({ length: 10 }, () => store.updateValidation(report.id, { from: ["queued"], state: "running" })));
  assert.equal(claims.filter(Boolean).length, 1);
  await store.markRevision(input.workId, { revision: sha("f") });
  await store.updateValidation(report.id, { from: ["running"], state: "stale", result: { status: "passed" } });
  assert.equal((await store.getWork(input.workId)).revision, sha("f"));
  assert.equal((await store.getValidation(report.id)).state, "stale");
  assert.equal(await store.updateValidation(report.id, { from: ["running"], state: "passed" }), null);
});
test("Native contexts and validation reports follow only their work owner", async t => {
  const { db, store, input } = await fixture(t);
  await store.createValidation({ workId: input.workId, revision: input.revision, generation: "0", runtimeFingerprint: sha("d") });
  await store.freezeMessage({ workId: input.workId, agentId: "agent", messageId: randomUUID(), intentHash: sha("a"), envelope: {} });
  await db.pool.query("DELETE FROM works WHERE id=$1", [input.workId]);
  assert.equal((await db.all("SELECT * FROM paseo_work_bindings")).length, 0);
  assert.equal((await db.all("SELECT * FROM paseo_message_contexts")).length, 0);
  assert.equal((await db.all("SELECT * FROM paseo_validations")).length, 0);
  assert.equal((await db.all("SELECT * FROM repos")).length, 1);
});


test("workspace migration refuses to discard any retained candidate identity and rolls back the entire upgrade", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "frame-paseo-upgrade-"));
  const db = await sqliteDatabase(path.join(directory, "local.sqlite"));
  t.after(async () => { await db.pool.end(); await fs.rm(directory, { recursive: true, force: true }); });
  const plan = migrationPlan(path.resolve("server/paseo-migrations"));
  assert.match(plan[2].sql, /LOCK TABLE paseo_candidates IN ACCESS EXCLUSIVE MODE/);
  assert.match(plan[2].sql, /IF EXISTS \(SELECT 1 FROM paseo_candidates\)[\s\S]*RAISE EXCEPTION/);
  await migratePaseo(db, plan.slice(0, 2));
  const work = randomUUID(), repo = randomUUID(), candidate = randomUUID(), run = randomUUID();
  await db.pool.query("INSERT INTO repos(id,name) VALUES($1,'fixture')", [repo]);
  await db.pool.query("INSERT INTO works(id,repo,project,title) VALUES($1,$2,'fixture','fixture')", [work, repo]);
  await db.pool.query("INSERT INTO paseo_work_bindings(work_id,repo,project,baseline_fingerprint,baseline_mode_fingerprint,draft_revision) VALUES($1,$2,'fixture',$3,$3,$3)", [work, repo, sha("a")]);
  await db.pool.query("INSERT INTO paseo_candidates(id,work_id,repo,project,generation,revision,baseline_fingerprint,baseline_mode_fingerprint,run_id,snapshot_fingerprint,snapshot_mode_fingerprint,origin,state) VALUES($1,$2,$3,'fixture',0,$4,$4,$4,$5,$4,$4,'recovery','validating')", [candidate, work, repo, sha("a"), run]);
  await assert.rejects(migratePaseo(db), /Audit retained Paseo candidates and stop old validation workers/);
  assert.equal((await db.one("SELECT run_id FROM paseo_candidates WHERE id=$1", [candidate])).run_id, run);
  assert.equal((await db.one("SELECT draft_revision FROM paseo_work_bindings WHERE work_id=$1", [work])).draft_revision, sha("a"));
  assert.equal((await db.all("SELECT id FROM paseo_schema_migrations")).length, 2);
  // Test-only records represent an explicitly reviewed/completed old worker; no production data is removed.
  await db.pool.query("DELETE FROM paseo_candidates WHERE id=$1", [candidate]);
  await migratePaseo(db);
  assert.equal((await db.one("SELECT revision FROM paseo_work_bindings WHERE work_id=$1", [work])).revision, sha("a"));
  assert.equal((await db.all("SELECT id FROM paseo_schema_migrations")).length, 4);
});
