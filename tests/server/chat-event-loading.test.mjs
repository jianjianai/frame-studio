import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { loadTaskEvents } from "../../studio/task-events.js";

test("hundreds of historical and queued turns do not consume live subscription slots", { timeout: 3000 }, async () => {
  const tasks = [
    ...Array.from({ length: 120 }, (_, i) => ({ id: "history-" + i, state: "succeeded" })),
    ...Array.from({ length: 100 }, (_, i) => ({ id: "queued-" + i, state: "queued" })),
    { id: "live", state: "running" },
  ];
  let readers = 0, peak = 0, reads = 0, stopped = 0;
  const subscriptions = [], errors = [], cache = {};
  const stop = loadTaskEvents({ tasks, cache,
    call: async () => { readers++; peak = Math.max(peak, readers); await setImmediate(); readers--; reads++; return { events: [] }; },
    subscribe: (_name, args, receive) => { subscriptions.push({ args, receive }); return () => stopped++; },
    onChange: () => {}, onError: (error) => errors.push(error),
  });
  while (reads < 120) await setImmediate();
  assert.equal(subscriptions.length, 1);
  assert(peak <= 4);
  subscriptions[0].receive({ error: "subscription rejected" });
  assert.deepEqual(errors, ["subscription rejected"]);
  subscriptions[0].receive({ result: { events: [{ id: 12, data: { text: "live" } }] } });
  assert.equal(cache.live.after, 12);
  stop();
  assert.equal(stopped, 1);
  subscriptions[0].receive({ result: { events: [{ id: 13 }] } });
  assert.equal(cache.live.after, 12);
});
