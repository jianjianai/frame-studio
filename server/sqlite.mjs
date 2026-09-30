import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrationPlan } from "./migrations.mjs";

const jsonColumns = new Set([
  "value", "input", "result", "data", "metadata", "sync_state", "progress",
  "monitor", "runtime", "request_input", "execution", "review_reference",
  "metrics", "interaction", "payload", "answers", "info", "redirects",
  "blocker", "tasks", "activity", "refs",
]);
const booleanColumns = new Set(["deleted", "enabled", "revoked", "ready", "ok"]);

export function sqliteQuery(sql) {
  let query = sql.replace(/\$([1-9]\d*)/g, "?$1")
    .replace(/(\b\w+\([^()]*\)|\([^()]*\)|[\w.]+(?:->>?'[^']+')*|\?\d+)::(?:bigint|int|integer)\b/gi, "CAST($1 AS INTEGER)")
    .replace(/::(?:jsonb|uuid|text|bigint|int|integer|float8|numeric)(?:\[\])?/gi, "")
    .replace(/\bILIKE\b/gi, "LIKE")
    .replace(/\bjsonb_build_object\s*\(/gi, "json_object(")
    .replace(/\bjsonb_agg\s*\(/gi, "json_group_array(")
    .replace(/\bjsonb_array_elements\s*\(/gi, "json_each(")
    .replace(/\bGREATEST\s*\(/gi, "max(")
    .replace(/\bLEAST\s*\(/gi, "min(")
    .replace(/\bnow\(\)\s*\+\s*interval\s*'([^']+)'/gi, "frame_date_add(frame_now(),'$1')")
    .replace(/\bnow\(\)\s*-\s*interval\s*'([^']+)'/gi, "frame_date_add(frame_now(),'-$1')")
    .replace(/\b(\w+)\s*\+\s*interval\s*'([^']+)'/gi, "frame_date_add($1,'$2')")
    .replace(/\bnow\(\)/gi, "frame_now()")
    .replace(/DEFAULT\s+frame_now\(\)/gi, "DEFAULT (frame_now())")
    .replace(/DEFAULT\s+(frame_date_add\(frame_now\(\),'[^']+'\))/gi, "DEFAULT ($1)")
    .replace(/DEFAULT\s+frame_date_add\(([^)]+)\)/gi, "DEFAULT (frame_date_add($1))")
    .replace(/\bFOR\s+UPDATE\b/gi, "")
    .replace(/\bIS\s+NOT\s+DISTINCT\s+FROM\b/gi, "IS")
    .replace(/\bIS\s+DISTINCT\s+FROM\b/gi, "IS NOT")
    .replace(/\b([\w.]+)\s*=\s*ANY\(\?(\d+)\)/gi, "$1 IN (SELECT value FROM json_each(?$2))")
    .replace(/\b([\w.]+)\s+NOT\s+IN\s*\(\s*SELECT\s+value\s+FROM\s+json_each/gi, "$1 NOT IN (SELECT value FROM json_each")
    .replace(/\bNOT\s*\(\s*([\w.]+)\s+IN\s*\(SELECT value FROM json_each\(\?(\d+)\)\)\s*\)/gi, "$1 NOT IN (SELECT value FROM json_each(?$2))")
    .replace(/\b(\w+)\s*=\s*\1\s*\|\|\s*(\?\d+)/gi, "$1=json_patch($1,$2)");
  query = query.replace(/\bartifact->>/g, "artifact.value->>")
    // PostgreSQL ->> always returns text. SQLite returns a number for JSON numbers,
    // which otherwise hides successful previews when compared with a text version.
    .replace(/([\w.]+(?:->'[^']+')*)->>'([^']+)'/g, "frame_json_text($1,'$2')")
    .replace(/([\w.]+)\s+\?\s*'([\w-]+)'/g, "json_type($1,'$.$2') IS NOT NULL")
    .replace(/\bcommit(?=\s*,)/gi, '"commit"');
  return query;
}

function sqliteMigration(sql) {
  return sql.replace(/--[^\n]*/g, "")
    .replace(/CREATE(?: OR REPLACE)? FUNCTION[\s\S]*?\$\$;/gi, "")
    .replace(/DO \$\$[\s\S]*?\$\$;/gi, "")
    .replace(/(?:CREATE|DROP) TRIGGER[^;]*;/gi, "")
    .replace(/\buuid\b/gi, "text")
    .replace(/\btimestamptz\b/gi, "text")
    .replace(/\bjsonb\b/gi, "json")
    .replace(/\bboolean\b/gi, "integer")
    .replace(/\bbigserial\s+PRIMARY KEY/gi, "integer PRIMARY KEY AUTOINCREMENT")
    .replace(/\bADD COLUMN IF NOT EXISTS\b/gi, "ADD COLUMN")
    .replace(/\bADD COLUMN (\w+) text UNIQUE/gi, "ADD COLUMN $1 text")
    .replace(/\bnow\(\)\s*\+\s*interval\s*'([^']+)'/gi, "frame_date_add(frame_now(),'$1')")
    .replace(/\bnow\(\)/gi, "frame_now()")
    .replace(/DEFAULT\s+frame_now\(\)/gi, "DEFAULT (frame_now())")
    .replace(/DEFAULT\s+(frame_date_add\(frame_now\(\),'[^']+'\))/gi, "DEFAULT ($1)")
    .replace(/::json/gi, "")
    .replace(/\bcommit\s+text\b/gi, '"commit" text')
    .replace(/INSERT INTO asset_repos\(asset,repo,catalog_id\) SELECT DISTINCT asset,repo,asset FROM asset_refs ON CONFLICT DO NOTHING/gi,
      "INSERT OR IGNORE INTO asset_repos(asset,repo,catalog_id) SELECT DISTINCT asset,repo,asset FROM asset_refs");
}

const encode = (value) => value == null ? null : typeof value === "boolean" ? Number(value)
  : typeof value === "object" && !(value instanceof Uint8Array) ? JSON.stringify(value) : value;
function bindings(sql, values) {
  // Node 22 treats SQLite's ?n placeholders as named parameters. Explicit
  // binding also preserves PostgreSQL's repeated and out-of-order $n values.
  const code = sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g,
    "",
  );
  const names = [...new Set([...code.matchAll(/\?([1-9]\d*)/g)].map((m) => m[1]))];
  return names.length
    ? [Object.fromEntries(names.map((n) => ["?" + n, values[Number(n) - 1]]))]
    : values;
}
function decode(row) {
  if (!row) return row;
  const result = { ...row };
  for (const [key, value] of Object.entries(result)) {
    if (value == null) continue;
    if (typeof value === "bigint") {
      const number = Number(value);
      result[key] = booleanColumns.has(key) ? !!value
        : Number.isSafeInteger(number) ? number : String(value);
    } else if (jsonColumns.has(key) && typeof value === "string") {
      try { result[key] = JSON.parse(value); } catch { /* SQL scalar or older data. */ }
    } else if (booleanColumns.has(key)) result[key] = !!value;
  }
  return result;
}

export async function sqliteDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  raw.function("frame_now", () => new Date().toISOString());
  raw.function("frame_date_add", (time, delta) => {
    const match = /^(-?)(\d+) (second|minute|hour|day)s?$/.exec(delta);
    if (!match) throw Error("Invalid date interval: " + delta);
    const factor = { second: 1000, minute: 60000, hour: 3600000, day: 86400000 }[match[3]];
    return new Date(new Date(time).getTime() + (match[1] ? -1 : 1) * Number(match[2]) * factor).toISOString();
  });
  raw.function("right", (value, count) => String(value).slice(-count));
  raw.function("octet_length", (value) => Buffer.byteLength(String(value)));
  raw.function("frame_json_text", (value, key) => {
    if (value == null) return null;
    const item = JSON.parse(value)[key];
    return item == null ? null : typeof item === "object" ? JSON.stringify(item) : String(item);
  });
  raw.exec("CREATE TABLE IF NOT EXISTS frame_schema_migrations (id text PRIMARY KEY,checksum text NOT NULL,applied text NOT NULL DEFAULT (frame_now()))");
  const plan = migrationPlan();
  const known = new Map(plan.map((m) => [m.id, m]));
  for (const row of raw.prepare("SELECT id,checksum FROM frame_schema_migrations").all()) {
    if (!known.has(row.id)) throw Error("Local database schema is newer than this application: " + row.id);
    if (known.get(row.id).checksum !== row.checksum) throw Error("An applied migration was modified: " + row.id);
  }
  for (const item of plan) {
    if (raw.prepare("SELECT 1 FROM frame_schema_migrations WHERE id=?").get(item.id)) continue;
    raw.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of sqliteMigration(item.sql).split(";").map((s) => s.trim()).filter(Boolean)) {
        try { raw.exec(statement); }
        catch (error) {
          if (/duplicate column name/i.test(error.message) && /ALTER TABLE/i.test(statement)) continue;
          throw Error(`${item.id}: ${error.message}\n${statement.slice(0, 200)}`);
        }
      }
      raw.prepare("INSERT INTO frame_schema_migrations(id,checksum) VALUES(?,?)").run(item.id, item.checksum);
      raw.exec("COMMIT");
    } catch (error) { raw.exec("ROLLBACK"); raw.close(); throw error; }
  }
  raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_request_key ON tasks(request_key) WHERE request_key IS NOT NULL");
  // PostgreSQL's data-maintenance triggers are deliberately omitted from the
  // translated DDL. Recreate their observable behavior for the desktop store.
  raw.exec(`
    CREATE TRIGGER IF NOT EXISTS frame_work_revision_local AFTER UPDATE ON works
    WHEN NEW.updated IS NOT OLD.updated OR NEW.title IS NOT OLD.title
      OR NEW.category IS NOT OLD.category OR NEW.status IS NOT OLD.status
      OR NEW.description IS NOT OLD.description OR NEW.deleted IS NOT OLD.deleted
      OR NEW.branch IS NOT OLD.branch
    BEGIN
      UPDATE works SET source_generation=OLD.source_generation+1,
        source_revision=NULL,source_indexed_at=NULL WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS frame_question_insert_local AFTER INSERT ON agent_questions
    BEGIN
      UPDATE tasks SET
        interaction=(SELECT json_object('id',q.id,'title',q.payload->>'title',
          'created',q.created,'count',(SELECT count(*) FROM agent_questions
          WHERE task=NEW.task AND state='pending')) FROM agent_questions q
          WHERE q.task=NEW.task AND q.state='pending' ORDER BY q.created,q.id LIMIT 1),
        input_wait_started=coalesce(input_wait_started,frame_now()) WHERE id=NEW.task;
      INSERT OR IGNORE INTO agent_notifications(task,question,kind,source)
        SELECT NEW.task,NEW.id,'question','question:'||NEW.id WHERE NEW.state='pending';
    END;
    CREATE TRIGGER IF NOT EXISTS frame_question_update_local AFTER UPDATE OF state ON agent_questions
    BEGIN
      UPDATE tasks SET
        interaction=(SELECT json_object('id',q.id,'title',q.payload->>'title',
          'created',q.created,'count',(SELECT count(*) FROM agent_questions
          WHERE task=NEW.task AND state='pending')) FROM agent_questions q
          WHERE q.task=NEW.task AND q.state='pending' ORDER BY q.created,q.id LIMIT 1),
        input_wait_ms=input_wait_ms+CASE WHEN NOT EXISTS
          (SELECT 1 FROM agent_questions WHERE task=NEW.task AND state='pending')
          AND input_wait_started IS NOT NULL
          THEN max(0,cast((julianday(frame_now())-julianday(input_wait_started))*86400000 AS integer))
          ELSE 0 END,
        input_wait_started=CASE WHEN EXISTS
          (SELECT 1 FROM agent_questions WHERE task=NEW.task AND state='pending')
          THEN coalesce(input_wait_started,frame_now()) ELSE NULL END WHERE id=NEW.task;
      UPDATE agent_notifications SET read_at=coalesce(read_at,frame_now())
        WHERE question=NEW.id AND NEW.state<>'pending';
    END;
    CREATE TRIGGER IF NOT EXISTS frame_agent_task_local AFTER UPDATE OF state ON tasks
    WHEN NEW.kind='agent' AND NEW.state IS NOT OLD.state
    BEGIN
      UPDATE agent_questions SET state='cancelled' WHERE task=NEW.id
        AND state='pending' AND NEW.state NOT IN ('running','queued');
      UPDATE agent_notifications SET read_at=coalesce(read_at,frame_now())
        WHERE task=NEW.id AND NEW.state='succeeded';
      INSERT OR IGNORE INTO agent_notifications(task,kind,source)
        SELECT NEW.id,CASE WHEN NEW.state='succeeded' THEN 'completed' ELSE 'failed' END,
          'task:'||NEW.id||':'||NEW.state
        WHERE NEW.state IN ('succeeded','failed','publish_failed');
    END;
  `);

  let held = false;
  const waiters = [];
  const acquire = async () => {
    if (!held) { held = true; return; }
    await new Promise((resolve) => waiters.push(resolve));
  };
  const release = () => { const next = waiters.shift(); if (next) next(); else held = false; };
  const query = (sql, params = []) => {
    if (typeof sql === "object") { params = sql.values || []; sql = sql.text; }
    const text = sqliteQuery(sql.trim());
    const values = params.map(encode);
    if (!values.length && /;\s*\S/.test(text)) { raw.exec(text); return { rows: [], rowCount: 0 }; }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) { raw.exec(text); return { rows: [], rowCount: 0 }; }
    const statement = raw.prepare(text);
    statement.setReadBigInts(true);
    const parameters = bindings(text, values);
    if (/^\s*(SELECT|WITH|PRAGMA)\b|\bRETURNING\b/i.test(text)) {
      const rows = statement.all(...parameters).map(decode);
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...parameters);
    return { rows: [], rowCount: Number(result.changes) };
  };
  const pool = {
    async query(sql, params) { await acquire(); try { return query(sql, params); } finally { release(); } },
    async connect() {
      await acquire();
      let closed = false;
      return {
        query: async (sql, params) => query(sql, params),
        release() { if (!closed) { closed = true; release(); } },
      };
    },
    async end() { raw.close(); },
  };
  const locks = new Map();
  return {
    kind: "sqlite", pool,
    all: async (sql, params = []) => (await pool.query(sql, params)).rows,
    one: async (sql, params = []) => (await pool.query(sql, params)).rows[0],
    async setting(key, value) {
      if (value !== undefined) await pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]);
      return (await pool.query("SELECT value FROM settings WHERE key=$1", [key])).rows[0]?.value;
    },
    async event(task, kind, data) { await pool.query("INSERT INTO events(task,kind,data) VALUES($1,$2,$3)", [task, kind, data]); },
    async lock(key, fn) {
      const old = locks.get(key) || Promise.resolve();
      let done;
      const next = new Promise((resolve) => { done = resolve; });
      const tail = old.then(() => next);
      locks.set(key, tail);
      await old;
      try { return await fn(); } finally { done(); if (locks.get(key) === tail) locks.delete(key); }
    },
  };
}
