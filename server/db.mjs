import pg from "pg";
import { migrate } from "./migrations.mjs";
import { passwordHash, passwordMatches } from "./security.mjs";
export async function database(url, password) {
  if (typeof password !== "string" || password.length < 14)
    throw new Error("FRAME_ADMIN_PASSWORD (at least 14 characters) is required on every startup");
  const pool = new pg.Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 10000 });
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
      if ((await pool.query("SELECT to_regclass('oauth_grants') AS t")).rows[0].t)
        await pool.query("UPDATE oauth_grants SET revoked=true");
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    pool,
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
    async lock(id, fn) {
      const client = await pool.connect();
      let locked = false, broken = false;
      try {
        const row = await client.query(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
          [id],
        );
        if (!row.rows[0].ok) {
          const e = new Error("Repository is busy");
          e.statusCode = 409;
          throw e;
        }
        locked = true;
        return await fn();
      } finally {
        if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [id]).catch(() => { broken = true; });
        client.release(broken);
      }
    },
  };
}
