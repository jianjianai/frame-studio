import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskPublication } from "../../server/task-publication.mjs";
import { agentTools } from "../../server/agent-tools.mjs";

async function publicationFixture(result, inspect) {
  const data = fs.mkdtempSync(
    path.join(os.tmpdir(), "frame-v8-publish-policy-"),
  );
  const id = randomUUID(),
    project = "film",
    destination = path.join(data, "destination");
  const source = path.join(data, "runs", id, "projects", project);
  for (const dir of [destination, source]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "project.ts"), "unchanged fixture");
  }
  const queries = [],
    changes = [];
  const task = {
    id,
    repo: randomUUID(),
    project,
    kind: "agent",
    state: "publishing",
    input: { prompt: "Fixture" },
    result: { status: "passed", previewTask: randomUUID(), ...result },
  };
  const repos = {
    project: async () => ({ dir: destination }),
    checkpoint: async () => "a".repeat(40),
    onChange: async (...args) => changes.push(args),
  };
  const db = {
    lock: async (_key, callback) => callback(),
    pool: {
      query: async (sql, args) => {
        queries.push({ sql, args });
        return { rowCount: 1 };
      },
    },
  };
  try {
    await new TaskPublication({ db, data, repos }).publish(task);
    await inspect({ queries, changes, task, data, source });
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
}

test("V8 AI publication saves the source and notifies live watchers without queueing a full audio build", async () => {
  await publicationFixture(
    { previewMode: "live" },
    ({ queries, changes, task }) => {
      assert.equal(
        queries.filter((q) => q.sql.startsWith("INSERT INTO tasks")).length,
        0,
      );
      assert.deepEqual(changes, [[task.repo, task.project]]);
      const completion = queries.find((q) =>
        q.sql.startsWith("UPDATE tasks SET state='succeeded'"),
      );
      assert.equal(completion.args[1].previewMode, "live");
      assert.equal(completion.args[1].commit, "a".repeat(40));
      assert(queries.some((q) => q.sql.startsWith("INSERT INTO events")));
    },
  );
});

test("legacy AI publication continues queueing one compatibility build when there is no live mode", async () => {
  await publicationFixture({}, ({ queries, task }) => {
    const builds = queries.filter((q) => q.sql.startsWith("INSERT INTO tasks"));
    assert.equal(builds.length, 1);
    assert.match(builds[0].sql, /'build','\{\}'/);
    assert.deepEqual(builds[0].args, [
      task.result.previewTask,
      task.repo,
      task.project,
    ]);
  });
});

function agentFixture(work = { id: randomUUID() }) {
  let handler;
  const reads = [],
    calls = [];
  agentTools({
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

test("agent preview resolves its work from the bound task and scopes the active draft without user arguments", async () => {
  const f = agentFixture(),
    task = {
      id: randomUUID(),
      repo: randomUUID(),
      project: "film",
      state: "running",
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
      args: { id: f.work.id, task: task.id, ai: true },
    },
  ]);
});

test("agent preview rejects arbitrary work, task, capability and nested arguments before database lookup", async () => {
  const f = agentFixture(),
    task = { id: randomUUID(), repo: randomUUID(), project: "film" };
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

test("agent preview requires task credentials and refuses missing or deleted bound works", async () => {
  const noTask = agentFixture();
  await assert.rejects(() => noTask.request({ body: { name: "preview" } }), {
    statusCode: 403,
  });
  assert.equal(noTask.reads.length, 0);
  const missing = agentFixture(null);
  await assert.rejects(
    () =>
      missing.request({
        agentTask: { id: randomUUID(), repo: randomUUID(), project: "film" },
        body: { name: "preview", args: {} },
      }),
    { statusCode: 404 },
  );
  assert.equal(missing.calls.length, 0);
});
