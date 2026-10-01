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
const commit = "a".repeat(40);
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
    baselineFingerprint: sha("a"),
    baselineModeFingerprint: sha("b"),
    baselineCommit: commit,
    draftRevision: sha("b"),
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
const candidateInput = (input, overrides = {}) => ({
  workId: input.workId,
  repo: input.repo,
  project: input.project,
  baselineFingerprint: input.baselineFingerprint,
  baselineModeFingerprint: input.baselineModeFingerprint,
  baselineCommit: input.baselineCommit,
  generation: "0",
  revision: input.draftRevision,
  runId: randomUUID(),
  snapshotFingerprint: sha("c"),
  snapshotModeFingerprint: input.draftRevision,
  runtimeFingerprint: sha("d"),
  origin: "manual",
  ...overrides,
});

test("Paseo migrations keep the core ledger and existing work/history intact for an old core reopen", async (t) => {
  const { db, store, input, coreLedger, reopenCore } = await fixture(t);
  const workBefore = await db.one("SELECT * FROM works WHERE id=$1", [
    input.workId,
  ]);
  const chatId = randomUUID();
  await db.pool.query(
    "INSERT INTO chats(id,repo,project,provider,title) VALUES($1,$2,'fixture','codex','legacy')",
    [chatId, input.repo],
  );
  await migratePaseo(db);
  assert.deepEqual(
    await db.all("SELECT id,checksum FROM frame_schema_migrations ORDER BY id"),
    coreLedger,
  );
  assert.equal(
    (await db.all("SELECT id FROM paseo_schema_migrations")).length,
    2,
  );
  const oldCore = await reopenCore();
  assert.deepEqual(
    await oldCore.one("SELECT * FROM works WHERE id=$1", [input.workId]),
    workBefore,
  );
  assert.equal(
    (await oldCore.one("SELECT id FROM chats WHERE id=$1", [chatId])).id,
    chatId,
  );
  assert.equal(
    (await new PaseoStore({ db: oldCore }).getWork(input.workId))
      .baselineFingerprint,
    input.baselineFingerprint,
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

test("Draft generations remain exact decimal strings and same-revision observations are idempotent", async (t) => {
  const { db, store, input } = await fixture(t);
  await db.pool.query(
    "UPDATE paseo_work_bindings SET generation=$2 WHERE work_id=$1",
    [input.workId, 9007199254740993n],
  );
  assert.equal(
    (await store.markDraft(input.workId, { revision: input.draftRevision }))
      .generation,
    "9007199254740993",
  );
  assert.equal(
    (await store.markDraft(input.workId, { revision: sha("e") })).generation,
    "9007199254740994",
  );
  assert.equal(
    (await store.markDraft(input.workId, { revision: sha("e") })).generation,
    "9007199254740994",
  );
  const reused = await store.ensureWork({
    ...input,
    baselineFingerprint: sha("f"),
    draftRevision: sha("f"),
  });
  assert.equal(reused.baselineFingerprint, input.baselineFingerprint);
  assert.equal(reused.draftRevision, sha("e"));
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

test("Candidates use CAS transitions and exactly one apply receipt without overwriting newer draft state", async (t) => {
  const { store, input } = await fixture(t);
  const candidate = candidateInput(input);
  const first = await store.createCandidate(candidate);
  const duplicate = await store.createCandidate({
    ...candidate,
    runId: randomUUID(),
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.candidate.id, first.candidate.id);
  const claims = await Promise.all(
    Array.from({ length: 10 }, () =>
      store.transitionCandidate(first.candidate.id, {
        from: ["queued_validation"],
        state: "validating",
      }),
    ),
  );
  assert.equal(claims.filter(Boolean).length, 1);
  await assert.rejects(
    store.transitionCandidate(first.candidate.id, {
      from: ["validating"],
      state: "applied",
    }),
    /Unsupported/,
  );
  await store.transitionCandidate(first.candidate.id, {
    from: ["validating"],
    state: "verified",
    patch: { result: { status: "passed" } },
  });
  await store.transitionCandidate(first.candidate.id, {
    from: ["verified"],
    state: "publishing",
  });
  await store.markDraft(input.workId, { revision: sha("f") });
  const receipt = await store.appliedCandidate(first.candidate.id, {
    sourceRevision: candidate.snapshotFingerprint,
    commit,
  });
  assert.equal(receipt.state, "applied");
  const binding = await store.getWork(input.workId);
  assert.equal(binding.baselineFingerprint, candidate.snapshotFingerprint);
  assert.equal(
    binding.baselineModeFingerprint,
    candidate.snapshotModeFingerprint,
  );
  assert.equal(binding.draftRevision, sha("f"));
  assert.equal(binding.generation, "1");
  assert.deepEqual(
    await store.appliedCandidate(first.candidate.id, {
      sourceRevision: candidate.snapshotFingerprint,
      commit,
    }),
    receipt,
  );
  await assert.rejects(
    store.appliedCandidate(first.candidate.id, {
      sourceRevision: sha("d"),
      commit,
    }),
    /receipt changed/,
  );
});

test("Candidate registration rejects a stale captured generation and tables follow only their work owner", async (t) => {
  const { db, store, input } = await fixture(t);
  const candidate = candidateInput(input);
  await store.markDraft(input.workId, { revision: sha("f") });
  await assert.rejects(
    store.createCandidate(candidate),
    /before candidate registration/,
  );
  await store.freezeMessage({
    workId: input.workId,
    agentId: "agent",
    messageId: randomUUID(),
    intentHash: sha("a"),
    envelope: {},
  });
  await db.pool.query("DELETE FROM works WHERE id=$1", [input.workId]);
  assert.equal((await db.all("SELECT * FROM paseo_work_bindings")).length, 0);
  assert.equal(
    (await db.all("SELECT * FROM paseo_message_contexts")).length,
    0,
  );
  assert.equal((await db.all("SELECT * FROM repos")).length, 1);
});
