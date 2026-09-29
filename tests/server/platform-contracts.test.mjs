import test from "node:test";
import assert from "node:assert/strict";
import {
  workChatCreateSchema,
  reviewContextSchema,
  playerCommandSchema,
  taskStateSchema,
} from "../../src/contracts/platform.mjs";
const id = "e119cb8c-6933-43f3-9f3d-a3ea99cd23cb";
test("chat connections are explicit and review ranges are complete", () => {
  assert.equal(workChatCreateSchema.safeParse({ id }).success, false);
  assert.equal(
    workChatCreateSchema.safeParse({ id, connection: id, provider: "codex" })
      .success,
    false,
  );
  assert.equal(
    workChatCreateSchema.safeParse({ id, connection: id }).success,
    true,
  );
  assert.equal(
    workChatCreateSchema.safeParse({ id, provider: "codex" }).success,
    true,
  );
  assert.equal(reviewContextSchema.safeParse({ start: 4 }).success, false);
  assert.equal(
    reviewContextSchema.safeParse({ start: 4, end: 2 }).success,
    false,
  );
});
test("player commands and durable publication states have one runtime contract", () => {
  assert.equal(
    playerCommandSchema.safeParse({
      type: "frame-player-command",
      command: "seek",
      time: Infinity,
    }).success,
    false,
  );
  assert.equal(
    playerCommandSchema.safeParse({
      type: "frame-player-command",
      command: "seek",
      time: 3,
    }).success,
    true,
  );
  assert.equal(taskStateSchema.safeParse("publish_failed").success, true);
});

test("stored speech auditions are readable without becoming executable jobs", async () => {
  const { taskKindSchema, executableTaskKindSchema } =
    await import("../../src/contracts/platform.mjs");
  assert.equal(taskKindSchema.safeParse("speech-test").success, true);
  assert.equal(
    executableTaskKindSchema.safeParse("speech-test").success,
    false,
  );
});

test("workspace commands preserve selection, view preferences and narrow portrait export", () => {
  const parse = (payload) =>
    playerCommandSchema.safeParse({ type: "frame-player-command", ...payload })
      .success;
  assert.equal(
    parse({ command: "seek", time: 2, selection: { start: 1, end: 3 } }),
    true,
  );
  assert.equal(
    parse({
      command: "configure-view",
      preferences: { quality: "high", timelineVisible: false },
    }),
    true,
  );
  assert.equal(
    parse({
      command: "export-start",
      id: "review",
      options: { width: 274, fps: 30, subtitles: true, start: 0, end: 2 },
    }),
    true,
  );
  assert.equal(
    parse({
      command: "export-start",
      id: "review",
      options: { width: 275, fps: 30, subtitles: true },
    }),
    false,
  );
  for (const command of ["export-cancel", "export-download", "snapshot"])
    assert.equal(parse({ command }), true);
});
