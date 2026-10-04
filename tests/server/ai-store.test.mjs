import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { migrate, migrationPlan } from "../../server/migrations.mjs";
import { AiStore, migrateAi } from "../../server/ai-store.mjs";

const sha = (digit) => digit.repeat(64);
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "frame-ai-store-"));
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
  const store = await new AiStore({ db }).initialize();
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

test("Ai migrations keep the core ledger and existing work intact on a core reopen", async (t) => {
  const { db, store, input, coreLedger, reopenCore } = await fixture(t);
  const workBefore = await db.one("SELECT * FROM works WHERE id=$1", [
    input.workId,
  ]);
  await migrateAi(db);
  assert.deepEqual(
    await db.all("SELECT id,checksum FROM frame_schema_migrations ORDER BY id"),
    coreLedger,
  );
  assert.equal(
    (await db.all("SELECT id FROM ai_schema_migrations")).length,
    1,
  );
  const oldCore = await reopenCore();
  assert.deepEqual(
    await oldCore.one("SELECT * FROM works WHERE id=$1", [input.workId]),
    workBefore,
  );
  assert.equal(
    (await new AiStore({ db: oldCore }).getWork(input.workId))
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
  assert.ok(core.every((item) => !item.id.includes("ai-metadata")));
});

test("Frozen message is atomic under concurrent same-ID submissions; changed intent cannot replace it", async (t) => {
  const { store, input } = await fixture(t);
  const message = {
    workId: input.workId,
    threadId: "native-agent",
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
    store.freezeMessage({ ...message, threadId: "another-native-agent" }),
    /another agent/,
  );
  assert.equal((await store.getMessageById(message)).threadId, message.threadId);
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
    "UPDATE ai_work_bindings SET generation=$2 WHERE work_id=$1",
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

test("Shared binding reconnect is explicit and identical runtime observations do not churn metadata", async t => {
  const { store, input } = await fixture(t);
  const failed = await store.updateRuntime(input.workId, { state: "failed", error: "fixture failure" });
  const again = await store.updateRuntime(input.workId, { state: "failed", error: "fixture failure" });
  assert.equal(again.updated, failed.updated);
  const binding = await store.requestWork(input.workId);
  assert.equal(binding.state, "cold"); assert.equal(binding.error, null); assert.equal(binding.requested, true);
  await assert.rejects(store.updateRuntime(input.workId, { env: { SECRET: "no" } }), /Unrecognized key/);
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
  await store.freezeMessage({ workId: input.workId, threadId: "agent", messageId: randomUUID(), intentHash: sha("a"), envelope: {} });
  await db.pool.query("DELETE FROM works WHERE id=$1", [input.workId]);
  assert.equal((await db.all("SELECT * FROM ai_work_bindings")).length, 0);
  assert.equal((await db.all("SELECT * FROM ai_message_contexts")).length, 0);
  assert.equal((await db.all("SELECT * FROM ai_validations")).length, 0);
  assert.equal((await db.all("SELECT * FROM repos")).length, 1);
});


