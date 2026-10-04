import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { WebSocket } from "ws";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { fixture } from "../mcp/helpers.mjs";
import { until } from "./ai-test-fixture.mjs";

test("Native memory activity reaches real scoped PostgreSQL WebSocket subscribers without writing native summaries", {
  skip: !process.env.FRAME_TEST_DATABASE_URL, timeout: 60000,
}, async t => {
  const original = new URL(process.env.FRAME_TEST_DATABASE_URL); assert.match(original.pathname, /frame_test/);
  const name = "frame_test_native_push_" + randomUUID().replaceAll("-", ""), adminUrl = new URL(original); adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.href }); await admin.connect();
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "frame-native-push-")), film = fixture();
  let created = false, db, services, ws, restoreQuery;
  t.after(async () => {
    restoreQuery?.();
    ws?.terminate(); await services?.app.close();
    if (db && !db.pool.ending && !db.pool.ended) await db.pool.end();
    if (created) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [name]);
      await admin.query('DROP DATABASE "' + name + '"');
    }
    await admin.end(); film.close(); await fs.rm(data, { recursive: true, force: true });
  });
  await admin.query('CREATE DATABASE "' + name + '"'); created = true;
  const own = new URL(original); own.pathname = "/" + name;
  db = await database(own.href, "owned-native-push-password");
  const origin = "http://native-push.test";
  services = await createApp({ db, data, masterKey: "63".repeat(32), origin, scheduler: false });
  const { app, actions, ai } = services, works = [];
  for (const title of ["Native push A", "Native push B"]) {
    const repo = await actions.call("repositories_add", { name: title });
    await fs.cp(film.file(""), path.join(data, "repos", repo.id, "projects/test-film"), { recursive: true });
    await actions.works.discover(repo.id);
    const work = (await actions.call("works_page", { repo: repo.id })).items[0];
    const prepared = await ai.work.prepare(work.id);
    await ai.store.updateRuntime(work.id, { state: "ready", projectId: work.id, cwd: prepared.workspace.workspaceRoot });
    works.push({ ...work, cwd: prepared.workspace.workspaceRoot });
  }
  const [a, b] = works, client = ai.manager.client;
  client.connect = async () => {};
  let sequence = 0;
  const thread = (work, id) => ({ id, projectId: work.id, worktreePath: null, session: { status: "running" } });
  const first = thread(a, "native-a"), second = thread(b, "native-b");
  const upsert = value => client.apply({ kind: "thread-upserted", thread: value, sequence: ++sequence });
  const terminal = value => {
    if (value.type === "snapshot") client.terminals = new Map(value.terminals.map(item => [JSON.stringify([item.threadId, item.terminalId]), item]));
    else if (value.type === "upsert") client.terminals.set(JSON.stringify([value.terminal.threadId, value.terminal.terminalId]), value.terminal);
    else client.terminals.delete(JSON.stringify([value.threadId, value.terminalId]));
    client.terminalsReady = true; client.emit("terminal", value);
  };
  client.apply({ kind: "snapshot", snapshot: { projects: works.map(work => ({ id: work.id, workspaceRoot: work.cwd })),
    threads: [first, second], snapshotSequence: sequence } });
  terminal({ type: "snapshot", terminals: [] }); await ai.manager.flushActivity();
  const queries = [], query = Object.getPrototypeOf(db.pool).query, ownQuery = Object.getOwnPropertyDescriptor(db.pool, "query");
  db.pool.query = function (...args) { queries.push(typeof args[0] === "string" ? args[0] : args[0].text); return query.apply(this, args); };
  restoreQuery = () => { if (ownQuery) Object.defineProperty(db.pool, "query", ownQuery); else delete db.pool.query; };
  const calls = new Map(), call = actions.call;
  actions.call = async (operation, args) => {
    if (operation === "works_ai_status") calls.set(args.id, (calls.get(args.id) || 0) + 1);
    return call(operation, args);
  };
  const login = await app.inject({ method: "POST", url: "/api/login", headers: { origin }, payload: { password: "owned-native-push-password" } });
  const cookie = login.headers["set-cookie"].split(";")[0];
  await app.listen({ host: "127.0.0.1", port: 0 });
  ws = new WebSocket("ws://127.0.0.1:" + app.server.address().port + "/api/ws", { headers: { origin, cookie } });
  const messages = []; ws.on("message", value => messages.push(JSON.parse(value))); await once(ws, "open");
  for (const work of works) ws.send(JSON.stringify({ type: "subscribe", id: work.id, name: "works_ai_status", args: { id: work.id } }));
  ws.send(JSON.stringify({ type: "subscribe", id: "background", name: "works_background", args: {} }));
  const latest = id => messages.filter(message => message.id === id).at(-1)?.result;
  await until(() => latest(a.id)?.native.activeThreads.length === 1 && latest(b.id)?.native.activeThreads.length === 1 && latest("background")?.length === 2);
  await delay(200); queries.length = 0;
  const initial = [calls.get(a.id), calls.get(b.id)];
  for (let i = 0; i < 500; i++) upsert({ ...first, messages: [{ text: "streamed " + i }], usage: { inputTokens: i } });
  await ai.manager.flushActivity(); await delay(180);
  assert.deepEqual([calls.get(a.id), calls.get(b.id)], initial);
  assert.deepEqual(queries, [], "Native token/usage chunks issue neither binding queries nor NOTIFY SQL");
  upsert({ ...first, hasPendingApprovals: true }); await ai.manager.flushActivity();
  await until(() => latest(a.id)?.native.pendingPermissions === 1);
  assert.equal(calls.get(b.id), initial[1], "The other work subscription is not refreshed");
  assert(queries.some(sql => sql.startsWith("SELECT pg_notify")), "The existing PostgreSQL channel carries the in-memory invalidation");
  assert(!queries.some(sql => /^\s*(?:UPDATE|INSERT INTO) ai_work_bindings\b/.test(sql) && /native_summary|last_observed/.test(sql)));
  upsert({ ...first, projectId: b.id }); await ai.manager.flushActivity();
  await until(() => latest(a.id)?.native.activeThreads.length === 0 && latest(b.id)?.native.activeThreads.length === 2);
  await until(() => latest("background")?.length === 1 && latest("background")[0].id === b.id);
  const busy = { threadId: first.id, terminalId: "owned-shell", cwd: b.cwd, worktreePath: null, status: "running", hasRunningSubprocess: true };
  terminal({ type: "upsert", terminal: busy }); await ai.manager.flushActivity();
  await until(() => latest(b.id)?.native.activeTerminals === 1);
  terminal({ type: "remove", threadId: first.id, terminalId: busy.terminalId }); await ai.manager.flushActivity();
  await until(() => latest(b.id)?.native.activeTerminals === 0);
  client.terminalsReady = false; client.emit("disconnect"); await ai.manager.flushActivity();
  await until(() => latest(a.id)?.native.incomplete === true && latest(b.id)?.native.incomplete === true);
  terminal({ type: "snapshot", terminals: [] }); await ai.manager.flushActivity();
  await until(() => latest(a.id)?.native.incomplete === false && latest(b.id)?.native.incomplete === false);
});
