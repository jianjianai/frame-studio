import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { scopedPool } from "../../server/scoped-pool.mjs";
import { migrationPlan } from "../../server/migrations.mjs";
import { Assets } from "../../server/assets.mjs";
import { AiStore, migrateAi } from "../../server/ai-store.mjs";
import { hash } from "../../server/security.mjs";

const plan = migrationPlan(path.resolve("server/ai-migrations"));
function gate() {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
}
async function fixture(t, dialect) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "frame-native-asset-pins-"));
  let db, admin, schema;
  t.after(async () => {
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    await fs.rm(data, { recursive: true, force: true });
  });
  if (dialect === "postgres") {
    const url = process.env.FRAME_TEST_DATABASE_URL;
    assert.match(new URL(url).pathname, /frame_test/);
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    schema = "native_asset_pins_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolated = new URL(url);
    isolated.searchParams.set("options", "-c search_path=" + schema);
    const { pool, lock } = scopedPool(new pg.Pool({ connectionString: isolated.href, max: 6 }));
    db = { pool, lock, all: async (sql, params) => (await pool.query(sql, params)).rows,
      one: async (sql, params) => (await pool.query(sql, params)).rows[0] };
    // The real integration owns its schema and the minimal core tables referenced by
    // native migrations. It never changes the shared test database's public ledger.
    await pool.query(`
      CREATE TABLE repos(id uuid PRIMARY KEY,name text NOT NULL);
      CREATE TABLE works(id uuid PRIMARY KEY,repo uuid NOT NULL REFERENCES repos(id),project text NOT NULL,title text NOT NULL,deleted boolean NOT NULL DEFAULT false);
      CREATE TABLE assets(id uuid PRIMARY KEY,name text NOT NULL,sha text NOT NULL,bytes bigint NOT NULL,mime text NOT NULL,license text NOT NULL,tags text NOT NULL DEFAULT '',deleted boolean NOT NULL DEFAULT false);
      CREATE TABLE asset_repos(asset uuid REFERENCES assets(id) ON DELETE CASCADE,repo uuid REFERENCES repos(id),catalog_id uuid,PRIMARY KEY(asset,repo));
      CREATE TABLE asset_refs(asset uuid REFERENCES assets(id),repo uuid REFERENCES repos(id),project text NOT NULL,path text NOT NULL,PRIMARY KEY(asset,repo,project));
    `);
  } else db = await sqliteDatabase(path.join(data, "test.sqlite"));
  await migrateAi(db, plan);
  const repo = randomUUID(), work = randomUUID();
  await db.pool.query("INSERT INTO repos(id,name) VALUES($1,'Owned pins fixture')", [repo]);
  await db.pool.query("INSERT INTO works(id,repo,project,title) VALUES($1,$2,'fixture','Owned pins fixture')", [work, repo]);
  const store = new AiStore({ db });
  await store.ensureWork({ workId: work, repo, project: "fixture", revision: "a".repeat(64) });
  const library = async id => {
    const root = path.join(data, "libraries", id);
    await fs.mkdir(root, { recursive: true });
    return { root };
  };
  const assets = new Assets(db, data, { list: async () => [], library });
  return { db, store, assets, data, repo, work,
    async asset({ deleted = false, own = true } = {}) {
      const id = randomUUID(), bytes = Buffer.from("Owned immutable original media: " + id), sha256 = hash(bytes);
      await fs.writeFile(path.join(data, "blobs", sha256), bytes);
      const membership = own ? repo : randomUUID();
      if (!own) await db.pool.query("INSERT INTO repos(id,name) VALUES($1,'Foreign pins fixture')", [membership]);
      await db.pool.query("INSERT INTO assets(id,name,sha,bytes,mime,license,deleted) VALUES($1,$2,$3,$4,'audio/wav','Owned fixture',$5)",
        [id, id + ".wav", sha256, bytes.length, deleted]);
      await db.pool.query("INSERT INTO asset_repos(asset,repo,catalog_id) VALUES($1,$2,$1)", [id, membership]);
      const root = (await library(membership)).root;
      await fs.mkdir(path.join(root, "materials", sha256), { recursive: true });
      await fs.writeFile(path.join(root, "materials", sha256, id + ".wav"), bytes);
      return { material: { id, sha256, bytes: String(bytes.length) }, bytes, blob: path.join(data, "blobs", sha256) };
    },
    message(materials = []) {
      return { workId: work, threadId: "owned-native-agent", messageId: randomUUID(), intentHash: "b".repeat(64),
        envelope: { context: { assets: materials.map(asset => asset.id) } }, reviewReference: { materials } };
    },
  };
}

for (const dialect of ["sqlite", "postgres"]) {
  const options = { skip: dialect === "postgres" && !process.env.FRAME_TEST_DATABASE_URL, timeout: 60000 };
  test(`${dialect}: frozen native material keeps original bytes through trash/purge, then work deletion releases only its pins`, options, async t => {
    const f = await fixture(t, dialect), original = await f.asset(), unrelated = await f.asset();
    const message = f.message([original.material, original.material]);
    await f.store.freezeMessage(message);
    assert.equal((await f.db.all("SELECT * FROM ai_message_assets")).length, 1);
    const otherWork = randomUUID();
    await f.db.pool.query("INSERT INTO works(id,repo,project,title) VALUES($1,$2,'other','Other work')", [otherWork, f.repo]);
    await f.store.ensureWork({ workId: otherWork, repo: f.repo, project: "other", revision: "a".repeat(64) });
    await f.store.freezeMessage({ ...f.message([unrelated.material]), workId: otherWork });
    await f.assets.trash(original.material.id, true);
    assert.equal((await f.store.freezeMessage(message)).created, false, "A frozen retry retains its already-pinned original even after trash");
    await assert.rejects(f.assets.purge(original.material.id), error => error.statusCode === 409 && /Ai/.test(error.message));
    assert.deepEqual(await fs.readFile(original.blob), original.bytes);
    await f.db.pool.query("DELETE FROM works WHERE id=$1", [f.work]);
    assert.deepEqual((await f.db.all("SELECT asset FROM ai_message_assets")).map(row => row.asset), [unrelated.material.id]);
    await f.assets.purge(original.material.id);
    await assert.rejects(fs.stat(original.blob), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(unrelated.blob), unrelated.bytes);
    assert.ok(await f.db.one("SELECT id FROM assets WHERE id=$1", [unrelated.material.id]));
  });

  test(`${dialect}: material admission checks current ownership/hash/length/deletion atomically and rolls back every invalid message`, options, async t => {
    const f = await fixture(t, dialect), original = await f.asset(), foreign = await f.asset({ own: false }), trashed = await f.asset({ deleted: true });
    for (const material of [
      { ...original.material, sha256: "f".repeat(64) },
      { ...original.material, bytes: String(Number(original.material.bytes) + 1) },
      foreign.material, trashed.material, { ...original.material, id: randomUUID() },
    ]) await assert.rejects(f.store.freezeMessage(f.message([material])), error => error.statusCode === 409);
    await assert.rejects(f.store.freezeMessage(f.message([original.material, { ...original.material, bytes: "1" }])), error => error.statusCode === 409);
    assert.equal((await f.db.all("SELECT * FROM ai_message_contexts")).length, 0);
    assert.equal((await f.db.all("SELECT * FROM ai_message_assets")).length, 0);
    assert.deepEqual(await fs.readFile(original.blob), original.bytes);
    await f.store.freezeMessage(f.message([{ ...original.material, id: original.material.id.toUpperCase() }]));
    assert.equal((await f.db.all("SELECT asset FROM ai_message_assets")).length, 1);
  });

  test(`${dialect}: concurrent native agents pin overlapping selected originals without upgrading owner locks or deadlocking`, options, async t => {
    const f = await fixture(t, dialect), first = await f.asset(), second = await f.asset();
    await Promise.all(Array.from({ length: 12 }, (_, index) => f.store.freezeMessage({
      ...f.message(index % 2 ? [first.material, second.material] : [second.material, first.material]),
      threadId: "owned-agent-" + index,
    })));
    assert.equal((await f.db.all("SELECT * FROM ai_message_contexts")).length, 12);
    assert.equal((await f.db.all("SELECT * FROM ai_message_assets")).length, 24);
  });

  test(`${dialect}: concurrent freeze versus trash/purge has a single outcome and never retains a message with a missing original`, options, async t => {
    const f = await fixture(t, dialect), first = await f.asset();
    const locked = gate(), release = gate(), connect = f.db.pool.connect.bind(f.db.pool);
    const controlledDb = { ...f.db, pool: { ...f.db.pool, async connect() {
      const client = await connect(), query = client.query.bind(client);
      return { query: async (sql, params) => {
        const result = await query(sql, params);
        if (/SELECT a.id,a.sha,a.bytes/.test(sql)) { locked.release(); await release.promise; }
        return result;
      }, release: client.release.bind(client) };
    } } };
    const freezing = new AiStore({ db: controlledDb }).freezeMessage(f.message([first.material]));
    try {
      await locked.promise;
      const trash = f.assets.trash(first.material.id, true);
      release.release();
      await freezing;
      await trash;
      await assert.rejects(f.assets.purge(first.material.id), error => error.statusCode === 409);
      assert.deepEqual(await fs.readFile(first.blob), first.bytes);
    } finally { release.release(); await freezing.catch(() => {}); }

    const second = await f.asset(), deleted = gate(), finishDeletion = gate();
    await f.assets.trash(second.material.id, true);
    const one = f.db.one.bind(f.db);
    f.db.one = async (sql, params) => {
      const result = await one(sql, params);
      if (/DELETE FROM assets/.test(sql) && params[0] === second.material.id) { deleted.release(); await finishDeletion.promise; }
      return result;
    };
    const deleting = f.assets.purge(second.material.id), rejected = f.message([second.material]);
    try {
      await deleted.promise;
      await assert.rejects(f.store.freezeMessage(rejected), error => error.statusCode === 409);
      assert.equal(await f.store.getMessage(rejected), undefined);
      finishDeletion.release();
      await deleting;
      await assert.rejects(fs.stat(second.blob), { code: "ENOENT" });
    } finally { finishDeletion.release(); f.db.one = one; await deleting.catch(() => {}); }
  });

  test(`${dialect}: retaining FK closes the gap after purge's indexed pin check`, options, async t => {
    const f = await fixture(t, dialect), original = await f.asset(), message = f.message();
    await f.store.freezeMessage(message);
    await f.assets.trash(original.material.id, true);
    const checked = gate(), remove = gate(), one = f.db.one.bind(f.db);
    f.db.one = async (sql, params) => {
      const result = await one(sql, params);
      if (/SELECT asset FROM ai_message_assets/.test(sql)) { checked.release(); await remove.promise; }
      return result;
    };
    const deletion = f.assets.purge(original.material.id);
    try {
      await checked.promise;
      await f.db.pool.query("INSERT INTO ai_message_assets(work_id,thread_id,message_id,asset) VALUES($1,$2,$3,$4)",
        [message.workId, message.threadId, message.messageId, original.material.id]);
      remove.release();
      await assert.rejects(deletion, error => error.statusCode === 409 && /Ai/.test(error.message));
      assert.deepEqual(await fs.readFile(original.blob), original.bytes);
      assert.ok(await one("SELECT id FROM assets WHERE id=$1", [original.material.id]));
    } finally { remove.release(); f.db.one = one; await deletion.catch(() => {}); }
  });
}
