import test from "node:test";
import assert from "node:assert/strict";
import { readWorkPreview } from "../../server/preview-state.mjs";

test("preview subscriptions only read persisted revisions and never scan project files", async () => {
  const latest = { id: "old-build", fingerprint: "a".repeat(64) };
  const work = { repo: "repo", project: "film", source_revision: latest.fingerprint };
  let query;
  const args = { work, runtime: { fingerprint: "fixture-runtime" }, repos: { project: () => { throw Error("No filesystem access on status queries"); } }, db: { one: async sql => { query = sql; return latest; } } };
  assert.equal((await readWorkPreview(args)).stale, false);
  work.source_revision = null;
  assert.equal((await readWorkPreview(args)).stale, true);
  work.source_revision = "b".repeat(64);
  const changed = await readWorkPreview(args);
  assert.equal(changed.stale, true);
  assert.notEqual(changed.sourceRevision, changed.previewRevision);
  assert.match(query, /cleaned IS NULL/);
  assert.match(query, /input->>'version' IS NULL/);
  assert.match(query, /ORDER BY created DESC,id DESC LIMIT 1/);
  latest.fingerprint = work.source_revision;
  assert.equal((await readWorkPreview(args)).stale, false);
});
