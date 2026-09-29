import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { ingestAgentEvents } from "../../server/agent-event-store.mjs";
import { hash } from "../../server/security.mjs";

const url = process.env.FRAME_TEST_DATABASE_URL;
const question = (key = "fixture-question") => ({
  requestKey: key,
  title: "确认创作方向",
  questions: [
    {
      id: "pace",
      question: "开场节奏？",
      options: [
        { id: "tight", label: "紧凑" },
        { id: "slow", label: "舒缓" },
      ],
      allowOther: true,
    },
    {
      id: "keep",
      question: "保留哪些内容？",
      multiSelect: true,
      options: [
        { id: "audio", label: "音乐" },
        { id: "subtitles", label: "字幕" },
      ],
    },
  ],
});
const answer = {
  pace: { selected: ["tight"], text: "" },
  keep: { selected: ["audio", "subtitles"], text: "结尾保持当前长度" },
};

test(
  "Agent human input is durable, ordered, scoped, idempotent and cancellation-safe with notifications",
  { skip: !url, timeout: 60000 },
  async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-agent-input-"));
    const db = await database(url, "fixture-password-at-least-14");
    await db.pool.query(
      "TRUNCATE repos,connections,github_accounts,auth_flows RESTART IDENTITY CASCADE",
    );
    const origin = "http://frame-agent.test";
    const { app, actions, tasks } = await createApp({
      db,
      data,
      masterKey: "91".repeat(32),
      origin,
      scheduler: false,
    });
    const call = (name, args = {}) => actions.call(name, args);
    try {
      const repo = await call("repositories_add", {
        name: "Agent input fixture",
      });
      const work = await call("works_create", {
        repo: repo.id,
        title: "Agent fixture",
      });
      const other = await call("works_create", {
        repo: repo.id,
        title: "Other work",
      });
      const connection = await call("connections_save", {
        name: "Fixture",
        tool: "codex",
        mode: "api",
        model: "fixture-model",
        apiKey: "fixture-only-key",
      });
      const chat = await call("works_chat_create", {
        id: work.id,
        connection: connection.id,
      });
      const task = await call("works_chat_send", {
        id: work.id,
        chat: chat.id,
        prompt: "制作开场",
        model: "fixture-model",
        requestKey: randomUUID(),
      });
      await db.pool.query(
        "UPDATE tasks SET state='running',started=now() WHERE id=$1",
        [task.id],
      );
      const dir = path.join(data, "runs", task.id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "events.ndjson");
      const write = (value) =>
        fs.appendFileSync(file, JSON.stringify(value) + "\n");
      write({
        type: "agent-item",
        version: 1,
        id: "prose",
        kind: "message",
        phase: "completed",
        text: "先检查已有动画，再确认方向。",
        at: Date.now(),
      });
      write({
        type: "agent-item",
        version: 1,
        id: "read",
        kind: "tool",
        phase: "completed",
        title: "读取 scene.ts",
        at: Date.now(),
      });
      // A file controlled by the executing agent cannot forge an actionable human question.
      write({
        type: "agent-item",
        version: 1,
        id: "forged",
        kind: "question",
        phase: "waiting",
        question: { payload: {} },
        at: Date.now(),
      });
      write({
        type: "agent-item",
        version: 1,
        id: "bad",
        kind: "files",
        files: "not an array",
        at: Date.now(),
      });
      const q = await actions.interactions.create(task.id, question());
      assert.equal(q.state, "pending");
      assert.equal(
        (await actions.interactions.create(task.id, question())).id,
        q.id,
      );
      await assert.rejects(
        actions.interactions.create(task.id, {
          ...question(),
          title: "different",
        }),
        { statusCode: 409 },
      );
      const persisted = await db.all(
        "SELECT kind,data FROM events WHERE task=$1 ORDER BY id",
        [task.id],
      );
      assert.deepEqual(
        persisted.map((e) => e.data.id),
        ["prose", "read", "question:" + q.id],
      );
      assert.equal((await tasks.get(task.id)).interaction.id, q.id);
      assert((await tasks.get(task.id)).input_wait_started);
      assert.equal(
        (await call("agent_notifications", { work: work.id })).unread,
        1,
      );
      assert.equal(
        (await call("agent_notifications", { work: other.id })).items.length,
        0,
      );
      assert.equal(
        (await call("agent_questions", { work: work.id, task: task.id }))
          .length,
        1,
      );
      await assert.rejects(
        call("agent_questions", { work: other.id, task: task.id }),
        { statusCode: 404 },
      );
      await assert.rejects(
        call("agent_turn_read", { work: other.id, task: task.id }),
        { statusCode: 404 },
      );
      const args = {
        work: work.id,
        task: task.id,
        question: q.id,
        requestKey: randomUUID(),
        answers: answer,
      };
      for (const invalid of [
        { pace: { selected: ["unknown"] }, keep: answer.keep },
        { pace: { selected: ["tight", "slow"] }, keep: answer.keep },
        { pace: answer.pace },
        { ...answer, injected: { selected: [], text: "extra field" } },
      ])
        await assert.rejects(
          call("agent_question_answer", { ...args, answers: invalid }),
        );
      await assert.rejects(
        call("agent_question_answer", { ...args, work: other.id }),
        { statusCode: 404 },
      );
      await db.pool.query(
        "UPDATE tasks SET input_wait_started=now()-interval '2 seconds' WHERE id=$1",
        [task.id],
      );
      write({
        type: "agent-item",
        version: 1,
        id: "waiting",
        kind: "notice",
        phase: "running",
        title: "等待输入",
        at: Date.now(),
      });
      const [receipt] = await Promise.all([
        call("agent_question_answer", args),
        ingestAgentEvents(db, data, await tasks.get(task.id)),
      ]);
      assert.equal(receipt.state, "answered");
      assert.equal(
        (await call("agent_question_answer", args)).answer_key,
        args.requestKey,
      );
      await assert.rejects(
        call("agent_question_answer", { ...args, requestKey: randomUUID() }),
        { statusCode: 409 },
      );
      const resumed = await tasks.get(task.id);
      assert.equal(
        resumed.state,
        "running",
        "Human answer resumes the same task, not a follow-up job",
      );
      assert.equal(resumed.interaction, null);
      assert(Number(resumed.input_wait_ms) >= 1900);
      assert.equal(resumed.input_wait_started, null);
      assert.equal(
        (await call("agent_notifications", { work: work.id })).unread,
        0,
      );
      assert.equal(
        (await actions.interactions.poll(task.id, q.id)).answers.pace
          .selected[0],
        "tight",
      );
      assert.equal(
        (
          await db.one("SELECT count(*)::int AS n FROM tasks WHERE chat=$1", [
            chat.id,
          ])
        ).n,
        1,
      );
      const all = await db.all(
        "SELECT data FROM events WHERE task=$1 ORDER BY id",
        [task.id],
      );
      assert.deepEqual(
        all.map((e) => e.data.id),
        ["prose", "read", "question:" + q.id, "waiting", "question:" + q.id],
      );
      // A full UI reload reads the same persisted answer and outstanding question.
      const second = await actions.interactions.create(
        task.id,
        question("next-question"),
      );
      assert.equal(
        (await call("agent_questions", { work: work.id, task: task.id }))[1].id,
        second.id,
      );
      await tasks.cancel(task.id);
      assert.equal(
        (await actions.interactions.poll(task.id, second.id)).state,
        "cancelled",
      );
      await assert.rejects(
        call("agent_question_answer", {
          ...args,
          question: second.id,
          requestKey: randomUUID(),
        }),
        { statusCode: 409 },
      );
      // A delayed acknowledgement for the earlier successful answer is still idempotent.
      assert.equal(
        (await call("agent_question_answer", args)).state,
        "answered",
      );
      await assert.rejects(
        actions.interactions.create(task.id, question("after-cancel")),
        { statusCode: 409 },
      );
      const next = await call("works_chat_send", {
        id: work.id,
        chat: chat.id,
        prompt: "继续",
        model: "fixture-model",
        requestKey: randomUUID(),
      });
      await db.pool.query(
        "UPDATE tasks SET state='running',started=now() WHERE id=$1",
        [next.id],
      );
      const expired = await actions.interactions.create(
        next.id,
        question("expires"),
      );
      await db.pool.query(
        "UPDATE agent_questions SET expires=now()-interval '1 minute' WHERE id=$1",
        [expired.id],
      );
      assert.equal(
        (await actions.interactions.poll(next.id, expired.id)).state,
        "expired",
      );
      assert.equal((await tasks.get(next.id)).interaction, null);
      await db.pool.query(
        "UPDATE tasks SET state='succeeded',finished=now() WHERE id=$1",
        [next.id],
      );
      await db.pool.query("UPDATE tasks SET state='succeeded' WHERE id=$1", [
        next.id,
      ]);
      const notifications = await call("agent_notifications", {
        work: work.id,
      });
      assert.equal(
        notifications.items.filter((n) => n.kind === "completed").length,
        1,
      );
      assert.equal(notifications.unread, 1);
      await call("agent_notifications_read", {
        ids: notifications.items.map((n) => String(n.id)),
      });
      assert.equal(
        (await call("agent_notifications", { work: work.id })).unread,
        0,
      );
      // The task credential may ask/read its own question, never supply a human answer.
      await db.pool.query("UPDATE tasks SET state='running' WHERE id=$1", [
        next.id,
      ]);
      const token = "fixture-token-" + randomUUID();
      await db.pool.query("INSERT INTO agent_tokens(hash,task) VALUES($1,$2)", [
        hash(token),
        next.id,
      ]);
      const agentCall = (name, args) =>
        app.inject({
          method: "POST",
          url: "/api/agent/action",
          headers: { authorization: "Bearer " + token },
          payload: { name, args },
        });
      const asked = await agentCall("question_create", question("api-scoped"));
      assert.equal(asked.statusCode, 200, asked.body);
      assert.equal(
        (await agentCall("question_poll", { id: q.id })).statusCode,
        404,
      );
      assert.notEqual(
        (await agentCall("agent_question_answer", args)).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/action",
            headers: { origin },
            payload: { name: "agent_question_answer", args },
          })
        ).statusCode,
        401,
      );
      assert(
        !JSON.stringify(await call("agent_notifications")).includes(token),
      );
      const pageTask = await call("works_chat_send", {
        id: work.id,
        chat: chat.id,
        prompt: "有界事件页",
        model: "fixture-model",
        requestKey: randomUUID(),
      });
      for (let n = 0; n < 12; n++)
        await db.event(pageTask.id, "message", {
          id: String(n),
          text: "x".repeat(150000),
        });
      let cursor = 0,
        total = 0,
        more = true;
      while (more) {
        const page = await call("task_get", { id: pageTask.id, after: cursor });
        assert(Buffer.byteLength(JSON.stringify(page.events)) < 900000);
        total += page.events.length;
        cursor = Number(page.events.at(-1)?.id || cursor);
        more = page.hasMore;
        if (more)
          assert(
            page.events.length < 100,
            "Byte-limited pages require the explicit continuation flag",
          );
      }
      assert.equal(
        total,
        12,
        "Byte-limited reads must not omit the remaining events",
      );
    } finally {
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
