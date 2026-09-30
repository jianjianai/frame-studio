import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { database } from "../../server/db.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const result = {
  time: new Date().toISOString(),
  baseline: process.env.FRAME_PERF_BASELINE || "working checkout",
  note: "Controlled contention: simultaneous distinct advisory locks, synchronized callbacks; acquisition timeout reduced from production 10000 ms to 500 ms for bounded reproduction.",
  cases: [],
};
if (
  !/\/frame_test[^/]*$/.test(
    new URL(process.env.FRAME_TEST_DATABASE_URL).pathname,
  )
)
  throw Error("Isolated frame_test database only");
const db = await database(
  process.env.FRAME_TEST_DATABASE_URL,
  "lock-fixture-only-1234",
);
db.pool.options.connectionTimeoutMillis = 500;
db.lockPool.options.connectionTimeoutMillis = 500;
async function run(count, withListener) {
  const listener = withListener ? await db.pool.connect() : null;
  if (listener) await listener.query("LISTEN frame_changes");
  let entered = 0,
    release;
  const gate = new Promise((r) => (release = r));
  const start = performance.now();
  let saturation;
  const reads = Array.from({ length: count }, (_, i) =>
    db.lock("perf-lock:" + withListener + ":" + count + ":" + i, async () => {
      if (++entered === count) {
        saturation = {
          ordinaryTotal: db.pool.totalCount,
          ordinaryIdle: db.pool.idleCount,
          lockTotal: db.lockPool.totalCount,
          lockIdle: db.lockPool.idleCount,
        };
        release();
      }
      await gate;
      return db.one("SELECT 1 AS ok");
    }),
  );
  const settled = await Promise.allSettled(reads);
  listener?.release();
  result.cases.push({
    concurrentLocks: count,
    listener: withListener,
    elapsedMs: +(performance.now() - start).toFixed(2),
    poolAtCallbackBarrier: saturation,
    successes: settled.filter((v) => v.status === "fulfilled").length,
    errors: settled
      .filter((v) => v.status === "rejected")
      .map((v) => v.reason.message),
  });
}
try {
  await run(11, false);
  await run(10, true);
  await run(11, true);
} finally {
  await db.pool.end();
  fs.writeFileSync(
    path.join(
      root,
      "records/performance-optimization-20260930/lock-results.json",
    ),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
}
