import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { migrationPlan } from "../../server/migrations.mjs";
import { sqliteDatabase, sqliteMigration } from "../../server/sqlite.mjs";
import { clearLegacyAiFiles } from "../../server/legacy-ai-cleanup.mjs";

function legacyDatabase(file) {
  const raw = new DatabaseSync(file);
  raw.function("frame_now", () => new Date().toISOString());
  raw.function("frame_date_add", () => new Date(Date.now() + 86400000).toISOString());
  raw.exec("PRAGMA foreign_keys=ON; CREATE TABLE frame_schema_migrations(id text PRIMARY KEY,checksum text,applied text)");
  for (const item of migrationPlan().filter(item => item.id < "0010")) {
    for (const statement of sqliteMigration(item.sql).split(";").map(value => value.trim()).filter(Boolean)) {
      try { raw.exec(statement); } catch (error) {
        if (!/duplicate column name/.test(error.message)) throw error;
      }
    }
    raw.prepare("INSERT INTO frame_schema_migrations(id,checksum) VALUES(?,?)").run(item.id, item.checksum);
  }
  return raw;
}

const makeDirectory = (data, relative, value = "keep") => {
  const dir = path.join(data, relative);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "fixture.txt"), value);
  return dir;
};

test("legacy retirement deletes FRAME conversations and artifacts but preserves native metadata, works, credentials and ordinary tasks", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-retire-ai-"));
  const file = path.join(data, "db.sqlite");
  const raw = legacyDatabase(file);
  const ids = Object.fromEntries(["repo", "work", "chat", "task", "render", "provider", "undo"].map(key => [key, randomUUID()]));
  raw.prepare("INSERT INTO repos(id,name) VALUES(?,?)").run(ids.repo, "Keep repository");
  raw.prepare("INSERT INTO works(id,repo,project,title) VALUES(?,?,?,?)").run(ids.work, ids.repo, "preserved-work", "Keep work");
  raw.prepare("INSERT INTO connections(id,name,tool,mode,config) VALUES(?,?,'codex','api',?)").run(ids.provider, "Keep credentials", "encrypted-provider");
  raw.prepare("INSERT INTO chats(id,repo,project,provider,title,connection) VALUES(?,?,'preserved-work','codex','Delete old chat',?)").run(ids.chat, ids.repo, ids.provider);
  raw.prepare("INSERT INTO tasks(id,repo,project,kind,state,input,chat,container) VALUES(?,?,'preserved-work','agent','succeeded','{}',?,?)").run(ids.task, ids.repo, ids.chat, "frame-task-" + ids.task);
  raw.prepare("INSERT INTO tasks(id,repo,project,kind,state,input) VALUES(?,?,'preserved-work','render','succeeded','{}')").run(ids.render, ids.repo);
  raw.prepare("INSERT INTO events(task,kind,data) VALUES(?,'message',?)").run(ids.task, JSON.stringify({ text: "Delete content" }));
  raw.prepare("INSERT INTO events(task,kind,data) VALUES(?,'log',?)").run(ids.render, JSON.stringify({ text: "Keep export log" }));
  raw.prepare("INSERT INTO work_undos(id,work,task,expected_commit,expected_revision,state) VALUES(?,?,?,'before','revision','succeeded')").run(ids.undo, ids.work, ids.task);
  raw.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run("preview:legacy", JSON.stringify({ task: ids.task }));
  raw.exec("CREATE TABLE paseo_native_fixture(id text PRIMARY KEY,data text)");
  raw.prepare("INSERT INTO paseo_native_fixture VALUES(?,?)").run(ids.work, "Preserve native messages");
  raw.close();
  const legacyRun = makeDirectory(data, "runs/" + ids.task);
  fs.writeFileSync(path.join(legacyRun, "task.json"), JSON.stringify({ id: ids.task, kind: "agent" }));
  makeDirectory(data, "sessions/" + ids.task);
  makeDirectory(data, "sessions/" + ids.chat);
  makeDirectory(data, "restores/undo-" + ids.undo);
  const preserved = ["runs/" + ids.render, "paseo/" + ids.work, "works/" + ids.work, "blobs/material"].map(relative => makeDirectory(data, relative));
  let db;
  try {
    db = await sqliteDatabase(file);
    assert.equal((await db.all("SELECT name FROM sqlite_master WHERE name='chats' OR name LIKE 'agent_%'")).length, 0);
    assert.equal((await db.all("PRAGMA table_info(tasks)")).some(column => ["chat", "interaction", "input_wait_started", "input_wait_ms"].includes(column.name)), false);
    assert.equal((await db.all("SELECT id FROM tasks")).length, 1);
    assert.equal((await db.all("SELECT task FROM events"))[0].task, ids.render);
    assert.equal((await db.all("SELECT id FROM works"))[0].id, ids.work);
    assert.equal((await db.all("SELECT config FROM connections"))[0].config, "encrypted-provider");
    assert.equal((await db.all("SELECT data FROM paseo_native_fixture"))[0].data, "Preserve native messages");
    assert.equal((await db.all("SELECT key FROM settings WHERE key='preview:legacy'")).length, 0);
    assert.equal((await db.all("SELECT id FROM work_undos")).length, 0);
    const calls = [];
    const runCommand = async (bin, args) => {
      assert.equal(bin, "docker"); calls.push(args);
      if (args[0] === "container") return "exact-container-id\n";
      if (args[0] === "inspect") return JSON.stringify({ Name: "/frame-task-" + ids.task, Config: { Labels: { "frame.task": ids.task } }, State: { Running: false }, Mounts: [
        { Type: "bind", Source: path.join("/host/retired-frame", "runs", ids.task), Destination: "/workspace", RW: true },
        { Type: "bind", Source: path.join("/host/retired-frame", "sessions", ids.chat), Destination: "/sessions", RW: true },
        { Type: "bind", Source: "/host/retired-frame/tools", Destination: "/tools", RW: false },
      ] });
      assert.deepEqual(args, ["rm", "frame-task-" + ids.task]); return "";
    };
    assert.deepEqual(await clearLegacyAiFiles({ db, data, hostData: "/host/retired-frame", localMode: false, runCommand }), { retiredIdentities: 3, removedDirectories: 4 });
    assert.equal(calls.length, 3);
    for (const dir of preserved) assert(fs.existsSync(path.join(dir, "fixture.txt")));
    assert.equal(fs.existsSync(legacyRun), false);
    assert.deepEqual(await clearLegacyAiFiles({ db, data, localMode: false, runCommand }), { retiredIdentities: 0, removedDirectories: 0 });
  } finally {
    await db?.pool.end(); fs.rmSync(data, { recursive: true, force: true });
  }
});

test("retirement refuses active legacy AI, wrong container identities and symlink targets; failed cleanup stays resumable", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-retire-ai-reject-"));
  const file = path.join(data, "db.sqlite");
  const raw = legacyDatabase(file);
  const id = randomUUID();
  raw.prepare("INSERT INTO tasks(id,kind,state,input) VALUES(?,'agent','running','{}')").run(id);
  raw.close();
  let db;
  try {
    await assert.rejects(sqliteDatabase(file), /Stop or finish legacy/);
    const retry = new DatabaseSync(file);
    assert.equal(retry.prepare("SELECT state FROM tasks WHERE id=?").get(id).state, "running");
    retry.prepare("UPDATE tasks SET state='cancelled',container=? WHERE id=?").run("frame-task-" + id, id); retry.close();
    db = await sqliteDatabase(file);
    const keep = makeDirectory(data, "runs/" + id);
    await assert.rejects(clearLegacyAiFiles({ db, data, localMode: false, runCommand: async (_bin, args) => args[0] === "container" ? "foreign\n" : JSON.stringify({ Name: "/frame-task-" + id, Config: { Labels: { "frame.task": randomUUID() } }, State: { Running: false } }) }), /identity.*does not match/);
    assert(fs.existsSync(keep));
    assert.equal((await db.all("SELECT * FROM legacy_ai_cleanup")).length, 1);
    await db.pool.query("UPDATE legacy_ai_cleanup SET container=NULL");
    fs.rmSync(keep, { recursive: true });
    const foreign = makeDirectory(data, "foreign");
    fs.symlinkSync(foreign, keep, "dir");
    await assert.rejects(clearLegacyAiFiles({ db, data, localMode: true }), /ownership does not match/);
    assert(fs.existsSync(path.join(foreign, "fixture.txt")));
    assert.equal((await db.all("SELECT * FROM legacy_ai_cleanup")).length, 1);
  } finally {
    await db?.pool.end(); fs.rmSync(data, { recursive: true, force: true });
  }
});

test("mount rejection preserves every legacy session and journal before cleanup, including a task with no stored container field", async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-retire-mounts-")), file = path.join(data, "db.sqlite");
  const db = await sqliteDatabase(file), task = randomUUID(), chat = randomUUID(), work = randomUUID();
  t.after(async () => { await db.pool.end(); fs.rmSync(data, { recursive: true, force: true }); });
  await db.pool.query("INSERT INTO legacy_ai_cleanup(kind,id,container) VALUES('chat',$1,NULL),('task',$2,NULL)", [chat, task]);
  const run = makeDirectory(data, "runs/" + task), session = makeDirectory(data, "sessions/" + chat), current = makeDirectory(data, "works/" + work);
  fs.writeFileSync(path.join(run, "task.json"), JSON.stringify({ id: task, kind: "agent" }));
  const hostData = "/host/owned-frame", good = { Type: "bind", Source: path.join(hostData, "runs", task), Destination: "/workspace", RW: true };
  const removed = [];
  for (const mounts of [
    [{ ...good, Source: path.join(hostData, "works", work) }],
    [good, { Type: "bind", Source: path.join(hostData, "paseo", work), Destination: "/native", RW: true }],
    [good, { Type: "bind", Source: path.join(hostData, "works", work), Destination: "/other", RW: true }],
  ]) {
    const runCommand = async (_bin, args) => {
      if (args[0] === "container") return "owned-container-id";
      if (args[0] === "inspect") return JSON.stringify({ Name: "/frame-task-" + task,
        Config: { Labels: { "frame.task": task } }, State: { Running: false }, Mounts: mounts });
      removed.push(args); return "";
    };
    await assert.rejects(clearLegacyAiFiles({ db, data, hostData, localMode: false, runCommand }), /mount/);
    assert.equal(removed.length, 0);
    for (const folder of [run, session, current]) assert(fs.existsSync(path.join(folder, "fixture.txt")));
    assert.equal((await db.all("SELECT * FROM legacy_ai_cleanup")).length, 2);
  }
});

test("PostgreSQL retires legacy chat schema atomically and keeps general scoped notifications usable", {
  skip: !process.env.FRAME_TEST_DATABASE_URL,
}, async () => {
  const pg = await import("pg");
  const { migrate } = await import("../../server/migrations.mjs");
  const original = new URL(process.env.FRAME_TEST_DATABASE_URL);
  assert.match(original.pathname, /^\/frame_test/);
  const name = "frame_test_retirement_" + randomUUID().replaceAll("-", "");
  const adminUrl = new URL(original); adminUrl.pathname = "/postgres";
  const ownUrl = new URL(original); ownUrl.pathname = "/" + name;
  const admin = new pg.Client({ connectionString: adminUrl.href });
  let pool, created = false;
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + name + '"'); created = true;
    pool = new pg.Pool({ connectionString: ownUrl.href });
    await migrate(pool, migrationPlan().filter(item => item.id < "0010"));
    const repo = randomUUID(), work = randomUUID(), chat = randomUUID(), legacy = randomUUID(), render = randomUUID();
    await pool.query("INSERT INTO repos(id,name) VALUES($1,'keep')", [repo]);
    await pool.query("INSERT INTO works(id,repo,project,title) VALUES($1,$2,'film','keep')", [work, repo]);
    await pool.query("INSERT INTO chats(id,repo,project,provider,title) VALUES($1,$2,'film','codex','remove')", [chat, repo]);
    await pool.query("INSERT INTO tasks(id,repo,project,kind,state,input,chat) VALUES($1,$2,'film','agent','running','{}',$3)", [legacy, repo, chat]);
    await assert.rejects(migrate(pool), /Stop or finish legacy/);
    assert.equal((await pool.query("SELECT state FROM tasks WHERE id=$1", [legacy])).rows[0].state, "running");
    await pool.query("UPDATE tasks SET state='cancelled' WHERE id=$1", [legacy]);
    await pool.query("INSERT INTO tasks(id,repo,project,kind,state,input) VALUES($1,$2,'film','render','succeeded','{}')", [render, repo]);
    await pool.query("INSERT INTO events(task,kind,data) VALUES($1,'log','{}')", [render]);
    await migrate(pool);
    assert.equal((await pool.query("SELECT to_regclass('chats') AS table")).rows[0].table, null);
    assert.equal((await pool.query("SELECT to_regclass('agent_questions') AS table")).rows[0].table, null);
    assert.deepEqual((await pool.query("SELECT id FROM tasks")).rows.map(row => row.id), [render]);
    await pool.query("INSERT INTO events(task,kind,data) VALUES($1,'log','{}')", [render]);
    await pool.query("UPDATE tasks SET state='failed' WHERE id=$1", [render]);
    await pool.query("UPDATE works SET title='still editable' WHERE id=$1", [work]);
    assert.equal((await pool.query("SELECT title FROM works WHERE id=$1", [work])).rows[0].title, "still editable");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM legacy_ai_cleanup")).rows[0].n, 2);
    await migrate(pool);
  } finally {
    await pool?.end();
    if (created) await admin.query('DROP DATABASE "' + name + '"');
    await admin.end();
  }
});
