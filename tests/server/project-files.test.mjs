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


test("cached file digests detect same-size replacements, restored timestamps and executable changes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-digest-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "scene.ts");
  fs.writeFileSync(file, "first", { mode: 0o644 });
  const initial = fs.statSync(file), original = await fileSha256(file);
  assert.equal(await fileSha256(file), original);
  fs.writeFileSync(file, "other");
  fs.utimesSync(file, initial.atime, initial.mtime);
  assert.equal(await fileSha256(file), hash("other"));
  const content = await treeHash(root), beforeMode = await treeHash(root, { includeExecutableMode: true });
  fs.chmodSync(file, 0o755);
  assert.equal(await treeHash(root), content);
  assert.notEqual(await treeHash(root, { includeExecutableMode: true }), beforeMode);
  const replacement = path.join(root, "replacement");
  fs.writeFileSync(replacement, "third");
  fs.utimesSync(replacement, initial.atime, initial.mtime);
  fs.renameSync(replacement, file);
  assert.equal(await fileSha256(file), hash("third"));
  const linked = path.join(root, "linked");
  fs.linkSync(file, linked);
  await assert.rejects(fileSha256(file), /Links and special files/);
  fs.unlinkSync(linked);
  assert.equal(await fileSha256(file), hash("third"));
});
