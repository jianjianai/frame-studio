import test from "node:test";
import assert from "node:assert/strict";
import { runtimeLimits } from "../../server/runtime-status.mjs";

test("execution and free-space limits have safe defaults and reject invalid configuration", () => {
  assert.deepEqual(runtimeLimits({}), { concurrency: 2, minFreeBytes: 1073741824 });
  assert.deepEqual(runtimeLimits({ FRAME_TASK_CONCURRENCY: "3", FRAME_MIN_FREE_BYTES: "0" }), { concurrency: 3, minFreeBytes: 0 });
  for (const value of ["0", "-1", "1.2", "9", "invalid"])
    assert.throws(() => runtimeLimits({ FRAME_TASK_CONCURRENCY: value }));
  for (const value of ["-1", "Infinity", "NaN", "1.5"])
    assert.throws(() => runtimeLimits({ FRAME_MIN_FREE_BYTES: value }));
});
