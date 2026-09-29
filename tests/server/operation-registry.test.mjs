import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createOperationRegistry } from "../../server/operation-registry.mjs";

test("operations reject duplicate names instead of replacing their contract", async () => {
  const { add, call } = createOperationRegistry();
  add("example", "Example", { count: z.number().int() }, ({ count }) => count);
  assert.throws(() => add("example", "Replacement", {}, () => null), /Duplicate operation/);
  assert.equal(await call("example", { count: 3 }), 3);
  await assert.rejects(call("example", { count: "3" }));
  await assert.rejects(call("example", { count: 3, extra: true }));
  await assert.rejects(call("toString", {}), /Unknown operation/);
});

test("the registry also accepts a complete refined schema", async () => {
  const { add, call } = createOperationRegistry();
  add("range", "Range", z.strictObject({ start: z.number(), end: z.number() }).refine(v => v.end > v.start), v => v);
  await assert.rejects(call("range", { start: 2, end: 1 }));
  assert.deepEqual(await call("range", { start: 1, end: 2 }), { start: 1, end: 2 });
});
