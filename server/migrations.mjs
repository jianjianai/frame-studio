import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const directory = fileURLToPath(new URL("./migrations/", import.meta.url));
export function migrationPlan(root = directory) {
  return fs.readdirSync(root).filter((name) => /^\d{4}-[a-z0-9-]+\.sql$/.test(name)).sort().map((name) => {
    const sql = fs.readFileSync(path.join(root, name), "utf8").replaceAll("\r\n", "\n");
    return { id: name.slice(0, -4), sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

/** Only known integration ledgers may be selected; identifiers never come from SQL input. */
export function migrationLedger(ledger = "frame_schema_migrations") {
  if (!["frame_schema_migrations", "paseo_schema_migrations"].includes(ledger))
    throw Error("Unsupported migration ledger");
  return ledger;
}

export async function migrate(pool, plan = migrationPlan(), {
  ledger = "frame_schema_migrations", dialect = "postgres", transformSql = (sql) => sql,
} = {}) {
  ledger = migrationLedger(ledger);
  if (!["postgres", "sqlite"].includes(dialect)) throw Error("Unsupported migration dialect");
  const lockKey = ledger.replaceAll("_", "-");
  const client = await pool.connect();
  let locked = false, broken = false;
  try {
    if (dialect === "postgres") {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
      locked = true;
    }
    await client.query(transformSql(`CREATE TABLE IF NOT EXISTS ${ledger} (id text PRIMARY KEY, checksum text NOT NULL, applied timestamptz NOT NULL DEFAULT now())`));
    const rows = (await client.query(`SELECT id,checksum FROM ${ledger} ORDER BY id`)).rows;
    const known = new Map(plan.map((item) => [item.id, item]));
    for (const row of rows) {
      if (!known.has(row.id)) throw Error("Database schema is newer than this application: " + row.id);
      if (known.get(row.id).checksum !== row.checksum) throw Error("An applied migration was modified: " + row.id);
    }
    const applied = new Set(rows.map((row) => row.id));
    for (const item of plan) {
      if (applied.has(item.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(transformSql(item.sql));
        await client.query(`INSERT INTO ${ledger}(id,checksum) VALUES($1,$2)`, [item.id, item.checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { broken = true; });
        throw error;
      }
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => { broken = true; });
    client.release(broken);
  }
}
