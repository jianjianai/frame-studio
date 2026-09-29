import test from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../../server/migrations.mjs";

test("migrations apply once, reject changed history and release locks on failure", async () => {
  const history = [], commands = [];
  let released = 0;
  const pool = { connect: async () => ({
    query: async (sql, params) => {
      commands.push(sql);
      if (sql.startsWith("SELECT id,checksum")) return { rows: history.map((row) => ({ ...row })) };
      if (sql.startsWith("INSERT INTO frame_schema_migrations")) history.push({ id: params[0], checksum: params[1] });
      if (sql === "FAIL") throw Error("migration failed");
      return { rows: [] };
    },
    release: () => released++,
  }) };
  const plan = [{ id: "0001-fixture", checksum: "stable", sql: "CREATE FIXTURE" }];
  await migrate(pool, plan);
  await migrate(pool, plan);
  assert.equal(commands.filter((sql) => sql === "CREATE FIXTURE").length, 1);
  await assert.rejects(migrate(pool, [{ ...plan[0], checksum: "changed" }]), /modified/);
  await assert.rejects(migrate(pool, [...plan, { id: "0002-failure", checksum: "bad", sql: "FAIL" }]), /migration failed/);
  assert(commands.includes("ROLLBACK"));
  assert.equal(released, 4);
  assert.equal(commands.filter((sql) => sql.includes("pg_advisory_unlock")).length, 4);
});
