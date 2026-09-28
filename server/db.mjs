import pg from "pg";
import { passwordHash } from "./security.mjs";
export async function database(url, password) {
  const pool = new pg.Pool({ connectionString: url, max: 12 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash text PRIMARY KEY, expires timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (id uuid PRIMARY KEY, name text NOT NULL, hash text UNIQUE NOT NULL, created timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS repos (id uuid PRIMARY KEY, name text NOT NULL, url text NOT NULL DEFAULT '', branch text NOT NULL DEFAULT 'main', created timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS assets (id uuid PRIMARY KEY, name text NOT NULL, sha text NOT NULL, bytes bigint NOT NULL, mime text NOT NULL, license text NOT NULL, tags text NOT NULL DEFAULT '', deleted boolean NOT NULL DEFAULT false, created timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS asset_refs (asset uuid REFERENCES assets(id), repo uuid REFERENCES repos(id), project text NOT NULL, path text NOT NULL, PRIMARY KEY(asset,repo,project));
    CREATE TABLE IF NOT EXISTS chats (id uuid PRIMARY KEY, repo uuid NOT NULL REFERENCES repos(id), project text NOT NULL, provider text NOT NULL, title text NOT NULL, upstream text, created timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS tasks (id uuid PRIMARY KEY, repo uuid REFERENCES repos(id), project text, kind text NOT NULL, state text NOT NULL DEFAULT 'queued', input jsonb NOT NULL, result jsonb, error text, container text, fingerprint text, chat uuid REFERENCES chats(id), created timestamptz NOT NULL DEFAULT now(), started timestamptz, finished timestamptz);
    CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);
    CREATE TABLE IF NOT EXISTS events (id bigserial PRIMARY KEY, task uuid NOT NULL REFERENCES tasks(id), kind text NOT NULL, data jsonb NOT NULL, created timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS events_task ON events(task,id);
    CREATE TABLE IF NOT EXISTS engines (id uuid PRIMARY KEY, name text NOT NULL, config text NOT NULL, enabled boolean NOT NULL DEFAULT true, created timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS works (id uuid PRIMARY KEY, repo uuid NOT NULL REFERENCES repos(id), project text NOT NULL, title text NOT NULL, category text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', description text NOT NULL DEFAULT '', deleted boolean NOT NULL DEFAULT false, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now(), UNIQUE(repo,project));
    CREATE TABLE IF NOT EXISTS work_versions (id uuid PRIMARY KEY, work uuid NOT NULL REFERENCES works(id), name text NOT NULL, created timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS agent_tokens (hash text PRIMARY KEY, task uuid NOT NULL REFERENCES tasks(id));
  `);
  const admin = await pool.query(
    "SELECT value FROM settings WHERE key='admin'",
  );
  if (!admin.rowCount) {
    if (!password || password.length < 14)
      throw new Error(
        "Set FRAME_ADMIN_PASSWORD (at least 14 characters) for first startup",
      );
    await pool.query(
      "INSERT INTO settings VALUES ('admin',$1) ON CONFLICT DO NOTHING",
      [{ password: passwordHash(password) }],
    );
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
        return await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [id]);
        client.release();
      }
    },
  };
}
