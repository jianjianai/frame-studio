import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import {
  decodeNotification,
  notificationMatches,
} from "../../src/contracts/realtime-scope.mjs";
import {
  operationError,
  clientOperationError,
  uncertainOperation,
} from "../../src/contracts/errors.mjs";
import { operationContracts } from "../../src/contracts/platform.mjs";

async function until(fn) {
  for (let i = 0; i < 150; i++) {
    if (fn()) return;
    await delay(20);
  }
  throw Error("Timed out waiting for realtime result");
}

test("scoped notifications reject unrelated work/task identities, with safe legacy and reconnect fallback", () => {
  const repo = randomUUID(),
    work = randomUUID(),
    task = randomUUID();
  const scope = { repo, work, task, project: "film" };
  const change = decodeNotification(
    JSON.stringify({
      table: "tasks",
      repo,
      work,
      task,
      project: "film",
      secret: "must-not-be-carried",
    }),
  );
  assert(!JSON.stringify(change).includes("secret"));
  assert.equal(notificationMatches(change, ["tasks"], scope), true);
  assert.equal(
    notificationMatches({ ...change, task: randomUUID() }, ["tasks"], scope),
    false,
  );
  assert.equal(
    notificationMatches({ ...change, repo: randomUUID() }, ["tasks"], scope),
    false,
  );
  assert.equal(
    notificationMatches({ ...change, project: "other" }, ["tasks"], scope),
    false,
  );
  assert.equal(notificationMatches(change, ["events"], scope), false);
  assert.equal(
    notificationMatches(decodeNotification("tasks"), ["tasks"], scope),
    true,
  );
  assert.equal(
    notificationMatches(decodeNotification("not-json!"), ["tasks"], scope),
    true,
  );
});

test("shared errors preserve recovery semantics and hide internal failures; uncertain writes are not automatically replayable", () => {
  const conflict = operationError(
    Object.assign(Error("Source changed"), {
      statusCode: 409,
      code: "UNDO_BASE_CHANGED",
      recovery: "review-result",
    }),
    "request-1",
  );
  const client = clientOperationError(conflict);
  assert.equal(client.code, "UNDO_BASE_CHANGED");
  assert.equal(client.recovery, "review-result");
  assert.equal(client.retryable, false);
  assert.equal(conflict.requestId, "request-1");
  assert(
    !JSON.stringify(
      operationError(Error("password=private; SQL internal failure")),
    ).includes("password"),
  );
  const catalogFailure = operationError(Object.assign(Error("无法获取模型（HTTP 404），可手动添加"), { statusCode: 502, expose: true }), "catalog-1");
  assert.equal(catalogFailure.status, 502);
  assert.match(catalogFailure.error, /HTTP 404/);
  assert.equal(catalogFailure.requestId, "catalog-1");
  assert(!operationError(Object.assign(Error("private upstream body"), { statusCode: 502 })).error.includes("private"));
  assert.equal(uncertainOperation("Response lost").code, "OPERATION_UNCERTAIN");
  assert.equal(uncertainOperation("Response lost").retryable, false);
  assert(Object.keys(operationContracts).length >= 20);
});

const url = process.env.FRAME_TEST_DATABASE_URL;
test(
  "real PostgreSQL scoped push refreshes only the changed work, retains event cursors and reports queue blockers",
  { skip: !url, timeout: 30000 },
  async () => {
    assert.match(new URL(url).pathname, /frame_test/);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-v5-stream-"));
    const db = await database(url, "v5-stream-fixture-password");
    await db.pool.query(
      "TRUNCATE repos,tasks,events,chats,works,connections,assets,engines,auth_flows CASCADE",
    );
    const origin = "http://v5-stream.test";
    const { app, actions } = await createApp({
      db,
      data,
      masterKey: "14".repeat(32),
      origin,
      scheduler: false,
    });
    let ws;
    try {
      const repo = await actions.call("repositories_add", {
        name: "Scoped push fixture",
      });
      const a = await actions.call("works_create", {
        repo: repo.id,
        title: "Work A",
      });
      const b = await actions.call("works_create", {
        repo: repo.id,
        title: "Work B",
      });
      const ta = await actions.call("works_task", {
        id: a.id,
        kind: "build",
        requestKey: randomUUID(),
      });
      const tb = await actions.call("works_task", { id: b.id, kind: "build" });
      const original = actions.call;
      const counts = new Map();
      actions.call = async (name, args) => {
        if (name === "works_tasks")
          counts.set(args.id, (counts.get(args.id) || 0) + 1);
        return original(name, args);
      };
      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { origin },
        payload: { password: "v5-stream-fixture-password" },
      });
      const cookie = login.headers["set-cookie"].split(";")[0];
      await app.listen({ host: "127.0.0.1", port: 0 });
      ws = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/api/ws`, {
        headers: { origin, cookie },
      });
      const messages = [];
      ws.on("message", (bytes) => messages.push(JSON.parse(bytes.toString())));
      await once(ws, "open");
      const send = (value) => ws.send(JSON.stringify(value));
      send({
        type: "subscribe",
        id: "a",
        name: "works_tasks",
        args: { id: a.id },
      });
      send({
        type: "subscribe",
        id: "b",
        name: "works_tasks",
        args: { id: b.id },
      });
      send({
        type: "subscribe",
        id: "events",
        name: "task_get",
        args: { id: ta.id },
      });
      await until(
        () =>
          messages.some((m) => m.id === "a") &&
          messages.some((m) => m.id === "b") &&
          messages.some((m) => m.id === "events"),
      );
      await delay(250);
      const baselineA = counts.get(a.id),
        baselineB = counts.get(b.id);
      await db.pool.query("UPDATE tasks SET progress=$2 WHERE id=$1", [
        ta.id,
        { stage: "Scoped update" },
      ]);
      await until(() => counts.get(a.id) > baselineA);
      await delay(160);
      assert.equal(
        counts.get(b.id),
        baselineB,
        "an unrelated work must not even repeat its query",
      );
      await db.event(ta.id, "message", {
        id: "m1",
        text: "First persisted event",
      });
      await until(() =>
        messages.some(
          (m) =>
            m.id === "events" &&
            m.result?.events?.some((e) => e.data?.id === "m1"),
        ),
      );
      const first = messages
        .flatMap((m) => (m.id === "events" ? m.result?.events || [] : []))
        .find((e) => e.data?.id === "m1");
      await db.event(ta.id, "message", {
        id: "m2",
        text: "Second persisted event",
      });
      await until(() =>
        messages.some(
          (m) =>
            m.id === "events" &&
            m.result?.events?.some((e) => e.data?.id === "m2"),
        ),
      );
      assert.equal(
        messages
          .flatMap((m) => (m.id === "events" ? m.result?.events || [] : []))
          .filter((e) => e.id === first.id).length,
        1,
      );
      send({
        type: "call",
        id: "invalid",
        name: "works_undo",
        args: { id: "invalid" },
      });
      await until(() => messages.some((m) => m.id === "invalid"));
      const wireError = messages.find((m) => m.id === "invalid");
      const httpError = await app.inject({
        method: "POST",
        url: "/api/action",
        headers: { origin, cookie },
        payload: { name: "works_undo", args: { id: "invalid" } },
      });
      assert.equal(wireError.code, "INVALID_REQUEST");
      assert.equal(httpError.json().code, wireError.code);
      await db.setting("controller-runtime", {
        checked: Date.now(),
        leader: true,
        docker: { ok: true },
        limits: { concurrency: 1 },
      });
      await db.pool.query(
        "UPDATE tasks SET state='running',started=now() WHERE id=$1",
        [tb.id],
      );
      const status = await actions.call("works_queue_status", { id: a.id });
      assert.equal(status.items[0].code, "capacity");
      const connection = randomUUID();
      await db.pool.query(
        "UPDATE tasks SET input=jsonb_build_object('connection',$2::text) WHERE id IN ($1,$3)",
        [ta.id, connection, tb.id],
      );
      assert.equal(
        (await actions.call("works_queue_status", { id: a.id })).items[0].code,
        "connection-busy",
      );
    } finally {
      ws?.terminate();
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
