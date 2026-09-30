import pg from "pg";
import { scopedPool } from "./scoped-pool.mjs";
import { migrate } from "./migrations.mjs";
import { passwordHash, passwordMatches } from "./security.mjs";
export async function database(url, password) {
  if (typeof password !== "string" || password.length < 14)
    throw new Error(
      "FRAME_ADMIN_PASSWORD (at least 14 characters) is required on every startup",
    );
  // Lock callbacks may await a shared scan started outside their ALS scope.
  // Dedicated, lazy pools reserve ordinary-query/LISTEN capacity even then.
  // The explicit upper bound is 12 ordinary + 12 lock sessions per process.
  const poolOptions = { connectionString: url, max: 12, connectionTimeoutMillis: 10000 };
  const lockPool = new pg.Pool(poolOptions);
  const { pool, lock, acquireClient } = scopedPool(new pg.Pool(poolOptions), lockPool);
  try {
    await migrate(pool);
    const admin = await pool.query(
      "SELECT value FROM settings WHERE key='admin'",
    );
    if (
      !admin.rowCount ||
      !passwordMatches(password, admin.rows[0].value.password)
    ) {
      await pool.query(
        "INSERT INTO settings VALUES ('admin',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
        [{ password: passwordHash(password) }],
      );
      await pool.query("DELETE FROM sessions");
      if (
        (await pool.query("SELECT to_regclass('oauth_grants') AS t")).rows[0].t
      )
        await pool.query("UPDATE oauth_grants SET revoked=true");
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    pool,
    lockPool,
    async all(sql, params = []) {
      return (await pool.query(sql, params)).rows;
    },
    async one(sql, params = []) {
      return (await pool.query(sql, params)).rows[0];
    },
    async setting(key, value) {
      if (value !== undefined)
        await pool.query(
          "INSERT INTO settings VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2",
          [key, value],
        );
      return (
        await pool.query("SELECT value FROM settings WHERE key=$1", [key])
      ).rows[0]?.value;
    },
    async event(task, kind, data) {
      await pool.query("INSERT INTO events(task,kind,data) VALUES ($1,$2,$3)", [
        task,
        kind,
        data,
      ]);
    },
    lock,
    acquireClient,
  };
}
