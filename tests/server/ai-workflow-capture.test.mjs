import test from "node:test";
import assert from "node:assert/strict";
import { parseNativeCapture } from "./ai-workflow-fixture.mjs";

test("Native workflow capture reads complete JSONL rows while an append is in progress and rejects completed corruption", () => {
  const first = { kind: "launch", pid: 123 }, second = { kind: "accepted-turn", prompt: "streamed 作品" };
  const a = JSON.stringify(first), b = JSON.stringify(second), split = b.indexOf("streamed") + 3;
  assert.deepEqual(parseNativeCapture(a), [], "A first record needs its newline before becoming visible");
  assert.deepEqual(parseNativeCapture(a + "\n" + b.slice(0, split)), [first]);
  assert.deepEqual(parseNativeCapture(a + "\n" + b), [first]);
  assert.deepEqual(parseNativeCapture(a + "\n" + b + "\n"), [first, second]);
  assert.throws(() => parseNativeCapture(a + "\n" + '{"invalid":\n'), SyntaxError,
    "Complete invalid records remain failures rather than being silently discarded");
});
