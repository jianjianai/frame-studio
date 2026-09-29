import test from "node:test";
import assert from "node:assert/strict";
import { parsePatch, splitRows } from "../../studio/source-diff-model.js";

test("diff model preserves whitespace, EOF notes and original/new line numbers", () => {
  const parsed = parsePatch(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -7,2 +7,3 @@ render\n context\n-  old\n+  new\n+\tmore\n\\ No newline at end of file\n",
  );
  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.added, 2);
  assert.equal(parsed.removed, 1);
  const lines = parsed.hunks[0].lines;
  assert.deepEqual(lines[1], {
    kind: "remove",
    text: "  old",
    oldLine: 8,
    newLine: null,
  });
  assert.deepEqual(lines[3], {
    kind: "add",
    text: "\tmore",
    oldLine: null,
    newLine: 9,
  });
  assert.equal(lines[4].kind, "meta");
  const rows = splitRows(lines);
  assert.equal(rows[1].left.text, "  old");
  assert.equal(rows[1].right.text, "  new");
  assert.equal(rows[2].left, undefined);
  assert.equal(rows[2].right.text, "\tmore");
});
test("diff model handles additions, deletions, multiple files and special text without running it", () => {
  const parsed = parsePatch(
    "diff --git a/new b/new\n@@ -0,0 +1 @@\n+<script>alert('fixture')</script>\ndiff --git a/gone b/gone\n@@ -1 +0,0 @@\n-gone\n",
  );
  assert.equal(parsed.hunks.length, 2);
  assert.equal(parsed.hunks[0].lines[0].newLine, 1);
  assert.equal(
    parsed.hunks[0].lines[0].text,
    "<script>alert('fixture')</script>",
  );
  assert.equal(parsed.hunks[1].lines[0].oldLine, 1);
  assert.equal(
    parsePatch("similarity index 100%\nrename from a\nrename to b\n").hunks
      .length,
    0,
  );
});
test("diff model bounds rendered rows but counts the complete returned patch", () => {
  const parsed = parsePatch("@@ -0,0 +1,5000 @@\n" + "+new\n".repeat(5000));
  assert.equal(parsed.added, 5000);
  assert.equal(parsed.hunks[0].lines.length, 4000);
  assert.equal(parsed.truncated, true);
});
