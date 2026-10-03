import test from "node:test";
import assert from "node:assert/strict";
import { paseoReferenceUrl, readPaseoReference, paseoReferenceMatch, paseoReferencePosition } from "../../studio/paseo-reference.mjs";

const workId = "e68a0b4b-0a63-463e-861b-7f3403220255";
const sourceRevision = "a".repeat(64), compiledRevision = "b".repeat(64);
const context = { start: 12, end: 22, liveSessionId: "b79b5738-b9ab-46ca-953b-168e1bfc9c60", sourceRevision, compiledRevision };

test("a sent native resource link preserves its work, exact time range and both preview revisions after serialization", () => {
  const attachment = JSON.parse(JSON.stringify({ externalResource: { url: paseoReferenceUrl(workId, context, "https://frame.example/?transient=1#/library") } }));
  const url = new URL(attachment.externalResource.url);
  assert.equal(url.origin, "https://frame.example");
  assert.equal(url.hash, "#/work/" + workId);
  assert.equal(url.searchParams.has("transient"), false);
  assert.deepEqual(readPaseoReference(url, workId), context);
  assert.deepEqual(paseoReferencePosition(context), { time: 12, selection: { start: 12, end: 22 } });
  assert.equal(readPaseoReference(url, "c46d6bcd-bca7-40fb-b454-b25b078e55e7"), null);
});

test("positioning waits for the applied provenance and rejects changes to source or compiled visuals", () => {
  assert.equal(paseoReferenceMatch(context, {}), "pending");
  assert.equal(paseoReferenceMatch(context, { sourceRevision }), "pending");
  assert.equal(paseoReferenceMatch(context, { sourceRevision, compiledRevision }), "matched");
  assert.equal(paseoReferenceMatch(context, { sourceRevision: "c".repeat(64), compiledRevision }), "changed");
  assert.equal(paseoReferenceMatch(context, { sourceRevision, compiledRevision: "c".repeat(64) }), "changed");
  assert.equal(paseoReferenceMatch({ time: 5 }, { sourceRevision, compiledRevision }), "unversioned");
  const immutable = { time: 5, sourceCommit: "d".repeat(40) };
  assert.equal(paseoReferenceMatch(immutable, { sourceRevision, compiledRevision }), "changed");
  assert.equal(paseoReferenceMatch(immutable, immutable), "matched");
});

test("malformed, oversized and invalid coordinate links cannot issue player positioning", () => {
  for (const encoded of ["{bad", JSON.stringify({ version: 1, workId, context: { time: -1 } }),
    JSON.stringify({ version: 1, workId, context: {} }),
    JSON.stringify({ version: 1, workId, context: { start: 3, end: 1 } }), "x".repeat(4097)]) {
    const url = new URL("https://frame.example/#/work/" + workId);
    url.searchParams.set("frameReference", encoded);
    assert.throws(() => readPaseoReference(url, workId), /链接已损坏/);
  }
  assert.throws(() => paseoReferenceUrl(workId, context, "javascript:alert(1)"));
});
