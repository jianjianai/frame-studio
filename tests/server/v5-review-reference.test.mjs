import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import {
  freezeReviewReference,
  prepareReviewReference,
} from "../../server/review-reference.mjs";
import { treeHash } from "../../server/project-files.mjs";
import { resolveExecution } from "../../server/execution-selection.mjs";

const url = process.env.FRAME_TEST_DATABASE_URL;
test(
  "version-bound review, frozen queued model and request idempotency remain independent of later changes",
  { skip: !url },
  async () => {
    assert.match(new URL(url).pathname, /frame_test/);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-v5-reference-"));
    const db = await database(url, "v5-fixture-password-12345");
    await db.pool.query(
      "TRUNCATE repos,tasks,events,chats,works,connections,assets,engines,auth_flows CASCADE",
    );
    await db.pool.query("DELETE FROM settings WHERE key='claude'");
    const { app, actions, repos, tasks } = await createApp({
      db,
      data,
      masterKey: "12".repeat(32),
      scheduler: false,
    });
    try {
      const repo = await actions.call("repositories_add", {
        name: "Reference fixture",
      });
      const work = await actions.call("works_create", {
        repo: repo.id,
        title: "Reference work",
      });
      const location = await repos.project(repo.id, work.project);
      const before = await repos.git(location.repo.root, ["rev-parse", "HEAD"]);
      const fingerprint = await treeHash(location.dir);
      const preview = randomUUID();
      await db.pool.query(
        "INSERT INTO tasks(id,repo,project,kind,state,input,source_commit,fingerprint) VALUES($1,$2,$3,'build','succeeded','{}',$4,$5)",
        [preview, repo.id, work.project, before, fingerprint],
      );
      const connection = await actions.call("connections_save", {
        name: "Fixture model",
        tool: "codex",
        mode: "api",
        model: "initial-model",
        baseUrl: "https://fixture.example/v1",
        apiKey: "fixture-key-not-real",
      });
      const chat = await actions.call("works_chat_create", {
        id: work.id,
        connection: connection.id,
      });
      const request = {
        id: work.id,
        chat: chat.id,
        prompt: "Change this exact old scene",
        requestKey: randomUUID(),
        context: {
          start: 1,
          end: 3,
          previewTask: preview,
          sourceCommit: before,
        },
      };
      const first = await actions.call("works_chat_send", request);
      assert.equal(first.execution.model, "initial-model");
      assert.equal(first.review_reference.sourceCommit, before);
      assert(!JSON.stringify(first).includes("fixture-key-not-real"));
      await actions.call("connections_save", {
        id: connection.id,
        name: "Fixture model",
        tool: "codex",
        mode: "api",
        model: "later-model",
        baseUrl: "https://fixture.example/v1",
      });
      const repeated = await actions.call("works_chat_send", request);
      assert.equal(repeated.id, first.id);
      assert.equal(repeated.execution.model, "initial-model");
      await assert.rejects(
        actions.call("works_chat_send", {
          ...request,
          prompt: "Different request",
        }),
        /key already used/,
      );
      await tasks.cancel(first.id);
      // Legacy provider endpoints must obey the same credential-identity boundary.
      await actions.call("settings_save", { provider: "claude", secret: "legacy-fixture-key-a", model: "legacy-model" });
      const legacyChat = await actions.call("works_chat_create", { id: work.id, provider: "claude" });
      const legacySend = { id: work.id, chat: legacyChat.id, prompt: "Legacy queued turn", requestKey: randomUUID() };
      const queuedLegacy = await actions.call("works_chat_send", legacySend);
      const legacyConfig = async () => tasks.secrets.decrypt((await db.setting("claude")).encrypted);
      await actions.call("settings_save", { provider: "claude", model: "another-default" });
      assert.equal(resolveExecution(queuedLegacy.execution, await legacyConfig(), "claude").model, "legacy-model");
      await actions.call("settings_save", { provider: "claude", secret: "legacy-fixture-key-b", model: "legacy-model" });
      const rotatedLegacy = await legacyConfig();
      assert.throws(() => resolveExecution(queuedLegacy.execution, rotatedLegacy, "claude"), (error) => error.code === "EXECUTION_SELECTION_CHANGED");
      assert.equal((await actions.call("works_chat_send", legacySend)).id, queuedLegacy.id);
      await tasks.cancel(queuedLegacy.id);
      // V4 persisted enriched execution input, not the caller's original request.
      const legacyId = randomUUID(), legacyKey = randomUUID();
      const legacyRequest = { id: work.id, chat: chat.id, prompt: "Recover V4 acknowledgement", requestKey: legacyKey, context: { time: 1 } };
      await db.pool.query(
        "INSERT INTO tasks(id,repo,project,kind,state,input,chat,request_key) VALUES($1,$2,$3,'agent','succeeded',$4,$5,$6)",
        [legacyId, repo.id, work.project, { provider: "codex", connection: connection.id, model: "initial-model", prompt: legacyRequest.prompt, context: { time: 1, assetNames: {} } }, chat.id, legacyKey],
      );
      await db.pool.query("UPDATE connections SET state='expired' WHERE id=$1", [connection.id]);
      assert.equal((await actions.call("works_chat_send", legacyRequest)).id, legacyId);
      assert.equal((await actions.call("works_chat_send", { ...legacyRequest, model: "initial-model" })).id, legacyId);
      for (const patch of [{ prompt: "Changed" }, { model: "other" }, { context: { time: 2 } }])
        await assert.rejects(actions.call("works_chat_send", { ...legacyRequest, ...patch }), /key already used/);
      assert.equal((await db.one("SELECT count(*)::int AS n FROM tasks WHERE request_key=$1", [legacyKey])).n, 1);

      fs.appendFileSync(
        path.join(location.dir, "scene.ts"),
        "\n// A later independent change\n",
      );
      const after = await repos.checkpoint(repo.id, work.project, "Later work");
      const run = path.join(data, "runs", randomUUID());
      fs.mkdirSync(run, { recursive: true });
      const reference = await prepareReviewReference({
        repos,
        task: first,
        run,
        sourceCommit: after,
        fingerprint: await treeHash(location.dir),
      });
      assert.equal(reference.disposition, "compare-to-latest");
      assert.equal(reference.sourceCommit, before);
      assert.equal(reference.executionCommit, after);
      assert(
        !fs
          .readFileSync(path.join(run, reference.path, "scene.ts"), "utf8")
          .includes("later independent"),
      );
      assert(
        fs
          .readFileSync(path.join(location.dir, "scene.ts"), "utf8")
          .includes("later independent"),
      );
      await assert.rejects(
        freezeReviewReference({
          db,
          repos,
          repo: repo.id,
          project: work.project,
          context: { time: 1, previewTask: preview, sourceCommit: after },
        }),
        (e) => e.code === "REVIEW_REFERENCE_MISMATCH",
      );
      const other = await actions.call("works_create", {
        repo: repo.id,
        title: "Other work",
      });
      await assert.rejects(
        freezeReviewReference({
          db,
          repos,
          repo: repo.id,
          project: other.project,
          context: { time: 1, previewTask: preview },
        }),
        /不属于/,
      );
      assert.deepEqual(
        await freezeReviewReference({
          db,
          repos,
          repo: repo.id,
          project: work.project,
          context: { time: 1 },
        }),
        { status: "unversioned" },
      );
    } finally {
      // This fixture owns the legacy provider setting; later suites use other master keys.
      await db.pool.query("DELETE FROM settings WHERE key='claude'");
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
