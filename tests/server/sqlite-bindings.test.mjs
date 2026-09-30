import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sqliteDatabase } from "../../server/sqlite.mjs";

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "frame-sqlite-bindings-"));
  const db = await sqliteDatabase(path.join(directory, "data.sqlite"));
  t.after(async () => {
    await db.pool.end();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

test("SQLite binds PostgreSQL parameter order, repetitions and gaps on supported Node runtimes", async (t) => {
  const db = await fixture(t);
  assert.deepEqual(await db.one("SELECT $2 AS second,$1 AS first,$2 AS repeated", ["one", "two"]), {
    second: "two", first: "one", repeated: "two",
  });
  assert.deepEqual(await db.one("SELECT $3 AS third", ["unused", "unused", "three"]), { third: "three" });
  assert.deepEqual(await db.setting("fixture", { nested: true }), { nested: true });
  assert.deepEqual(await db.setting("fixture", { updated: true }), { updated: true });
  const id = randomUUID();
  await db.pool.query("INSERT INTO tasks(id,kind,state,input) VALUES($1,'build','succeeded',$2)", [id, {}]);
  const updated = await db.pool.query({
    text: "UPDATE tasks SET error=$2 WHERE id=$1 RETURNING id,error",
    values: [id, "bound"],
  });
  assert.deepEqual(updated.rows, [{ id, error: "bound" }]);
  assert.equal(updated.rowCount, 1);
});

test("SQLite keeps anonymous and literal placeholders separate and preserves integer precision", async (t) => {
  const db = await fixture(t);
  assert.deepEqual(await db.one("SELECT 7 AS count,0 AS deleted"), { count: 7, deleted: false });
  assert.deepEqual(await db.one("SELECT ? AS value,'?1' AS literal /* ?2 */", ["anonymous"]), {
    value: "anonymous", literal: "?1",
  });
  assert.deepEqual(await db.one("SELECT $1 AS value,'?2' AS literal -- ?3\n", ["named"]), {
    value: "named", literal: "?2",
  });
  assert.deepEqual(await db.one("SELECT 9007199254740993 AS cursor,$1 AS bound", [9007199254740993n]), {
    cursor: "9007199254740993", bound: "9007199254740993",
  });
});
