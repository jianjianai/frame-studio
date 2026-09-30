import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { createApp } from "../../server/app.mjs";

test("SQLite keeps work revisions and agent interaction state", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-sqlite-state-"));
  const db = await sqliteDatabase(path.join(data, "frame.sqlite"));
  const repo = "10000000-0000-4000-8000-000000000001";
  const work = "10000000-0000-4000-8000-000000000002";
  const task = "10000000-0000-4000-8000-000000000003";
  const question = "10000000-0000-4000-8000-000000000004";
  try {
    await db.pool.query("INSERT INTO repos(id,name) VALUES($1,$2)", [repo, "Local"]);
    await db.pool.query("INSERT INTO works(id,repo,project,title) VALUES($1,$2,$3,$4)", [work, repo, "sample", "First"]);
    await db.pool.query("UPDATE works SET title=$2 WHERE id=$1", [work, "Second"]);
    assert.equal((await db.one("SELECT source_generation FROM works WHERE id=$1", [work])).source_generation, 1);
    await db.pool.query("INSERT INTO tasks(id,repo,project,kind,state,input) VALUES($1,$2,$3,$4,$5,$6)",
      [task, repo, "sample", "agent", "running", {}]);
    await db.pool.query("INSERT INTO agent_questions(id,task,request_key,payload) VALUES($1,$2,$3,$4)",
      [question, task, "one", { title: "A question" }]);
    assert.equal((await db.one("SELECT interaction FROM tasks WHERE id=$1", [task])).interaction.id, question);
    assert.equal((await db.one("SELECT count(*) AS n FROM agent_notifications WHERE task=$1 AND kind='question'", [task])).n, 1);
    await db.pool.query("UPDATE agent_questions SET state='answered' WHERE id=$1", [question]);
    assert.equal((await db.one("SELECT interaction FROM tasks WHERE id=$1", [task])).interaction, null);
    await db.pool.query("UPDATE tasks SET state='succeeded' WHERE id=$1", [task]);
    assert.equal((await db.one("SELECT count(*) AS n FROM agent_notifications WHERE task=$1 AND kind='completed'", [task])).n, 1);
  } finally {
    await db.pool.end();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("Windows local mode creates a work and renders a frame without Docker or a password", {
  skip: process.platform !== "win32",
  timeout: 180000,
}, async () => {
  const previous = { local: process.env.FRAME_LOCAL_MODE, url: process.env.FRAME_PUBLIC_URL,
    browser: process.env.FRAME_BROWSER };
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  if (!process.env.FRAME_BROWSER && fs.existsSync(edge)) process.env.FRAME_BROWSER = edge;
  process.env.FRAME_LOCAL_MODE = "1";
  process.env.FRAME_PUBLIC_URL = "http://127.0.0.1:43173";
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-local-test-"));
  let app;
  try {
    const db = await sqliteDatabase(path.join(data, "frame.sqlite"));
    ({ app } = await createApp({ db, data, masterKey: "11".repeat(32),
      origin: process.env.FRAME_PUBLIC_URL, scheduler: true, localMode: true }));
    const headers = { host: "127.0.0.1:43173", origin: process.env.FRAME_PUBLIC_URL };
    const me = await app.inject({ url: "/api/me", headers });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().localMode, true);
    const bad = await app.inject({ method: "POST", url: "/api/action",
      headers: { ...headers, origin: "http://evil.test" }, payload: { name: "repositories_list", args: {} } });
    assert.equal(bad.statusCode, 403);
    const call = async (name, args) => {
      const response = await app.inject({ method: "POST", url: "/api/action", headers, payload: { name, args } });
      assert.equal(response.statusCode, 200, `${name}: ${response.body}`);
      return response.json();
    };
    const repo = await call("repositories_add", { name: "Local" });
    const work = await call("works_create", { repo: repo.id, title: "Local Film" });
    assert.equal((await call("works_page", {})).items[0].id, work.id);
    assert.equal((await call("works_open", { id: work.id })).id, work.id);
    assert.deepEqual(await call("works_background", {}), []);
    assert.deepEqual(await call("works_exports", { id: work.id }), []);
    const status = await call("system_status", {});
    assert.equal(status.docker.mode, "windows-native");
    assert.equal(status.queue.queued, 0);
    const providers = await call("connections_list", {});
    assert.deepEqual(providers.map((p) => p.tool), ["codex", "claude"]);
    assert.equal((await call("repositories_page", {})).total, 1);
    assert.deepEqual(await call("assets_list", {}), []);
    await db.pool.query("INSERT INTO assets(id,name,sha,bytes,mime,license) VALUES($1,$2,$3,$4,$5,$6)",
      ["20000000-0000-4000-8000-000000000001", "Test asset", "a".repeat(64), 0, "text/plain", "test"]);
    assert.deepEqual((await call("assets_list", {}))[0].refs, []);
    assert.equal((await call("engines_list", {})).length, 3);
    assert.deepEqual(await call("works_chats", { id: work.id }), []);
    await call("works_versions", { id: work.id });
    await call("works_context", { id: work.id });
    const chat = await call("works_chat_create", { id: work.id, connection: providers[0].id, title: "Local CLI" });
    assert.equal(chat.provider, "codex");
    assert.equal((await call("works_chats", { id: work.id })).length, 1);
    const task = await call("works_task", { id: work.id, kind: "frame", input: { time: 0, width: 640 } });
    assert.ok(Array.isArray(await call("works_background", {})));
    assert.equal((await call("works_page", {})).items[0].activity?.id, task.id);
    await call("works_queue_status", { id: work.id });
    const waitForTask = async (id) => {
      let state;
      for (let i = 0; i < 65; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        state = (await call("task_get", { id })).task;
        if (["succeeded", "failed", "cancelled"].includes(state.state)) break;
      }
      const logFile = path.join(data, "runs", id, "worker.log");
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-3000) : "no worker log";
      assert.equal(state?.state, "succeeded", JSON.stringify(state) + "\n" + log);
      return state;
    };
    await waitForTask(task.id);
    const video = await call("works_task", { id: work.id, kind: "render",
      input: { start: 0, end: 1, width: 640, fps: 12 } });
    await waitForTask(video.id);
    assert.equal((await call("works_exports", { id: work.id }))[0].id, video.id);
    const preview = await call("works_task", { id: work.id, kind: "build", input: {} });
    await waitForTask(preview.id);
  } finally {
    await app?.close();
    fs.rmSync(data, { recursive: true, force: true });
    if (previous.local === undefined) delete process.env.FRAME_LOCAL_MODE;
    else process.env.FRAME_LOCAL_MODE = previous.local;
    if (previous.url === undefined) delete process.env.FRAME_PUBLIC_URL;
    else process.env.FRAME_PUBLIC_URL = previous.url;
    if (previous.browser === undefined) delete process.env.FRAME_BROWSER;
    else process.env.FRAME_BROWSER = previous.browser;
  }
});
