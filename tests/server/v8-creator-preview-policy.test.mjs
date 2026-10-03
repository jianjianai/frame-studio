import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workTools } from "../../server/work-tools.mjs";
import { workOperations } from "../../server/work-operations.mjs";
import { z } from "zod";

function paseoFixture(work = { id: randomUUID() }) {
  let handler;
  const reads = [],
    calls = [];
  workTools({
    app: {
      post(route, callback) {
        assert.equal(route, "/api/agent/action");
        handler = callback;
      },
    },
    db: {
      one: async (sql, args) => {
        reads.push({ sql, args });
        return work;
      },
    },
    actions: {
      call: async (name, args) => {
        calls.push({ name, args });
        return { url: "/fixture-live", mode: "live" };
      },
    },
  });
  return { request: (body) => handler(body), reads, calls, work };
}

test("Paseo preview resolves its unique work workspace from the credential without source arguments", async () => {
  const f = paseoFixture(),
    task = {
      id: randomUUID(),
      repo: randomUUID(),
      project: "film",
      state: "running",
      kind: "paseo",
    };
  const result = await f.request({
    agentTask: task,
    body: { name: "preview" },
  });
  assert.deepEqual(result, { url: "/fixture-live", mode: "live" });
  assert.equal(f.reads.length, 1);
  assert.match(
    f.reads[0].sql,
    /WHERE repo=\$1 AND project=\$2 AND NOT deleted/,
  );
  assert.deepEqual(f.reads[0].args, [task.repo, task.project]);
  assert.deepEqual(f.calls, [
    {
      name: "works_live_preview",
      args: { id: f.work.id, ai: true },
    },
  ]);
});

test("Paseo preview rejects arbitrary work, task, capability and nested arguments before database lookup", async () => {
  const f = paseoFixture(),
    task = { kind: "paseo", id: randomUUID(), repo: randomUUID(), project: "film" };
  for (const args of [
    { id: randomUUID() },
    { work: randomUUID() },
    { task: randomUUID() },
    { ai: false },
    { url: "https://example.invalid" },
    { options: {} },
    null,
    [],
    42,
  ]) {
    await assert.rejects(
      () => f.request({ agentTask: task, body: { name: "preview", args } }),
      { statusCode: 400 },
    );
  }
  assert.equal(f.reads.length, 0);
  assert.equal(f.calls.length, 0);
});

test("Paseo preview requires native credentials and refuses missing or deleted bound works", async () => {
  const noTask = paseoFixture();
  await assert.rejects(() => noTask.request({ body: { name: "preview" } }), {
    statusCode: 403,
  });
  assert.equal(noTask.reads.length, 0);
  const missing = paseoFixture(null);
  await assert.rejects(
    () =>
      missing.request({
        agentTask: { kind: "paseo", id: randomUUID(), repo: randomUUID(), project: "film" },
        body: { name: "preview", args: {} },
      }),
    { statusCode: 404 },
  );
  assert.equal(missing.calls.length, 0);
});

test("AI browser opens only the unique live workspace and rejects retired draft selectors", async () => {
  let operation;
  const calls = [], registry = {};
  for (const name of ["files", "files_page", "read", "write", "patch", "search", "delete_file"])
    registry["project_" + name] = { description: "Fixture source operation", schema: z.object({}), fn: assert.fail };
  workOperations({
    add(name, _description, shape, fn) {
      if (name === "works_browser") operation = { schema: z.strictObject(shape), fn };
    },
    registry, data: "/fixture", repos: {}, assets: {}, tasks: {},
    db: { one: () => assert.fail("Live browser cannot fall through to an immutable build") },
  });
  const id = randomUUID();
  const invoke = async value => operation.fn(operation.schema.parse(value));
  for (const value of [{ id, task: randomUUID() }, { id, source: "paseo" }, { id, paseoAgent: "other" }])
    await assert.rejects(invoke(value), /Unrecognized key/);
  await assert.rejects(invoke({ id }), error => error.statusCode === 503);
  registry.works_live_preview = {
    schema: z.strictObject({ id: z.uuid(), ai: z.boolean(), mediaMode: z.enum(["original", "compressed", "cached"]).optional() }),
    fn(value) {
      calls.push(value);
      return { sessionId: randomUUID(), url: "/preview-live/fixture/index.html", source: "work" };
    },
  };
  const result = await invoke({ id, mediaMode: "original" });
  assert.deepEqual(calls, [{ id, ai: true, mediaMode: "original" }]);
  assert.equal(result.previewMode, "live");
  assert.equal(result.source, "work");
  assert.match(result.url, /\/preview-live\//);
  await assert.rejects(invoke({ id, mode: "snapshot", mediaMode: "compressed" }), error => error.statusCode === 400);
});
