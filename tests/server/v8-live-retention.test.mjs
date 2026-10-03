import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { Retention, pruneLiveReviewReferences } from "../../server/retention.mjs";
import { liveReviewSnapshotKey, isLiveReviewRevision } from "../../server/live-review-snapshot.mjs";
import { randomUUID } from "node:crypto";
import { fixture as paseoFixture } from "./paseo-test-fixture.mjs";

test("live review retention bounds storage and pins queued references without following symlinks", async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-live-retention-"));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const session = "11111111-1111-4111-8111-111111111111",
    now = Date.now();
  const make = (letter, age, size = 16) => {
    const revision = letter.repeat(64),
      dir = path.join(data, "live-preview-references", session, revision);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "source.ts"), Buffer.alloc(size));
    fs.utimesSync(dir, new Date(now - age), new Date(now - age));
    return { dir, key: session + "/" + revision };
  };
  const expired = make("a", 8 * 86400000);
  const pinned = make("b", 9 * 86400000);
  const recent = make("c", 1000);
  const evicted = make("d", 3600000);
  const outside = path.join(data, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep"), "keep");
  fs.symlinkSync(
    outside,
    path.join(data, "live-preview-references", session, "e".repeat(64)),
  );
  const result = await pruneLiveReviewReferences(data, {
    now,
    protectedKeys: new Set([pinned.key]),
    maxBytes: 32,
  });
  assert.equal(result.removed, 2);
  assert.equal(result.bytes, 32);
  assert.equal(fs.existsSync(expired.dir), false);
  assert.equal(fs.existsSync(evicted.dir), false);
  assert.equal(fs.existsSync(pinned.dir), true);
  assert.equal(fs.existsSync(recent.dir), true);
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "keep");
});

test("compiled snapshot retention counts bytes, protects the exact compiled variant and expires either layout", async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-compiled-retention-"));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const session = "11111111-1111-4111-8111-111111111111", sourceRevision = "a".repeat(64), now = Date.now();
  const make = (compiledRevision, age, size) => {
    const reference = { liveSessionId: session, sourceRevision, ...(compiledRevision ? { compiledRevision } : {}) };
    const dir = path.join(data, "live-preview-references", liveReviewSnapshotKey(reference));
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "code.ts"), Buffer.alloc(size));
    fs.utimesSync(dir, new Date(now - age), new Date(now - age));
    return { reference, dir };
  };
  const old = make(null, 9 * 86400000, 11), pinned = make("b".repeat(64), 9 * 86400000, 17);
  const expired = make("c".repeat(64), 8 * 86400000, 23), budget = make("d".repeat(64), 3600000, 29);
  const recent = make("e".repeat(64), 1000, 31);
  const result = await pruneLiveReviewReferences(data, { now,
    protectedKeys: new Set([liveReviewSnapshotKey(old.reference), liveReviewSnapshotKey(pinned.reference)]), maxBytes: 59 });
  assert.deepEqual(result, { removed: 2, bytes: 59 });
  for (const item of [old, pinned, recent]) assert.equal(fs.existsSync(item.dir), true);
  for (const item of [expired, budget]) assert.equal(fs.existsSync(item.dir), false);
  assert.equal(isLiveReviewRevision(sourceRevision + "-" + "b".repeat(64)), true);
  assert.equal(isLiveReviewRevision(sourceRevision + "-extra"), false);
});

test("real SQL retention preserves active, retained and native-message references in both snapshot layouts", async t => {
  const f = await paseoFixture(t); await f.workService.prepare(f.work.id);
  const now = Date.now(), session = randomUUID(), sourceRevision = "a".repeat(64);
  const snapshot = (compiledRevision, age = 9 * 86400000) => {
    const reference = { status: "versioned", mode: "live", source: "work", liveSessionId: session, sourceRevision,
      ...(compiledRevision ? { compiledRevision } : {}) };
    const directory = path.join(f.data, "live-preview-references", liveReviewSnapshotKey(reference));
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "scene.ts"), "retained source");
    fs.utimesSync(directory, new Date(now - age), new Date(now - age));
    return { reference, directory };
  };
  const legacy = snapshot(null), retained = snapshot("b".repeat(64)), native = snapshot("c".repeat(64));
  const otherVariant = snapshot("d".repeat(64)), expiredTask = snapshot("e".repeat(64)), recent = snapshot("f".repeat(64), 1000);
  for (const [entry, state, expires] of [[legacy, "queued", now - 86400000], [retained, "succeeded", now + 86400000], [expiredTask, "failed", now - 86400000]])
    await f.db.pool.query("INSERT INTO tasks(id,repo,project,kind,state,input,review_reference,expires) VALUES($1,$2,$3,'frame',$4,'{}',$5,$6)",
      [randomUUID(), f.work.repo, f.work.project, state, entry.reference, new Date(expires).toISOString()]);
  await f.store.freezeMessage({ workId: f.work.id, agentId: "native-agent", messageId: randomUUID(), intentHash: "b".repeat(64),
    envelope: { context: {} }, reviewReference: native.reference });
  const retention = new Retention(f.db, f.data); t.after(() => retention.close());
  await retention.collect();
  for (const entry of [legacy, retained, native, recent]) assert.equal(fs.existsSync(entry.directory), true);
  for (const entry of [otherVariant, expiredTask]) assert.equal(fs.existsSync(entry.directory), false);
});
