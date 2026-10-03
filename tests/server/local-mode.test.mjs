import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { createApp } from "../../server/app.mjs";
import { readWorkPreview } from "../../server/preview-state.mjs";
import { PREVIEW_VERSION } from "../../server/preview-version.mjs";


test("local mode accepts alternate hosts and missing or opaque origins", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-local-origins-"));
  const db = await sqliteDatabase(path.join(data, "frame.sqlite"));
  let app;
  try {
    ({ app } = await createApp({ db, data, masterKey: "11".repeat(32),
      origin: "http://local.frame.test", scheduler: false, localMode: true }));
    for (const requestOrigin of [undefined, "null", "http://alias.test", "https://alias.test"]) {
      const response = await app.inject({ method: "POST", url: "/api/action",
        headers: { host: "192.168.1.25:43173",
          ...(requestOrigin === undefined ? {} : { origin: requestOrigin }) },
        payload: { name: "repositories_list", args: {} } });
      assert.equal(response.statusCode, 200, response.body);
    }
  } finally {
    if (app) await app.close();
    else await db.pool.end();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("SQLite keeps work revisions and ordinary task state", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-sqlite-state-"));
  const db = await sqliteDatabase(path.join(data, "frame.sqlite"));
  const repo = "10000000-0000-4000-8000-000000000001";
  const work = "10000000-0000-4000-8000-000000000002";
  const task = "10000000-0000-4000-8000-000000000003";
  try {
    await db.pool.query("INSERT INTO repos(id,name) VALUES($1,$2)", [repo, "Local"]);
    await db.pool.query("INSERT INTO works(id,repo,project,title) VALUES($1,$2,$3,$4)", [work, repo, "sample", "First"]);
    await db.pool.query("UPDATE works SET title=$2 WHERE id=$1", [work, "Second"]);
    assert.equal((await db.one("SELECT source_generation FROM works WHERE id=$1", [work])).source_generation, 1);
    await db.pool.query("INSERT INTO tasks(id,repo,project,kind,state,input) VALUES($1,$2,$3,$4,$5,$6)",
      [task, repo, "sample", "render", "running", {}]);
    assert.equal((await db.one("SELECT state FROM tasks WHERE id=$1", [task])).state, "running");
    assert.equal((await db.all("SELECT name FROM sqlite_master WHERE name='agent_questions'")).length, 0);
  } finally {
    await db.pool.end();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("SQLite preserves PostgreSQL JSON text comparisons and numeric expiration casts", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-sqlite-preview-"));
  const db = await sqliteDatabase(path.join(data, "frame.sqlite"));
  try {
    const repo = "10000000-0000-4000-8000-000000000001", task = "10000000-0000-4000-8000-000000000002";
    await db.pool.query("INSERT INTO repos(id,name) VALUES($1,$2)", [repo, "Preview"]);
    await db.pool.query("INSERT INTO tasks(id,repo,project,kind,state,input,result,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [task, repo, "preview", "build", "succeeded", {}, { previewVersion: PREVIEW_VERSION, runtimeFingerprint: "test-runtime" }, "source"]);
    const preview = await readWorkPreview({ db, work: { repo, project: "preview", source_revision: "source" }, runtime: { fingerprint: "test-runtime" } });
    assert.equal(preview.latest.id, task);
    assert.equal(preview.stale, false);
    await db.pool.query("INSERT INTO settings(key,value) VALUES($1,$2)", ["preview:test", { expires: 1000, enabled: true }]);
    assert.equal((await db.one("SELECT value->>'enabled' AS flag_text FROM settings WHERE (value->>'expires')::bigint>$1", [999])).flag_text, "true");
    assert.equal(await db.one("SELECT key FROM settings WHERE (value->>'expires')::bigint>$1", [1001]), undefined);
  } finally { await db.pool.end(); fs.rmSync(data, { recursive: true, force: true }); }
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
    const alternate = await app.inject({ method: "POST", url: "/api/action",
      headers: { host: "local.frame.test", origin: "http://alias.test" }, payload: { name: "repositories_list", args: {} } });
    assert.equal(alternate.statusCode, 200);
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
    await call("works_versions", { id: work.id });
    await call("works_context", { id: work.id });
    if (!providers[0].configured)
      assert.ok(["unavailable", "unconfigured"].includes(providers[0].state));
    // FRAME no longer admits old chat writes, even when native CLI credentials are configured.
    const retired = await app.inject({ method: "POST", url: "/api/action", headers,
      payload: { name: "works_chat_create", args: { id: work.id, connection: providers[0].id, title: "Retired API" } } });
    assert.notEqual(retired.statusCode, 200);
    assert.match(retired.body, /Unknown/);
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
    assert.equal((await call("works_preview_status", { id: work.id })).latest.id, preview.id);
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
