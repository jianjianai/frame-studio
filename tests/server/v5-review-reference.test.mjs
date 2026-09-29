import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { freezeReviewReference, prepareReviewReference } from "../../server/review-reference.mjs";
import { treeHash } from "../../server/project-files.mjs";

const url = process.env.FRAME_TEST_DATABASE_URL;
test("version-bound review, frozen queued model and request idempotency remain independent of later changes", { skip: !url }, async () => {
  assert.match(new URL(url).pathname, /frame_test/);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-v5-reference-"));
  const db = await database(url, "v5-fixture-password-12345");
  await db.pool.query("TRUNCATE repos,tasks,events,chats,works,connections,assets,engines,auth_flows CASCADE");
  const { app, actions, repos, tasks } = await createApp({ db, data, masterKey: "12".repeat(32), scheduler: false });
  try {
    const repo = await actions.call("repositories_add", { name: "Reference fixture" });
    const work = await actions.call("works_create", { repo: repo.id, title: "Reference work" });
    const location = await repos.project(repo.id, work.project);
    const before = await repos.git(location.repo.root, ["rev-parse", "HEAD"]);
    const fingerprint = await treeHash(location.dir);
    const preview = randomUUID();
    await db.pool.query("INSERT INTO tasks(id,repo,project,kind,state,input,source_commit,fingerprint) VALUES($1,$2,$3,'build','succeeded','{}',$4,$5)", [preview, repo.id, work.project, before, fingerprint]);
    const connection = await actions.call("connections_save", { name: "Fixture model", tool: "codex", mode: "api", model: "initial-model", baseUrl: "https://fixture.example/v1", apiKey: "fixture-key-not-real" });
    const chat = await actions.call("works_chat_create", { id: work.id, connection: connection.id });
    const request = { id: work.id, chat: chat.id, prompt: "Change this exact old scene", requestKey: randomUUID(), context: { start: 1, end: 3, previewTask: preview, sourceCommit: before } };
    const first = await actions.call("works_chat_send", request);
    assert.equal(first.execution.model, "initial-model");
    assert.equal(first.review_reference.sourceCommit, before);
    assert(!JSON.stringify(first).includes("fixture-key-not-real"));
    await actions.call("connections_save", { id: connection.id, name: "Fixture model", tool: "codex", mode: "api", model: "later-model", baseUrl: "https://fixture.example/v1" });
    const repeated = await actions.call("works_chat_send", request);
    assert.equal(repeated.id, first.id);
    assert.equal(repeated.execution.model, "initial-model");
    await assert.rejects(actions.call("works_chat_send", { ...request, prompt: "Different request" }), /key already used/);
    await tasks.cancel(first.id);
    fs.appendFileSync(path.join(location.dir, "scene.ts"), "\n// A later independent change\n");
    const after = await repos.checkpoint(repo.id, work.project, "Later work");
    const run = path.join(data, "runs", randomUUID());
    fs.mkdirSync(run, { recursive: true });
    const reference = await prepareReviewReference({ repos, task: first, run, sourceCommit: after, fingerprint: await treeHash(location.dir) });
    assert.equal(reference.disposition, "compare-to-latest");
    assert.equal(reference.sourceCommit, before);
    assert.equal(reference.executionCommit, after);
    assert(!fs.readFileSync(path.join(run, reference.path, "scene.ts"), "utf8").includes("later independent"));
    assert(fs.readFileSync(path.join(location.dir, "scene.ts"), "utf8").includes("later independent"));
    await assert.rejects(freezeReviewReference({ db, repos, repo: repo.id, project: work.project, context: { time: 1, previewTask: preview, sourceCommit: after } }), e => e.code === "REVIEW_REFERENCE_MISMATCH");
    const other = await actions.call("works_create", { repo: repo.id, title: "Other work" });
    await assert.rejects(freezeReviewReference({ db, repos, repo: repo.id, project: other.project, context: { time: 1, previewTask: preview } }), /不属于/);
    assert.deepEqual(await freezeReviewReference({ db, repos, repo: repo.id, project: work.project, context: { time: 1 } }), { status: "unversioned" });
  } finally {
    await app.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
});
