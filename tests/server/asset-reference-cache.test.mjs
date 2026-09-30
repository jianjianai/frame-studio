import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Assets } from "../../server/assets.mjs";
import { hash } from "../../server/security.mjs";

function fixture(t, db = { all: async () => [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-reference-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new Assets(db, root, {});
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("context reference refresh is scoped, shared and outside the read critical path", async (t) => {
  const assets = fixture(t);
  const calls = [],
    releases = [];
  assets.scanReferences = (repo, project) => {
    calls.push({ repo, project });
    return new Promise((resolve) => releases.push(resolve));
  };
  const status = assets.refreshContext("repository", "work-a");
  assert.equal(status.status, "refreshing");
  assert.equal(status.authoritative, false);
  assets.refreshContext("repository", "work-a");
  assert.deepEqual(calls, [{ repo: "repository", project: "work-a" }]);
  // A destructive/full-repository refresh must not reuse an older background snapshot.
  const forced = assets.reconcile("repository", true);
  assert.equal(calls.length, 1);
  releases.shift()();
  await tick();
  assert.deepEqual(calls[1], { repo: "repository", project: null });
  releases.shift()();
  await forced;
  assert.equal(assets.referenceStatus("repository").status, "indexed");
});

test("reference invalidation during a scan prevents a false current status; unused lists force verification", async (t) => {
  const assets = fixture(t);
  let release;
  assets.scanReferences = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const running = assets.reconcile("repository", false, "work-a");
  assets.invalidateReferences("repository", "work-a");
  release();
  await running;
  assert.equal(
    assets.referenceStatus("repository", "work-a").status,
    "unindexed",
  );
  const calls = [];
  assets.reconcile = async (...args) => {
    calls.push(args);
  };
  await assets.list({ repo: "repository", unused: true, refresh: false });
  assert.deepEqual(calls, [["repository", true]]);
});

test("background reference failures are contained and recorded as stale", async (t) => {
  const assets = fixture(t);
  assets.scanReferences = async () => {
    throw new Error("fixture scan failure");
  };
  assets.refreshContext("repository", "work-a");
  await tick();
  const status = assets.referenceStatus("repository", "work-a");
  assert.equal(status.status, "refresh-failed");
  assert.equal(status.indexedAt, null);
  assert.equal(status.authoritative, false);
});

test("closing drains failed background refreshes even if their cache entry was evicted", async (t) => {
  const assets = fixture(t);
  let reject;
  assets.scanReferences = () =>
    new Promise((_resolve, rejectScan) => {
      reject = rejectScan;
    });
  assets.refreshContext("repository", "work-a");
  assets.scans.clear();
  let closed = false;
  const closing = assets.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  reject(new Error("fixture shutdown failure"));
  await closing;
  assert.equal(assets.runningScans.size, 0);
  await assert.rejects(assets.reconcile("repository", true), /closing/);
});

test("repository reads scan uncovered works after an overlapping narrow context refresh", async (t) => {
  const assets = fixture(t);
  const calls = [],
    releases = [];
  assets.scanReferences = (repo, project) => {
    calls.push({ repo, project });
    return new Promise((resolve) => releases.push(resolve));
  };
  assets.refreshContext("repository", "work-a");
  const repositoryRead = assets.reconcile("repository", false);
  releases.shift()();
  await tick();
  assert.deepEqual(calls, [
    { repo: "repository", project: "work-a" },
    { repo: "repository", project: null },
  ]);
  releases.shift()();
  await repositoryRead;
});

test("forced verification retries after an older background refresh failed", async (t) => {
  const assets = fixture(t);
  let reject;
  let scans = 0;
  assets.scanReferences = async () => {
    if (++scans === 1)
      await new Promise((_resolve, rejectScan) => {
        reject = rejectScan;
      });
  };
  assets.refreshContext("repository", "work-a");
  const forced = assets.reconcile("repository", true);
  reject(new Error("obsolete background failure"));
  await forced;
  assert.equal(scans, 2);
  assert.equal(assets.referenceStatus("repository").status, "indexed");
});

test("adding repository membership invalidates already-indexed work references", async (t) => {
  const assets = fixture(t, {
    all: async () => [],
    pool: { query: async () => {} },
  });
  const repoRoot = path.join(assets.data, "repository");
  fs.mkdirSync(repoRoot);
  const asset = { id: "asset", name: "media.bin", sha: hash("fixture") };
  fs.writeFileSync(path.join(assets.data, "blobs", asset.sha), "fixture");
  assets.get = async () => asset;
  assets.repos.library = async () => ({ root: repoRoot });
  assets.saveCatalog = async () => {};
  assets.scans = new Map([
    [
      assets.referenceKey("repository", "work-a"),
      {
        repo: "repository",
        project: "work-a",
        at: Date.now(),
      },
    ],
  ]);
  assert.equal(
    assets.referenceStatus("repository", "work-a").status,
    "indexed",
  );
  await assets.linkRepository("asset", "repository", true);
  assert.equal(
    assets.referenceStatus("repository", "work-a").status,
    "unindexed",
  );
});

test("asset digests detect same-size inode replacements and refuse links after cache warmup", async (t) => {
  const assets = fixture(t);
  const file = path.join(assets.data, "media.bin");
  fs.writeFileSync(file, "old");
  assert.equal(await assets.digestFile(file), hash("old"));
  const prior = fs.statSync(file);
  const replacement = file + ".replacement";
  fs.writeFileSync(replacement, "new");
  fs.utimesSync(replacement, prior.atime, prior.mtime);
  fs.renameSync(replacement, file);
  assert.equal(await assets.digestFile(file), hash("new"));
  const alias = file + ".alias";
  fs.linkSync(file, alias);
  await assert.rejects(assets.digestFile(file), /Links and special files/);
  fs.unlinkSync(alias);
  fs.renameSync(file, replacement);
  fs.symlinkSync(replacement, file);
  await assert.rejects(assets.digestFile(file), /Links and special files/);
});

test("nanosecond changes invalidate digests even when millisecond attributes coincide", async (t) => {
  const assets = fixture(t);
  const file = path.join(assets.data, "media.bin");
  fs.writeFileSync(file, "old");
  assert.equal(await assets.digestFile(file), hash("old"));
  const prior = await fsp.lstat(file, { bigint: true });
  fs.writeFileSync(file, "new");
  const original = fsp.lstat;
  fsp.lstat = async (...args) => {
    const stat = await original(...args);
    if (args[0] !== file || !args[1]?.bigint) return stat;
    // Model two metadata updates inside the same millisecond; the hasher still
    // opens and verifies the actual file independently using regular stats.
    return Object.assign(Object.create(stat), {
      mtimeMs: prior.mtimeMs,
      ctimeMs: prior.ctimeMs,
      mtimeNs: prior.mtimeNs + 1n,
      ctimeNs: prior.ctimeNs + 1n,
    });
  };
  try {
    assert.equal(await assets.digestFile(file), hash("new"));
  } finally {
    fsp.lstat = original;
  }
});

test("cache hits recheck permissions and reject changes during verification", async (t) => {
  const assets = fixture(t);
  const file = path.join(assets.data, "media.bin");
  fs.writeFileSync(file, "fixture");
  assert.equal(await assets.digestFile(file), hash("fixture"));
  const original = fsp.lstat;
  let checks = 0;
  fsp.lstat = async (...args) => {
    if (args[0] === file && args[1]?.bigint && ++checks === 2)
      fs.chmodSync(file, 0o600);
    return original(...args);
  };
  try {
    await assert.rejects(
      assets.digestFile(file),
      (error) => error.statusCode === 409,
    );
  } finally {
    fsp.lstat = original;
  }
  assert.equal(await assets.digestFile(file), hash("fixture"));
});
