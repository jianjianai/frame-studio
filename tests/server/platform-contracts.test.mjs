import test from "node:test";
import assert from "node:assert/strict";
import { workChatCreateSchema, reviewContextSchema, playerCommandSchema, taskStateSchema } from "../../src/contracts/platform.mjs";
const id = "e119cb8c-6933-43f3-9f3d-a3ea99cd23cb";
test("chat connections are explicit and review ranges are complete", () => {
  assert.equal(workChatCreateSchema.safeParse({ id }).success, false);
  assert.equal(workChatCreateSchema.safeParse({ id, connection: id, provider: "codex" }).success, false);
  assert.equal(workChatCreateSchema.safeParse({ id, connection: id }).success, true);
  assert.equal(workChatCreateSchema.safeParse({ id, provider: "codex" }).success, true);
  assert.equal(reviewContextSchema.safeParse({ start: 4 }).success, false);
  assert.equal(reviewContextSchema.safeParse({ start: 4, end: 2 }).success, false);
});
test("player commands and durable publication states have one runtime contract", () => {
  assert.equal(playerCommandSchema.safeParse({ type: "frame-player-command", command: "seek", time: Infinity }).success, false);
  assert.equal(playerCommandSchema.safeParse({ type: "frame-player-command", command: "seek", time: 3 }).success, true);
  assert.equal(taskStateSchema.safeParse("publish_failed").success, true);
});

test("stored speech auditions are readable without becoming executable jobs", async () => {
  const { taskKindSchema, executableTaskKindSchema } = await import("../../src/contracts/platform.mjs");
  assert.equal(taskKindSchema.safeParse("speech-test").success, true);
  assert.equal(executableTaskKindSchema.safeParse("speech-test").success, false);
});
