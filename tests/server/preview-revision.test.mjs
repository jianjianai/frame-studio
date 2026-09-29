import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { treeHash } from "../../server/security.mjs";
import { readWorkPreview } from "../../server/preview-state.mjs";

test("web and AI preview status detect changed source independently of task-page limits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-revision-"));
  try {
    fs.writeFileSync(path.join(dir, "scene.ts"), "first version");
    const latest = { id: "old-build", fingerprint: treeHash(dir) };
    let query;
    const args = {
      work: { repo: "repo", project: "film" },
      repos: { project: async () => ({ dir }) },
      db: {
        one: async (sql) => {
          query = sql;
          return latest;
        },
      },
    };
    assert.equal((await readWorkPreview(args)).stale, false);
    fs.writeFileSync(path.join(dir, "scene.ts"), "MCP edit");
    const changed = await readWorkPreview(args);
    assert.equal(changed.stale, true);
    assert.notEqual(changed.sourceRevision, changed.previewRevision);
    assert.match(query, /cleaned IS NULL/);
    assert.match(query, /input->>'version' IS NULL/);
    assert.match(query, /ORDER BY created DESC,id DESC LIMIT 1/);
    latest.fingerprint = treeHash(dir);
    assert.equal((await readWorkPreview(args)).stale, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
