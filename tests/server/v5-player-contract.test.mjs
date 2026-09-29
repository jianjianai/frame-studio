import test from "node:test";
import assert from "node:assert/strict";
import {
  decodePlayerMessage,
  decodeExportMessage,
  positionReference,
} from "../../src/contracts/player-bridge.mjs";

test("V5 player bridge shares validated preferences, readiness, errors and stable shot references", () => {
  assert.deepEqual(
    decodePlayerMessage({ type: "frame-player-ready", extra: true }),
    { type: "frame-player-ready" },
  );
  assert.equal(
    decodePlayerMessage({
      type: "frame-player-preferences",
      preferences: { quality: "unknown" },
    }),
    null,
  );
  assert.equal(
    decodePlayerMessage({
      type: "frame-download-error",
      message: "x".repeat(4001),
    }),
    null,
  );
  const state = {
    type: "frame-player-state",
    time: 3,
    duration: 12,
    fps: 30,
    playing: false,
    buffering: false,
    rate: 1,
    loop: false,
    volume: 1,
    muted: false,
    shotId: "opening",
  };
  assert.equal(decodePlayerMessage(state).shotId, "opening");
  assert.equal(decodePlayerMessage({ ...state, shotId: "../invalid" }), null);
  assert.equal(decodePlayerMessage({ ...state, time: Infinity }), null);
  const reference = {
    previewTask: "fixture-preview",
    sourceCommit: "a".repeat(40),
  };
  assert.deepEqual(
    positionReference(
      { ...state, selection: { start: 1, end: 4 } },
      reference,
      true,
    ),
    { start: 1, end: 4, ...reference, shotId: "opening" },
  );
  assert.deepEqual(positionReference(state, reference), {
    time: 3,
    ...reference,
    shotId: "opening",
  });
});

test("V5 export messages ignore another request, invalid phases and unbounded progress while preserving preparing total zero", () => {
  const message = {
    type: "frame-export-state",
    id: "export-1",
    state: "running",
    progress: { phase: "preparing", completed: 0, total: 0 },
    executable: "untrusted",
  };
  assert.equal(decodeExportMessage(message, "export-2"), null);
  assert.equal(decodeExportMessage(message, "export-1").progress.total, 0);
  assert.equal(decodeExportMessage(message, "export-1").executable, undefined);
  for (const progress of [
    { completed: -1 },
    { total: Infinity },
    { phase: "execute" },
  ])
    assert.equal(
      decodeExportMessage({ ...message, progress }, "export-1"),
      null,
    );
  const blob = new Blob(["fixture-video"], { type: "video/webm" });
  assert.equal(
    decodeExportMessage({ ...message, state: "succeeded", blob }, "export-1")
      .blob,
    blob,
  );
});
