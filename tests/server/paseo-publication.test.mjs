import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fixture } from "./paseo-test-fixture.mjs";
import { command } from "../../server/process.mjs";
import { treeHash } from "../../server/project-files.mjs";
import { capturePaseoCandidate } from "../../server/paseo-drafts.mjs";
import { PaseoPublication } from "../../server/paseo-publication.mjs";
import { Tasks } from "../../server/tasks.mjs";

async function prepared(t) {
  const f = await fixture(t);
  const canonicalRoot = path.dirname(path.dirname(f.canonical));
  const git = args => command("git", args, { cwd: canonicalRoot });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "FRAME Test"]);
  await git(["config", "user.email", "frame@localhost"]);
  await git(["add", "."]); await git(["commit", "-m", "initial"]);
  const before = await git(["rev-parse", "HEAD"]);
  const repos = { ...f.repos,
    project: async (...args) => ({ ...(await f.repos.project(...args)), repo: { root: canonicalRoot } }),
    checkpoint: async () => { await git(["add", "--", "projects/fixture"]);
      await git(["commit", "--allow-empty", "-m", "FRAME checkpoint"]); return git(["rev-parse", "HEAD"]); },
  };
  const { draft, binding } = await f.workService.prepare(f.work.id);
  await fs.writeFile(path.join(draft.projectRoot, "scene.ts"), "export const color='verified';");
  await fs.chmod(path.join(draft.projectRoot, "scene.ts"), 0o755);
  const revision = await treeHash(draft.projectRoot, { includeExecutableMode: true });
  const changed = await f.store.markDraft(f.work.id, { revision });
  const runtimeFingerprint = "a".repeat(64);
  const captured = await capturePaseoCandidate({ data: f.data, work: f.work, projectRoot: draft.projectRoot,
    generation: changed.generation, baselineFingerprint: binding.baselineFingerprint,
    baselineModeFingerprint: binding.baselineModeFingerprint, runtimeFingerprint });
  const { candidate } = await f.store.createCandidate(captured);
  const manager = { observe: async () => ({ activeAgents: [], pendingPermissions: 0, activeTerminals: 0 }),
    prepareRuntime: async run => { await fs.writeFile(path.join(run, ".gitignore"), "node_modules\n");
      await fs.writeFile(path.join(run, "platform.txt"), "shared immutable runtime"); } };
  const tasks = new Tasks(f.db, f.data, repos, {});
  const publication = new PaseoPublication({ ...f, repos, tasks, manager, localMode: true });
  tasks.publication.beforeApply = task => publication.beforeApply(task);
  t.after(() => tasks.close());
  return { ...f, repos, tasks, publication, candidate, draft, before, git };
}
test("Candidate validation indexes the actual canonical baseline without changing frozen source bytes or mode", async t => {
  const f = await prepared(t);
  const source = path.join(f.data, "runs", f.candidate.runId, "projects/fixture");
  const before = await treeHash(source, { includeExecutableMode: true });
  const { run, input } = await f.publication.prepare(f.candidate);
  assert.match(input.baselineCommit, /^[a-f0-9]{40}$/);
  const baseline = await command("git", ["show", input.baselineCommit + ":projects/fixture/scene.ts"], { cwd: run });
  assert.match(baseline, /initial/);
  assert.match(await fs.readFile(path.join(source, "scene.ts"), "utf8"), /verified/);
  assert.equal(await treeHash(source, { includeExecutableMode: true }), before);
  const changes = await command("git", ["diff", "--name-only", input.baselineCommit], { cwd: run });
  assert.equal(changes, "projects/fixture/scene.ts");
  const retry = await f.publication.prepare(f.candidate);
  assert.equal(retry.input.baselineCommit, input.baselineCommit);
});
async function verified(f) {
  await f.store.transitionCandidate(f.candidate.id, { from: ["queued_validation"], state: "validating" });
  const result = { status: "passed", previewMode: "live",
    fingerprint: f.candidate.snapshotFingerprint, modeFingerprint: f.candidate.snapshotModeFingerprint,
    runtimeFingerprint: f.candidate.runtimeFingerprint, validation: [] };
  return f.store.transitionCandidate(f.candidate.id, { from: ["validating"], state: "verified", patch: { result } });
}
test("Verified source publishes through the existing atomic journal, keeps before/after versions and retries idempotently", async t => {
  const f = await prepared(t), candidate = await verified(f);
  const result = await f.publication.publish(candidate);
  assert.equal(await treeHash(f.canonical, { includeExecutableMode: true }), candidate.snapshotModeFingerprint);
  assert.match(await fs.readFile(path.join(f.canonical, "scene.ts"), "utf8"), /verified/);
  assert.equal((await fs.stat(path.join(f.canonical, "scene.ts"))).mode & 0o111, 0o111);
  const task = await f.tasks.get(candidate.runId);
  assert.equal(task.kind, "paseo"); assert.equal(task.state, "succeeded");
  assert.match(task.base_commit, /^[a-f0-9]{40}$/); assert.equal(task.result.commit, result.commit);
  assert.notEqual(task.base_commit, result.commit);
  assert.equal((await f.publication.publish(candidate)).commit, result.commit);
  assert.equal((await f.db.one("SELECT count(*) AS n FROM events WHERE task=$1 AND kind='result'", [task.id])).n, 1);
});
test("Changed canonical state and tampered verified snapshots never overwrite source", async t => {
  const f = await prepared(t), candidate = await verified(f);
  const source = path.join(f.data, "runs", candidate.runId, "projects/fixture/scene.ts");
  await fs.writeFile(source, "export const tampered=true;");
  await assert.rejects(f.publication.beforeApply({ id: candidate.runId, repo: f.work.repo,
    project: f.work.project, kind: "paseo", input: { candidateId: candidate.id } }), /Frozen candidate source changed/);
  assert.match(await fs.readFile(path.join(f.canonical, "scene.ts"), "utf8"), /initial/);
  await fs.writeFile(source, "export const color='verified';");
  await fs.writeFile(path.join(f.canonical, "scene.ts"), "export const userEdit=true;");
  await assert.rejects(f.publication.prepare(candidate), /Canonical source changed/);
  assert.match(await fs.readFile(path.join(f.canonical, "scene.ts"), "utf8"), /userEdit/);
});
