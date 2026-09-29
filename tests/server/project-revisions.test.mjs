import test from "node:test";
import assert from "node:assert/strict";
import { ProjectRevisions } from "../../server/project-revisions.mjs";

test("busy source discovery remains available without claiming an unverified revision", async () => {
  const unindexed = { source_revision: null, source_indexed_at: null, source_generation: "2" };
  const db = { lock: async () => { throw Object.assign(new Error("Repository is busy"), { statusCode: 409 }); }, one: async () => unindexed };
  const revisions = new ProjectRevisions(db, {});
  assert.equal(await revisions.refreshIfIdle("repo", "film"), unindexed);
  db.lock = async () => { throw new Error("Database unavailable"); };
  await assert.rejects(revisions.refreshIfIdle("repo", "film"), /Database unavailable/);
});
