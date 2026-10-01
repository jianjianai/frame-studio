import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./paseo-test-fixture.mjs";

test("Legacy conversation projection is bounded/read-only and uses actual normalized PG messages without raw envelopes", async (t) => {
  const f = await fixture(t),
    chat = randomUUID(),
    task = randomUUID(),
    connection = randomUUID();
  await f.db.pool.query(
    "INSERT INTO chats(id,repo,project,provider,title,upstream,connection) VALUES($1,$2,'fixture','codex','Old native conversation','old-session',NULL)",
    [chat, f.work.repo],
  );
  await f.db.pool.query(
    "INSERT INTO tasks(id,repo,project,kind,state,input,chat,execution) VALUES($1,$2,'fixture','agent','succeeded',$3,$4,$5)",
    [
      task,
      f.work.repo,
      { prompt: "Old request", rawProviderEnvelope: "not-public" },
      chat,
      { provider: "codex", connection, authGeneration: "0" },
    ],
  );
  await f.db.event(task, "agent-item", {
    id: "m-one",
    kind: "message",
    text: "intermediate",
  });
  await f.db.event(task, "agent-item", {
    id: "m-one",
    kind: "message",
    text: "Final message",
    password: "not-public",
  });
  await f.db.event(task, "activity", {
    env: { API_KEY: "not-public" },
    text: "private worker",
  });
  await f.db.event(task, "agent-item", {
    id: "human-answer",
    kind: "question",
    question: {
      state: "answered",
      payload: { questions: [{ id: "pace", question: "开场节奏？" }] },
      answers: { pace: { selected: ["tight"], text: "保留当前音乐" } },
    },
  });
  const rowsBefore = await f.db.all("SELECT * FROM chats");
  const tasksBefore = await f.db.all("SELECT * FROM tasks");
  const eventsBefore = await f.db.all("SELECT * FROM events");
  const history = await f.workService.legacyHistory(f.work.id, chat);
  assert.equal(history.readOnly, true);
  assert.equal(history.turns[0].prompt, "Old request");
  assert.match(history.turns[0].response, /^Final message\n用户已回答：/);
  assert.match(history.turns[0].response, /保留当前音乐/);
  assert.doesNotMatch(
    JSON.stringify(history),
    /rawProviderEnvelope|not-public|API_KEY|authGeneration|old-session/,
  );
  const bounded = await f.workService.legacyHistory(f.work.id, chat, {
    maxTextBytes: 5,
  });
  assert.ok(
    Buffer.byteLength(
      bounded.turns.map((turn) => turn.prompt + turn.response).join(""),
    ) <= 5,
  );
  assert.equal(bounded.truncated, true);
  const descriptor = await f.workService.legacyImportDescriptor(
    f.work.id,
    chat,
  );
  assert.equal(descriptor.verified, false);
  assert.equal(descriptor.nativeSessionId, "old-session");
  assert.equal(descriptor.execution.connection, connection);
  assert.deepEqual(await f.db.all("SELECT * FROM chats"), rowsBefore);
  assert.deepEqual(await f.db.all("SELECT * FROM tasks"), tasksBefore);
  assert.deepEqual(await f.db.all("SELECT * FROM events"), eventsBefore);
});

test("Legacy history and import evidence cannot cross a work owner even if the client knows its conversation ID", async (t) => {
  const f = await fixture(t),
    foreign = randomUUID();
  await f.db.pool.query(
    "INSERT INTO chats(id,repo,project,provider,title) VALUES($1,$2,'other-project','claude','Foreign')",
    [foreign, f.work.repo],
  );
  assert.deepEqual(await f.workService.legacyChats(f.work.id), []);
  await assert.rejects(
    f.workService.legacyHistory(f.work.id, foreign),
    /does not belong/,
  );
  await assert.rejects(
    f.workService.legacyImportDescriptor(f.work.id, foreign),
    /does not belong/,
  );
});
