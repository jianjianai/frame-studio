import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  sourceIndex,
  sourcePage,
  invalidateSourceIndex,
} from "../../server/source-index.mjs";
import { projectTextOperations } from "../../server/project-text.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-source-index-"));
  t.after(() => {
    invalidateSourceIndex(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("source pages reuse bounded indexes and observe external structural and metadata changes", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "public"));
  for (let i = 0; i < 8000; i++)
    fs.writeFileSync(
      path.join(root, "public", String(i).padStart(4, "0") + ".txt"),
      "needle\n",
    );
  const first = await sourcePage(root, "", 0, 60);
  assert.equal(first.total, 8000);
  assert.equal(first.nextOffset, 60);
  const original = fsp.readdir;
  let reads = 0;
  fsp.readdir = (...a) => {
    reads++;
    return original(...a);
  };
  try {
    const second = await sourcePage(root, "", 60, 60);
    assert.equal(reads, 0, "warm pages must not walk the full source tree");
    assert.equal(second.files[0].path, "public/0060.txt");
    fs.writeFileSync(path.join(root, "public/0060.txt"), "changed bytes");
    const changed = await sourcePage(root, "", 60, 1);
    assert.equal(changed.files[0].bytes, Buffer.byteLength("changed bytes"));
    fs.writeFileSync(path.join(root, "public/new.txt"), "new");
    assert.equal((await sourcePage(root, "", 0, 1)).total, 8001);
    fs.unlinkSync(path.join(root, "public/new.txt"));
    assert.equal((await sourcePage(root, "", 0, 1)).total, 8000);
  } finally {
    fsp.readdir = original;
  }
});

test("indexed pages refuse external symlinks and hard links, including directory replacement", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "source"));
  fs.writeFileSync(path.join(root, "source/scene.ts"), "safe");
  await sourceIndex(root);
  fs.renameSync(path.join(root, "source"), path.join(root, ".saved"));
  fs.symlinkSync(path.join(root, ".saved"), path.join(root, "source"), "dir");
  await assert.rejects(sourcePage(root, "", 0, 60), /Links and special files/);
  fs.unlinkSync(path.join(root, "source"));
  fs.renameSync(path.join(root, ".saved"), path.join(root, "source"));
  await sourceIndex(root);
  fs.linkSync(path.join(root, "source/scene.ts"), path.join(root, ".hardlink"));
  await assert.rejects(sourcePage(root, "", 0, 60), /Links and special files/);
});

test("indexed search preserves current hashes, bounded bytes and exact resumable line cursors", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "scene.ts"), "needle 1\nneedle 2\nneedle 3");
  fs.writeFileSync(path.join(root, "last.ts"), "needle tail");
  const registry = {};
  projectTextOperations({
    add(name, description, shape, fn) {
      registry[name] = fn;
    },
    db: { lock: (_id, fn) => fn() },
    repos: { project: async () => ({ dir: root }) },
    uuid: {},
    project: {},
  });
  const args = {
    repo: "repo",
    project: "fixture",
    query: "needle",
    directory: "",
    caseSensitive: false,
    limit: 2,
  };
  const first = await registry.project_search(args);
  assert.deepEqual(
    first.matches.map((m) => [m.path, m.line]),
    [
      ["last.ts", 1],
      ["scene.ts", 1],
    ],
  );
  assert.deepEqual(first.nextCursor, { path: "scene.ts", line: 2 });
  fs.writeFileSync(
    path.join(root, "scene.ts"),
    "new prefix\nneedle 2\nneedle 3",
  );
  const second = await registry.project_search({
    ...args,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    second.matches.map((m) => m.line),
    [2, 3],
  );
  assert.notEqual(second.matches[0].sha256, first.matches[1].sha256);
  assert.equal(second.hasMore, false);
  // A formerly oversized file can become editable without changing its parent directory.
  fs.writeFileSync(path.join(root, "large.ts"), "x".repeat(1048577));
  await sourceIndex(root);
  fs.writeFileSync(path.join(root, "large.ts"), "needle resized");
  const resized = await registry.project_search({ ...args, limit: 30 });
  assert.equal(resized.matches[0].path, "large.ts");
});

test("narrowed indexes recheck ancestors and reject unsupported filesystem path names", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "source/nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "source/nested/scene.ts"), "safe");
  await sourceIndex(root, "source/nested");
  fs.renameSync(path.join(root, "source"), path.join(root, ".saved"));
  fs.symlinkSync(path.join(root, ".saved"), path.join(root, "source"), "dir");
  await assert.rejects(
    sourcePage(root, "source/nested", 1000, 60),
    /Links and special files/,
  );
  fs.unlinkSync(path.join(root, "source"));
  fs.renameSync(path.join(root, ".saved"), path.join(root, "source"));
  fs.writeFileSync(path.join(root, "bad:name.ts"), "invalid");
  await assert.rejects(sourceIndex(root), /Invalid path/);
});

test("search rejects structural changes that arrive during a bounded page read", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "scene.ts"), "needle");
  const registry = {};
  projectTextOperations({
    add(name, description, shape, fn) {
      registry[name] = fn;
    },
    db: {},
    repos: { project: async () => ({ dir: root }) },
    uuid: {},
    project: {},
  });
  await sourceIndex(root);
  const original = fsp.open;
  let changed = false;
  fsp.open = (...args) => {
    if (!changed) {
      changed = true;
      fs.writeFileSync(path.join(root, "new.ts"), "needle");
    }
    return original(...args);
  };
  try {
    await assert.rejects(
      registry.project_search({
        query: "needle",
        directory: "",
        caseSensitive: false,
        limit: 30,
      }),
      (error) => error.code === "TREE_CHANGED",
    );
  } finally {
    fsp.open = original;
  }
});
