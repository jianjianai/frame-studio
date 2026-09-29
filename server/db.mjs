import pg from "pg";
import { passwordHash, passwordMatches } from "./security.mjs";
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
    CREATE TABLE IF NOT EXISTS connections (id uuid PRIMARY KEY, name text NOT NULL, tool text NOT NULL CHECK(tool IN ('codex','claude')), mode text NOT NULL CHECK(mode IN ('api','official')), config text NOT NULL, state text NOT NULL DEFAULT 'unconfigured', error text, created timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS github_accounts (id uuid PRIMARY KEY, login text UNIQUE NOT NULL, config text NOT NULL, state text NOT NULL DEFAULT 'ready', checked timestamptz, created timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS auth_flows (id uuid PRIMARY KEY, target uuid, kind text NOT NULL, state text NOT NULL DEFAULT 'pending', info jsonb NOT NULL DEFAULT '{}', expires timestamptz NOT NULL, created timestamptz NOT NULL DEFAULT now());
    ALTER TABLE repos ADD COLUMN IF NOT EXISTS account uuid REFERENCES github_accounts(id);
    ALTER TABLE repos ADD COLUMN IF NOT EXISTS sync_state jsonb;
    ALTER TABLE works ADD COLUMN IF NOT EXISTS opened timestamptz;
    ALTER TABLE works ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE works ADD COLUMN IF NOT EXISTS branch text;
    ALTER TABLE works ADD COLUMN IF NOT EXISTS sync_state jsonb;
    CREATE UNIQUE INDEX IF NOT EXISTS works_branch ON works(repo,branch) WHERE branch IS NOT NULL;
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS connection uuid REFERENCES connections(id);
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS request_key uuid UNIQUE;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS expires timestamptz;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cleaned timestamptz;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS log_cursor text;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_commit text;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress jsonb;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS monitor jsonb;
    ALTER TABLE engines ADD COLUMN IF NOT EXISTS builtin text;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS source_offset bigint;
    CREATE UNIQUE INDEX IF NOT EXISTS events_source ON events(task,source_offset) WHERE source_offset IS NOT NULL;
    CREATE TABLE IF NOT EXISTS asset_repos (asset uuid REFERENCES assets(id) ON DELETE CASCADE, repo uuid REFERENCES repos(id), PRIMARY KEY(asset,repo));
    ALTER TABLE asset_repos ADD COLUMN IF NOT EXISTS catalog_id uuid;
    UPDATE asset_repos SET catalog_id=asset WHERE catalog_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS asset_catalog_ids ON asset_repos(repo,catalog_id);
    CREATE INDEX IF NOT EXISTS works_repository_page ON works(repo,deleted,updated DESC,id);
    CREATE INDEX IF NOT EXISTS works_recent ON works(opened DESC,id) WHERE opened IS NOT NULL AND NOT deleted;
    CREATE INDEX IF NOT EXISTS tasks_work_recent ON tasks(repo,project,created DESC);
    CREATE INDEX IF NOT EXISTS tasks_chat_recent ON tasks(chat,created);
    CREATE INDEX IF NOT EXISTS tasks_expiration ON tasks(expires) WHERE cleaned IS NULL;
    CREATE INDEX IF NOT EXISTS asset_repos_repo ON asset_repos(repo,asset);
    INSERT INTO asset_repos(asset,repo,catalog_id) SELECT DISTINCT asset,repo,asset FROM asset_refs ON CONFLICT DO NOTHING;
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION frame_notify_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_notify('frame_changes', TG_TABLE_NAME); RETURN NULL; END $$;
    DO $$ DECLARE t text; BEGIN
      FOREACH t IN ARRAY ARRAY['tasks','events','auth_flows','settings','engines','connections'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='frame_changed_'||t) THEN
          EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION frame_notify_change()', 'frame_changed_'||t, t);
        END IF;
      END LOOP;
    END $$;
    CREATE OR REPLACE FUNCTION frame_notify_work_sync() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state IS DISTINCT FROM OLD.state THEN PERFORM pg_notify('frame_changes', 'work_sync'); END IF; RETURN NULL; END $$;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='frame_work_sync') THEN
        CREATE TRIGGER frame_work_sync AFTER UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION frame_notify_work_sync();
      END IF;
    END $$;
  `);
  const admin = await pool.query(
    "SELECT value FROM settings WHERE key='admin'",
  );
  if (!password || password.length < 14) {
    await pool.end();
    throw new Error(
      "FRAME_ADMIN_PASSWORD (at least 14 characters) is required on every startup",
    );
  }
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
