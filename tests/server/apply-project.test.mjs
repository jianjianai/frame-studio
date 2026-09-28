import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyProject } from "../../server/apply-project.mjs";
import { treeHash } from "../../server/security.mjs";
test("applying output survives repeated completion and a crash after backing up the original", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-apply-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    destination = path.join(root, "destination"),
    run = path.join(root, "run");
  for (const d of [source, destination, run]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(source, "project.ts"), "new");
  fs.writeFileSync(path.join(destination, "project.ts"), "original");
  const args = {
    source,
    destination,
    run,
    id: "test",
    fingerprint: treeHash(destination),
  };
  fs.cpSync(source, destination + ".frame-test", { recursive: true });
  fs.writeFileSync(
    path.join(run, "apply.json"),
    JSON.stringify({ output: treeHash(source) }),
  );
  fs.renameSync(destination, path.join(run, "original-project"));
  applyProject(args);
  applyProject(args);
  assert.equal(
    fs.readFileSync(path.join(destination, "project.ts"), "utf8"),
    "new",
  );
  assert.equal(
    fs.readFileSync(path.join(run, "original-project/project.ts"), "utf8"),
    "original",
  );
  fs.writeFileSync(path.join(destination, "project.ts"), "external edit");
  assert.throws(() => applyProject(args));
  assert.equal(
    fs.readFileSync(path.join(destination, "project.ts"), "utf8"),
    "external edit",
  );
});
