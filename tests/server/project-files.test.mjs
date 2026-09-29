import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { treeHash as syncHash, hash } from "../../server/security.mjs";
import { treeHash, fileSha256, copyTree } from "../../server/project-files.mjs";

test("async project I/O preserves fingerprints with bounded media reads", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-async-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), target = path.join(root, "target");
  fs.mkdirSync(source);
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 42);
  fs.writeFileSync(path.join(source, "media.bin"), bytes);
  fs.writeFileSync(path.join(source, "project.ts"), "export default {};");
  fs.mkdirSync(path.join(source, "exports"));
  fs.writeFileSync(path.join(source, "exports", "ignored.txt"), "ignored");
  assert.equal(await fileSha256(path.join(source, "media.bin")), hash(bytes));
  assert.equal(await treeHash(source), syncHash(source));
  await copyTree(source, target);
  assert.equal(await treeHash(target), await treeHash(source));
  assert.equal(fs.existsSync(path.join(target, "exports")), false);
});
