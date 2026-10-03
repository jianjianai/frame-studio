import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Tasks } from "../../server/tasks.mjs";
import { treeHash } from "../../server/security.mjs";

test("restart resumes the applied result after Git commit failed without rerunning execution", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-publish-"));
  const id = randomUUID(), destination = path.join(data, "destination"), run = path.join(data, "runs", id);
  const source = path.join(run, "projects", "film");
  for (const dir of [destination, source]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(destination, "project.ts"), "original");
  fs.writeFileSync(path.join(source, "project.ts"), "new result");
  fs.writeFileSync(path.join(run, "result.json"), JSON.stringify({ status: "passed" }));
  let row = { id, repo: "repo", project: "film", kind: "new", state: "running", input: {}, fingerprint: treeHash(destination), publication_attempts: 0 };
  let commits = 0;
  const db = {
    one: async (sql, p) => {
      if (sql.startsWith("UPDATE tasks SET state='publishing',result=")) row = { ...row, state: "publishing", result: structuredClone(p[1]) };
      return structuredClone(row);
    },
    pool: { query: async (sql, p) => {
      if (sql.startsWith("UPDATE tasks SET state=CASE")) {
        row.publication_attempts++;
        row.state = row.publication_attempts >= 3 ? "publish_failed" : "publishing";
        row.error = p[1];
      }
      if (sql.startsWith("UPDATE tasks SET state='succeeded'")) row = { ...row, state: "succeeded", result: p[1], error: null };
      return { rowCount: 1 };
    } },
    lock: async (_key, fn) => fn(),
  };
  const repos = { project: async () => ({ dir: destination }), checkpoint: async () => {
    if (++commits === 1) throw Error("simulated Git failure");
    return "a".repeat(40);
  } };
  const options = { runCommand: async () => { throw Error("Recovery must not execute any worker"); } };
  try {
    await new Tasks(db, data, repos, {}, options).complete(row, 0);
    assert.equal(row.state, "publishing");
    assert.match(row.error, /simulated Git failure/);
    assert.equal(fs.readFileSync(path.join(destination, "project.ts"), "utf8"), "new result");
    // A new controller instance uses the persisted task result and application journal.
    await new Tasks(db, data, repos, {}, options).complete(row, 0);
    assert.equal(row.state, "succeeded");
    assert.equal(row.result.commit, "a".repeat(40));
    assert.equal(fs.existsSync(path.join(run, "original-project")), false, "completed task removes its temporary rollback/source tree");
    assert.equal(fs.existsSync(source), false, "canonical work keeps the result while task source is removed");
    assert.equal(fs.existsSync(path.join(run, "result.json")), true);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});
