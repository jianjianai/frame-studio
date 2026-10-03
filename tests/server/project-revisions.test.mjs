import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { liveSourceInventory } from "../../scripts/live-preview-bundle.mjs";
import { treeHash } from "../../server/project-files.mjs";
import { ProjectRevisions } from "../../server/project-revisions.mjs";

test("busy source discovery remains available without claiming an unverified revision", async () => {
  const unindexed = { source_revision: null, source_indexed_at: null, source_generation: "2" };
  const db = { lock: async () => { throw Object.assign(new Error("Repository is busy"), { statusCode: 409 }); }, one: async () => unindexed };
  const revisions = new ProjectRevisions(db, {});
  assert.equal(await revisions.refreshIfIdle("repo", "film"), unindexed);
  db.lock = async () => { throw new Error("Database unavailable"); };
  await assert.rejects(revisions.refreshIfIdle("repo", "film"), /Database unavailable/);
});


test("editor revision and preview authority include all source files and executable modes", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "frame-authority-revision-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "project.ts"), "export default {id:'film',title:'Film',duration:1,fps:12,load:()=>import('./scene')};");
  await fs.writeFile(path.join(dir, "scene.ts"), "export const scene=1;");
  await fs.writeFile(path.join(dir, "README.md"), "Authoring notes");
  let row = { source_generation: "0" };
  const db = {
    pool: { query: async () => { row = { ...row, source_generation: String(Number(row.source_generation) + 1), source_revision: null }; } },
    one: async (sql, args) => sql.startsWith("UPDATE") ? row = { ...row, source_revision: args[3] } : row,
    lock: async (_key, callback) => callback(),
  };
  const revisions = new ProjectRevisions(db, { project: async () => ({ dir }) });
  const read = async () => {
    const indexed = await revisions.refresh("repo", "film"), preview = await liveSourceInventory(dir, "film");
    assert.equal(indexed.source_revision, await treeHash(dir, { includeExecutableMode: true }));
    assert.equal(preview.sourceRevision, indexed.source_revision);
    return indexed.source_revision;
  };
  const initial = await read();
  await fs.writeFile(path.join(dir, "README.md"), "Revised authoring notes");
  const edited = await read(); assert.notEqual(edited, initial);
  await fs.chmod(path.join(dir, "scene.ts"), 0o755);
  assert.notEqual(await read(), edited);
});
