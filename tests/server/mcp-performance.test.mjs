import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import Fastify from "fastify";
import { EventEmitter } from "node:events";
import { requestAbortSignal } from "../../server/request-abort.mjs";
import {
  McpServer,
  createMcpHandler,
  PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
} from "@modelcontextprotocol/server";
import { createPreparedMcpHandler } from "../../server/mcp-catalog.mjs";
import { platformToolkitOperations } from "../../server/platform-toolkit.mjs";
import { Tasks } from "../../server/tasks.mjs";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import {
  notifyTaskStatus,
  subscribeTaskStatus,
  readTaskStatus,
  withTaskStatusSignal,
} from "../../server/task-status-wait.mjs";

const decode = async (response) => {
  const body = await response.text();
  return response.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)))
        .find((value) => value.id !== undefined)
    : JSON.parse(body);
};
function registryStatus(db, tasks) {
  const registry = {};
  platformToolkitOperations({
    add(name, description, shape, fn) {
      registry[name] = (args) => fn(z.object(shape).parse(args));
    },
    registry,
    db,
    tasks,
    works: {},
  });
  return registry.task_status;
}

test("MCP shares immutable schemas and registers only the called tool for isolated exchanges", async (t) => {
  const registry = {
    engines_list: {
      description: "engines",
      schema: z.object({
        count: z.number().int().positive().default(3),
      }),
    },
    works_list: {
      description: "works",
      schema: z.object({ value: z.string().default("work") }),
    },
    tokens_create: { description: "private", schema: z.object({}) },
  };
  let conversions = 0;
  for (const op of Object.values(registry)) {
    const json = op.schema["~standard"].jsonSchema.input;
    op.schema["~standard"].jsonSchema.input = (...args) => {
      conversions++;
      return json(...args);
    };
  }
  const handler = createPreparedMcpHandler({
    registry,
    serverInfo: { name: "fixture", version: "1" },
    execute: async (name, args, ctx) => {
      assert(ctx.mcpReq.signal instanceof AbortSignal);
      await delay(2);
      return {
        content: [{ type: "text", text: JSON.stringify({ name, ...args }) }],
      };
    },
  });
  t.after(() => handler.close());
  assert.equal(conversions, 2);
  const original = McpServer.prototype.registerTool,
    registrations = [];
  McpServer.prototype.registerTool = function (name, ...args) {
    registrations.push(name);
    return original.call(this, name, ...args);
  };
  t.after(() => {
    McpServer.prototype.registerTool = original;
  });
  let id = 0;
  const rpc = async (method, params = {}, modern = false) => {
    const body = {
      jsonrpc: "2.0",
      id: ++id,
      method,
      params: modern
        ? {
            ...params,
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_INFO_META_KEY]: { name: "fixture-client", version: "1" },
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          }
        : params,
    };
    const request = new Request("http://frame.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(modern
          ? {
              "MCP-Protocol-Version": "2026-07-28",
              "Mcp-Method": method,
              ...(method === "tools/call" ? { "Mcp-Name": params.name } : {}),
            }
          : {}),
      },
      body: JSON.stringify(body),
    });
    return decode(await handler.fetch(request, { parsedBody: body }));
  };
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  });
  assert(initialized.result.capabilities.tools);
  assert.equal(registrations.length, 0);
  const list = await rpc("tools/list");
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    ["frame_engines_list", "frame_works_list"],
  );
  assert(list.result.tools[0]._meta.securitySchemes);
  assert.equal(registrations.length, 0);
  for (const modern of [false, true]) {
    const values = await Promise.all([
      rpc("tools/call", { name: "frame_engines_list", arguments: {} }, modern),
      rpc("tools/call", { name: "frame_works_list", arguments: {} }, modern),
    ]);
    assert(values[0].result, JSON.stringify({ modern, response: values[0] }));
    assert(values[1].result, JSON.stringify({ modern, response: values[1] }));
    assert.equal(JSON.parse(values[0].result.content[0].text).count, 3);
    assert.equal(JSON.parse(values[1].result.content[0].text).value, "work");
    const invalid = await rpc(
      "tools/call",
      {
        name: "frame_engines_list",
        arguments: { count: -1 },
      },
      modern,
    );
    assert(invalid.result.isError);
    const privateCall = await rpc(
      "tools/call",
      { name: "frame_tokens_create" },
      modern,
    );
    assert.equal(privateCall.error.code, -32602);
    const again = await rpc("tools/list", {}, modern);
    assert.deepEqual(
      again.result.tools.map((tool) => tool.name),
      list.result.tools.map((tool) => tool.name),
    );
  }
  assert.equal(registrations.length, 6);
  assert.equal(conversions, 2);
  const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
  const notified = await handler.fetch(
    new Request("http://frame.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(notification),
    }),
    { parsedBody: notification },
  );
  assert.equal(notified.status, 202);
  assert.equal(registrations.length, 6);
});

test("raw Request calls and request size failures keep the SDK contract", async () => {
  const handler = createPreparedMcpHandler({
    registry: {
      engines_list: { description: "fixture", schema: z.object({}) },
    },
    serverInfo: { name: "fixture", version: "1" },
    options: { maxRequestBodySize: 1024 },
    execute: () => ({ content: [{ type: "text", text: "ready" }] }),
  });
  const request = (body, contentType = "application/json") =>
    new Request("http://frame.test/mcp", {
      method: "POST",
      headers: {
        "content-type": contentType,
        accept: "application/json, text/event-stream",
      },
      body,
    });
  try {
    const success = await decode(
      await handler.fetch(
        request(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "frame_engines_list" },
          }),
        ),
      ),
    );
    assert.equal(success.result.content[0].text, "ready");
    assert.equal(
      (
        await handler.fetch(
          request(JSON.stringify({ payload: "x".repeat(2048) })),
        )
      ).status,
      413,
    );
    assert.equal((await handler.fetch(request("{malformed"))).status, 400);
    assert.equal(
      (await handler.fetch(request("{}", "text/plain"))).status,
      415,
    );
  } finally {
    await handler.close();
  }
});

test("legacy mixed batches preserve SDK results with known and unknown tools", async () => {
  const registry = {
    engines_list: {
      description: "fixture",
      schema: z.object({ count: z.number().default(2) }),
    },
  };
  const execute = (_name, args) => ({
    content: [{ type: "text", text: String(args.count) }],
  });
  const prepared = createPreparedMcpHandler({
    registry,
    execute,
    serverInfo: { name: "fixture", version: "1" },
  });
  const baseline = createMcpHandler(() => {
    const server = new McpServer({ name: "fixture", version: "1" });
    server.registerTool(
      "frame_engines_list",
      {
        description: "fixture",
        inputSchema: registry.engines_list.schema,
      },
      (args) => execute("engines_list", args),
    );
    return server;
  });
  const batch = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "frame_engines_list", arguments: {} },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "frame_unknown" },
    },
  ];
  const call = async (handler) => {
    const response = await handler.fetch(
      new Request("http://frame.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(batch),
      }),
      { parsedBody: batch },
    );
    const body = await response.text();
    const value = response.headers
      .get("content-type")
      ?.includes("text/event-stream")
      ? body
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)))
      : JSON.parse(body);
    return { status: response.status, value };
  };
  try {
    assert.deepEqual(await call(prepared), await call(baseline));
  } finally {
    await prepared.close();
    await baseline.close();
  }
});

test("MCP transport cancellation releases status waits without cancelling durable tasks", async () => {
  const id = randomUUID(),
    db = {
      async all() {
        return [];
      },
    };
  const tasks = {
    async summary() {
      return { id, state: "running", kind: "build" };
    },
  };
  const status = registryStatus(db, tasks);
  let entered, finished, failure, activeSignal;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const ended = new Promise((resolve) => {
    finished = resolve;
  });
  const handler = createPreparedMcpHandler({
    registry: {
      task_status: {
        description: "wait",
        schema: z.object({ id: z.string(), waitMs: z.number() }),
      },
    },
    serverInfo: { name: "fixture", version: "1" },
    execute: async (_name, args, ctx) => {
      activeSignal = ctx.mcpReq.signal;
      entered();
      try {
        const value = await withTaskStatusSignal(ctx.mcpReq.signal, () =>
          status(args),
        );
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (error) {
        failure = error;
        return { content: [{ type: "text", text: "aborted" }], isError: true };
      } finally {
        finished();
      }
    },
  });
  const controller = new AbortController();
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "frame_task_status",
      arguments: { id, waitMs: 10000 },
    },
  };
  const responsePromise = handler.fetch(
    new Request("http://frame.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }),
    { parsedBody: body },
  );
  try {
    await started;
    controller.abort();
    await ended;
    assert(activeSignal.aborted);
    assert.equal(failure, activeSignal.reason);
    assert.equal((await tasks.summary()).state, "running");
    const subscriptions = Array.from({ length: 1024 }, () =>
      subscribeTaskStatus(db, id),
    );
    subscriptions.forEach((subscription) => subscription.close());
    const response = await responsePromise;
    await response.body?.cancel();
  } finally {
    await handler.close();
  }
});

test("task state and result events project hidden inputs at the database, including SQLite", async (t) => {
  const data = fs.mkdtempSync(
    path.join(os.tmpdir(), "frame-status-projection-"),
  );
  const db = await sqliteDatabase(path.join(data, "data.sqlite"));
  t.after(async () => {
    await db.pool.end();
    fs.rmSync(data, { recursive: true, force: true });
  });
  const id = randomUUID(),
    result = {
      input: { manifest: "x".repeat(1024 * 1024) },
      status: "complete",
      artifacts: [{ path: "projects/fixture/exports/frame.png", bytes: 9 }],
    };
  await db.pool.query(
    "INSERT INTO tasks(id,kind,project,state,input,result) VALUES($1,'build','fixture','succeeded',$2,$3)",
    [id, { secret: true }, result],
  );
  await db.pool.query(
    "INSERT INTO events(id,task,kind,data) VALUES($1,$2,'result',$3)",
    ["9007199254740993", id, result],
  );
  await db.pool.query(
    "INSERT INTO events(id,task,kind,data) VALUES($1,$2,'result',$3)",
    ["9007199254740994", id, result],
  );
  const tasks = {
    db,
    summary: (key) => Tasks.prototype.summary.call({ db }, key),
  };
  const full = await Tasks.prototype.get.call({ db }, id);
  const scalar = await db.one("SELECT 1 AS enabled,0 AS deleted,7 AS count");
  assert.deepEqual(scalar, { enabled: true, deleted: false, count: 7 });
  assert.equal(full.result.input.manifest.length, 1024 * 1024);
  const summary = await tasks.summary(id);
  assert.equal(summary.result.status, "complete");
  assert.equal(summary.result.input, undefined);
  const status = registryStatus(db, tasks);
  const page = await status({
    id,
    after: "9007199254740992",
    limit: 1,
    waitMs: 10000,
  });
  assert(page.done);
  assert(page.hasMore);
  assert.equal(page.nextAfter, "9007199254740993");
  assert.equal(page.task.result.artifactCount, 1);
  assert.equal(page.events[0].data.artifactCount, 1);
  assert(JSON.stringify(page).length < 2000);
  const final = await status({ id, after: page.nextAfter, limit: 1 });
  assert.equal(final.nextAfter, "9007199254740994");
  assert(!final.hasMore);
  await assert.rejects(tasks.summary(randomUUID()), { statusCode: 404 });
});

test("notification waits do not lose changes during SELECT and filter unrelated tasks", async () => {
  const db = {},
    id = randomUUID(),
    other = randomUUID();
  const waiter = subscribeTaskStatus(db, id);
  const before = waiter.revision;
  notifyTaskStatus(db, { table: "tasks", task: other });
  assert.equal(waiter.revision, before);
  notifyTaskStatus(db, { table: "works", task: id });
  assert.equal(waiter.revision, before);
  notifyTaskStatus(db, { table: "events", task: id });
  await waiter.wait(before, 10000); // notification preceded the sleep
  const next = waiter.revision;
  const waiting = waiter.wait(next, 10000);
  notifyTaskStatus(db, null); // reconnect conservatively refreshes every waiter
  await waiting;
  waiter.close();
  const revision = waiter.revision;
  notifyTaskStatus(db, null);
  assert.equal(waiter.revision, revision);
});

test("matching concurrent cursors coalesce queries but never cache completed results", async () => {
  let release,
    calls = 0,
    eventCalls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tasks = {
    async summary(id) {
      calls++;
      await gate;
      return { id };
    },
  };
  const db = {
    async all() {
      eventCalls++;
      return [];
    },
  };
  const args = { id: randomUUID(), after: "9007199254740993", limit: 30 };
  const first = readTaskStatus(db, tasks, args),
    second = readTaskStatus(db, tasks, args);
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(eventCalls, 1);
  await readTaskStatus(db, tasks, args);
  assert.equal(calls, 2);
});

test("long status waits wake promptly, abort without cancelling tasks and release capacity", async () => {
  const id = randomUUID(),
    db = {
      async all() {
        return [];
      },
    };
  let state = "running",
    calls = 0,
    entered;
  const initialRead = new Promise((resolve) => {
    entered = resolve;
  });
  const tasks = {
    async summary() {
      calls++;
      entered();
      return { id, state, kind: "build" };
    },
  };
  const status = registryStatus(db, tasks);
  const waiting = status({ id, waitMs: 10000 });
  await initialRead;
  state = "succeeded";
  notifyTaskStatus(db, { table: "tasks", task: id });
  const result = await waiting;
  assert(result.done);
  assert.equal(calls, 2);

  state = "running";
  const cancellation = new AbortController();
  const abortedWait = withTaskStatusSignal(cancellation.signal, () =>
    status({ id, waitMs: 10000 }),
  );
  await delay(5);
  cancellation.abort();
  await assert.rejects(abortedWait, { name: "AbortError" });
  assert.equal(state, "running");
  const subscriptions = Array.from({ length: 1024 }, () =>
    subscribeTaskStatus(db, id),
  );
  assert.throws(() => subscribeTaskStatus(db, id), { statusCode: 503 });
  subscriptions.forEach((subscription) => subscription.close());
  const replacement = subscribeTaskStatus(db, id);
  replacement.close();
});

test("status waits recover without notifications and release subscriptions on read errors", async () => {
  const id = randomUUID(),
    db = {
      async all() {
        return [];
      },
    };
  let calls = 0;
  const tasks = {
    async summary() {
      calls++;
      return {
        id,
        kind: "build",
        state: calls === 1 ? "running" : "succeeded",
      };
    },
  };
  const result = await registryStatus(db, tasks)({ id, waitMs: 3000 });
  assert(result.done);
  assert.equal(calls, 2); // fallback, before the deadline, without LISTEN
  const failure = new Error("database unavailable");
  const failedStatus = registryStatus(db, {
    summary: async () => {
      throw failure;
    },
  });
  await assert.rejects(failedStatus({ id, waitMs: 10000 }), failure);
  const subscriptions = Array.from({ length: 1024 }, () =>
    subscribeTaskStatus(db, id),
  );
  subscriptions.forEach((subscription) => subscription.close());
});

test("HTTP API disconnect aborts the wait and releases subscriptions without cancelling a task", async (t) => {
  const id = randomUUID(),
    db = {
      async all() {
        return [];
      },
    };
  let entered, finished;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const ended = new Promise((resolve) => {
    finished = resolve;
  });
  const tasks = {
    async summary() {
      entered();
      return { id, kind: "build", state: "running" };
    },
  };
  const status = registryStatus(db, tasks),
    app = Fastify();
  app.post("/api/action", async (req, res) => {
    try {
      return await withTaskStatusSignal(requestAbortSignal(req, res), () =>
        status(req.body.args),
      );
    } finally {
      finished();
    }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const cancellation = new AbortController();
  const request = fetch(
    `http://127.0.0.1:${app.server.address().port}/api/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "task_status",
        args: { id, waitMs: 10000 },
      }),
      signal: cancellation.signal,
    },
  );
  await started;
  cancellation.abort();
  await assert.rejects(request, { name: "AbortError" });
  await ended;
  assert.equal((await tasks.summary()).state, "running");
  const subscriptions = Array.from({ length: 1024 }, () =>
    subscribeTaskStatus(db, id),
  );
  subscriptions.forEach((subscription) => subscription.close());
});

test("request signals remove listeners after success and abort already disconnected sockets", () => {
  const req = { raw: new EventEmitter() },
    res = { raw: new EventEmitter() };
  const signal = requestAbortSignal(req, res);
  res.raw.writableEnded = true;
  res.raw.emit("finish");
  assert(!signal.aborted);
  assert.equal(req.raw.listenerCount("aborted"), 0);
  assert.equal(res.raw.listenerCount("close"), 0);
  assert.equal(res.raw.listenerCount("finish"), 0);
  const disconnected = {
    raw: Object.assign(new EventEmitter(), { destroyed: true }),
  };
  assert(requestAbortSignal(req, disconnected).aborted);
  assert.equal(req.raw.listenerCount("aborted"), 0);
  assert.equal(disconnected.raw.listenerCount("close"), 0);
});
