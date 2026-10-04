import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { operations } from "../../server/operations.mjs";

test("file writes only check the current work for active tasks", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-write-scope-"));
  const seen = [];
  const repos = {
    writable: async (repo, project) => {
      seen.push([repo, project]);
      if (!project || project === "busy-work") throw Error("busy");
    },
    project: async () => ({ dir: data }),
  };
  const actions = operations({
    db: { lock: async (_key, fn) => fn() }, data, repos,
    assets: {}, tasks: {}, secrets: {}, github: {}, retention: {},
  });
  const write = actions.registry.project_write.fn;
  try {
    await write({ repo: "repo", project: "idle-work", path: "scene.ts", expectedSha256: null, content: "export const n=1;" });
    assert.deepEqual(seen[0], ["repo", "idle-work"]);
    await assert.rejects(write({ repo: "repo", project: "busy-work", path: "other.ts", expectedSha256: null, content: "" }), /busy/);
    assert(!fs.existsSync(path.join(data, "other.ts")));
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});
