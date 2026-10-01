import test from "node:test";
import { insertLegacyChat, legacyAgentTask } from "./legacy-agent-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { vault } from "../../server/security.mjs";
import { recordConnectionTest } from "../../server/provider-catalog.mjs";
const url = process.env.FRAME_TEST_DATABASE_URL;

test(
  "provider deletion preserves history, removes credentials, blocks active use and cannot resurrect from stale actions",
  { skip: !url, timeout: 60000 },
  async () => {
    assert.match(new URL(url).pathname, /frame_test/);
    const data = fs.mkdtempSync(
      path.join(os.tmpdir(), "frame-provider-delete-"),
    );
    const db = await database(url, "test-password-at-least-14");
    await db.pool.query(
      "TRUNCATE repos,connections,auth_flows RESTART IDENTITY CASCADE",
    );
    const key = "66".repeat(32),
      secrets = vault(key);
    const { app, actions, tasks } = await createApp({
      db,
      data,
      masterKey: key,
      scheduler: false,
    });
    const call = (name, args = {}) => actions.call(name, args);
    const input = {
      name: "Lifecycle provider",
      tool: "codex",
      mode: "api",
      baseUrl: "https://example.invalid/v1/models",
      apiKey: "local-fixture-secret",
      publicCatalog: false,
      model: "example",
      models: [{ id: "example", name: "Example" }],
    };
    try {
      const provider = await call("connections_save", input);
      assert.equal(provider.baseUrl, "https://example.invalid/v1");
      const deletion = {
        id: provider.id,
        expectedRevision: provider.revision,
        confirmName: provider.name,
      };
      const repo = await call("repositories_add", {
        name: "Provider lifecycle",
      });
      const work = await call("works_create", {
        repo: repo.id,
        title: "History fixture",
      });
      const chat = await insertLegacyChat(db, work, {
        id: work.id,
        connection: provider.id,
        title: "Preserve me",
      });
      const args = {
        id: work.id,
        chat: chat.id,
        prompt: "Fixture request",
        model: "example",
        requestKey: randomUUID(),
      };
      const task = await legacyAgentTask(tasks, work, args);
      for (const state of [
        "queued",
        "running",
        "cancelling",
        "publishing",
        "publish_failed",
      ]) {
        await db.pool.query("UPDATE tasks SET state=$2 WHERE id=$1", [
          task.id,
          state,
        ]);
        assert.equal(
          (await call("connections_usage", { id: provider.id })).activeTasks,
          1,
        );
        await assert.rejects(
          call("connections_delete", deletion),
          /任务使用此提供商/,
        );
      }
      await db.pool.query(
        "UPDATE tasks SET state='succeeded',finished=now() WHERE id=$1",
        [task.id],
      );
      await db.event(task.id, "message", { text: "Historical reply" });
      await assert.rejects(
        call("connections_delete", { ...deletion, confirmName: "wrong" }),
        /完整提供商名称/,
      );
      await assert.rejects(
        call("connections_delete", {
          ...deletion,
          expectedRevision: "0".repeat(64),
        }),
        /配置已更新/,
      );
      assert.equal(
        (await call("connections_usage", { id: provider.id })).chats,
        1,
      );
      const auth = path.join(data, "auth", provider.id),
        neighbor = path.join(data, "auth", randomUUID());
      fs.mkdirSync(auth, { recursive: true });
      fs.mkdirSync(neighbor, { recursive: true });
      fs.writeFileSync(path.join(auth, "auth.json"), "fixture-login-material");
      fs.writeFileSync(path.join(neighbor, "keep.txt"), "another connection");
      const deleted = await call("connections_delete", deletion);
      assert.equal(deleted.preservedChats, 1);
      assert.equal(deleted.warning, undefined);
      assert.equal(fs.existsSync(auth), false);
      assert.equal(fs.existsSync(path.join(neighbor, "keep.txt")), true);
      assert.equal((await call("connections_list")).length, 0);
      const tombstone = await db.one("SELECT * FROM connections WHERE id=$1", [
        provider.id,
      ]);
      const emptyConfig = secrets.decrypt(tombstone.config);
      assert.equal(tombstone.state, "deleted");
      assert.equal(emptyConfig.apiKey, undefined);
      assert.equal(emptyConfig.baseUrl, undefined);
      assert.deepEqual(emptyConfig.models, []);
      assert.equal(
        (await db.one("SELECT connection FROM chats WHERE id=$1", [chat.id]))
          .connection,
        provider.id,
      );
      assert.equal((await tasks.get(task.id)).input.model, "example");
      assert.equal(
        (
          await db.one("SELECT count(*)::int AS n FROM events WHERE task=$1", [
            task.id,
          ])
        ).n,
        1,
      );
      assert.equal(
        (await legacyAgentTask(tasks, work, args)).id,
        task.id,
        "lost acknowledgements recover after deletion without resubmission",
      );
      await assert.rejects(
        legacyAgentTask(tasks, work, { ...args, requestKey: randomUUID() }),
        /删除/,
      );
      await assert.rejects(
        tasks.create({
          repo: work.repo,
          project: work.project,
          kind: "agent",
          chat: chat.id,
          input: {
            connection: provider.id,
            provider: "codex",
            model: "example",
            prompt: "stale request",
          },
        }),
        /删除/,
      );
      for (const [name, values] of [
        ["connections_enabled", { id: provider.id, enabled: true }],
        ["connections_save", { ...input, id: provider.id }],
        ["connections_test", { id: provider.id }],
        ["connections_discover", { id: provider.id }],
        ["connections_usage", { id: provider.id }],
        ["connections_delete", deletion],
      ])
        await assert.rejects(call(name, values), /删除/);
      await recordConnectionTest(tasks.connections, provider.id, input, {
        ok: true,
        message: "late response",
      });
      assert.equal(
        (
          await db.one("SELECT state FROM connections WHERE id=$1", [
            provider.id,
          ])
        ).state,
        "deleted",
      );
      await tasks.connections.migrate();
      assert.equal(
        (await call("connections_list")).length,
        0,
        "startup never resurrects a deleted connection",
      );
    } finally {
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);

test(
  "pending authorization and concurrent lifecycle actions block deletion without altering credentials",
  { skip: !url, timeout: 30000 },
  async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-provider-lock-"));
    const db = await database(url, "test-password-at-least-14");
    await db.pool.query(
      "TRUNCATE repos,connections,auth_flows RESTART IDENTITY CASCADE",
    );
    const { app, actions } = await createApp({
      db,
      data,
      masterKey: "77".repeat(32),
      scheduler: false,
    });
    const call = (name, args = {}) => actions.call(name, args);
    try {
      const provider = await call("connections_save", {
        name: "Official fixture",
        tool: "claude",
        mode: "official",
      });
      const args = {
        id: provider.id,
        expectedRevision: provider.revision,
        confirmName: provider.name,
      };
      const flow = randomUUID();
      await db.pool.query(
        "INSERT INTO auth_flows(id,target,kind,expires) VALUES($1,$2,'claude',now()+interval '1 minute')",
        [flow, provider.id],
      );
      await assert.rejects(call("connections_delete", args), /正在授权/);
      await db.pool.query("UPDATE auth_flows SET state='expired' WHERE id=$1", [
        flow,
      ]);
      await db.lock(`connection:${provider.id}`, async () => {
        await assert.rejects(call("connections_delete", args), /busy/);
        assert.equal((await call("connections_list")).length, 1);
      });
      await call("connections_delete", args);
      await assert.rejects(
        call("auth_begin", { kind: "claude", target: provider.id }),
        /official account connection/,
      );
      assert.deepEqual(
        (await db.one("SELECT info FROM auth_flows WHERE id=$1", [flow])).info,
        {},
      );
    } finally {
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
