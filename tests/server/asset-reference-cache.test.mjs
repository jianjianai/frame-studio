import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Assets } from "../../server/assets.mjs";

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
