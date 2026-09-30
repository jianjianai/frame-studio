import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { McpServer } from "@modelcontextprotocol/server";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
const root = path.resolve(import.meta.dirname, "../.."),
  owned = path.join(root, ".cache/performance-protocol", randomUUID());
const result = {
  node: process.version,
  baseline: "5a9d970",
  time: new Date().toISOString(),
  measurements: [],
};
let app;
async function measure(name, fn, n = 10) {
  let value;
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    value = await fn();
    samples.push(performance.now() - t);
  }
  const a = [...samples].sort((a, b) => a - b);
  result.measurements.push({
    name,
    n,
    medianMs: +a[Math.floor(a.length / 2)].toFixed(2),
    minMs: +a[0].toFixed(2),
    maxMs: +a.at(-1).toFixed(2),
  });
  return value;
}
try {
  if (
    !/\/frame_test[^/]*$/.test(
      new URL(process.env.FRAME_TEST_DATABASE_URL).pathname,
    )
  )
    throw Error("Use isolated frame_test database");
  const db = await database(
      process.env.FRAME_TEST_DATABASE_URL,
      "protocol-fixture-only-1234",
    ),
    created = await createApp({
      db,
      data: owned,
      masterKey: "1b".repeat(32),
      origin: "http://frame.perf",
      scheduler: false,
    });
  app = created.app;
  const access = await created.actions.call("tokens_create", {
    name: "protocol fixture only",
  });
  const headers = {
    authorization: "Bearer " + access.token,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  let rpcId = 0;
  const rpc = async (method, params = {}) => {
    const id = ++rpcId;
    const r = await app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: { jsonrpc: "2.0", id, method, params },
    });
    if (r.statusCode !== 200) throw Error(r.body);
    return r;
  };
  await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "perf", version: "1" },
  });
  const original = McpServer.prototype.registerTool;
  let registrations = 0;
  McpServer.prototype.registerTool = function (...args) {
    registrations++;
    return original.apply(this, args);
  };
  try {
    await measure("HTTP API engines_list with authentication", () =>
      app.inject({
        method: "POST",
        url: "/api/action",
        headers,
        payload: { name: "engines_list", args: {} },
      }),
    );
    const before = registrations;
    await measure("HTTP MCP engines_list with authentication", () =>
      rpc("tools/call", { name: "frame_engines_list", arguments: {} }),
    );
    result.mcpRegistrationsPerCheapCall = (registrations - before) / 10;
    await measure(
      "HTTP MCP 8 cheap calls in parallel batch elapsed",
      () =>
        Promise.all(
          Array.from({ length: 8 }, () =>
            rpc("tools/call", { name: "frame_engines_list", arguments: {} }),
          ),
        ),
      3,
    );
  } finally {
    McpServer.prototype.registerTool = original;
  }
  const id = randomUUID();
  await db.pool.query(
    "INSERT INTO tasks(id,kind,state,input,result) VALUES($1,'build','running',$2,$3)",
    [id, {}, { input: { manifest: "x".repeat(1024 * 1024) }, artifacts: [] }],
  );
  await measure("task get full row 1 MiB hidden manifest", () =>
    created.tasks.get(id),
  );
  await measure("task summary projected row 1 MiB hidden manifest", () =>
    db.one(
      "SELECT id,kind,state,result - 'input' AS result FROM tasks WHERE id=$1",
      [id],
    ),
  );
  let queryCount = 0,
    transferChars = 0;
  const get = created.tasks.get.bind(created.tasks);
  created.tasks.get = async (task) => {
    queryCount++;
    const v = await get(task);
    transferChars += JSON.stringify(v).length;
    return v;
  };
  const waited = await measure(
    "task_status waitMs=1000 no events 1 MiB hidden manifest",
    () => created.actions.call("task_status", { id, waitMs: 1000 }),
    1,
  );
  result.longPoll = {
    taskGets: queryCount,
    fullTaskJsonChars: transferChars,
    responseBytes: Buffer.byteLength(JSON.stringify(waited)),
  };
} catch (e) {
  result.error = e.stack;
  process.exitCode = 1;
} finally {
  await app?.close();
  fs.rmSync(owned, { recursive: true, force: true });
  fs.writeFileSync(
    path.join(root, "records/performance-20260930/protocol-results.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
}
