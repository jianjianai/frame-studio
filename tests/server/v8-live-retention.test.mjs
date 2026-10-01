import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { pruneLiveReviewReferences } from "../../server/retention.mjs";

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
