import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { database } from "../../server/db.mjs";
import { acquireDatabaseClient } from "../../server/scoped-pool.mjs";

const url = process.env.FRAME_TEST_DATABASE_URL;
const options = { skip: !url, timeout: 15000 };
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  assert.match(new URL(url).pathname, /\/frame_test[^/]*$/);
  const db = await database(url, "lock-regression-only-1234");
  db.pool.options.max = 3;
  db.pool.options.connectionTimeoutMillis = 500;
  db.lockPool.options.max = 2;
  db.lockPool.options.connectionTimeoutMillis = 500;
  return db;
}

test(
  "saturated advisory locks reuse their clients for SQL, nested locks and transactions",
  options,
  async () => {
    const db = await fixture();
    let listener;
    try {
      listener = await db.pool.connect();
      await listener.query("LISTEN frame_changes");
      const gate = deferred();
      let entered = 0;
      const ids = [randomUUID(), randomUUID()];
      const results = await Promise.all(
        ids.map((id) =>
          db.lock(id, async () => {
            if (++entered === ids.length) gate.resolve();
            await gate.promise;
            const outer = await db.one("SELECT pg_backend_pid() AS pid");
            const direct = (
              await db.pool.query("SELECT pg_backend_pid() AS pid")
            ).rows[0];
            assert.equal(direct.pid, outer.pid);
            await db.lock(id, async () => {
              assert.equal(
                (await db.one("SELECT pg_backend_pid() AS pid")).pid,
                outer.pid,
              );
            });
            await db.lock(id + ":nested", async () => {
              assert.equal(
                (await db.one("SELECT pg_backend_pid() AS pid")).pid,
                outer.pid,
              );
              const client = await acquireDatabaseClient(db);
              try {
                await client.query("BEGIN");
                assert.equal(
                  (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
                    .pid,
                  outer.pid,
                );
                await client.query("COMMIT");
              } finally {
                client.release();
              }
            });
            assert.equal((await db.one("SELECT 1 AS ok")).ok, 1);
            return outer.pid;
          }),
        ),
      );
      assert.equal(
        new Set(results).size,
        2,
        "independent operations retain independent sessions",
      );
      assert.equal(db.pool.waitingCount, 0);
      assert.equal(db.lockPool.waitingCount, 0);
    } finally {
      listener?.release();
      await db.pool.end();
    }
  },
);

test(
  "lock conflicts remain exclusive and errors or rollback release resources",
  options,
  async () => {
    const db = await fixture();
    const key = randomUUID(),
      entered = deferred(),
      finish = deferred();
    let holder;
    try {
      holder = db.lock(key, async () => {
        entered.resolve();
        await finish.promise;
      });
      await entered.promise;
      await assert.rejects(
        db.lock(key, async () => {}),
        { statusCode: 409 },
      );
      finish.resolve();
      await holder;
      await assert.rejects(
        db.lock(key, async () => {
          throw Error("callback failure");
        }),
        /callback failure/,
      );
      await db.lock(key, async () => {
        const client = await acquireDatabaseClient(db);
        try {
          await client.query("BEGIN");
          await client.query("SELECT 1");
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
        assert.equal((await db.one("SELECT 1 AS ok")).ok, 1);
      });
      await db.lock(key, async () => {});
    } finally {
      finish.resolve();
      await holder?.catch(() => {});
      await db.pool.end();
    }
  },
);

test(
  "detached async callbacks cannot query a released lock session",
  options,
  async () => {
    const db = await fixture();
    const gate = deferred();
    let detached, held;
    try {
      const originalPid = await db.lock(randomUUID(), async () => {
        detached = gate.promise.then(() =>
          db.one("SELECT pg_backend_pid() AS pid"),
        );
        return (await db.one("SELECT pg_backend_pid() AS pid")).pid;
      });
      held = await db.lockPool.connect();
      assert.equal(
        (await held.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        originalPid,
      );
      gate.resolve();
      assert.notEqual(
        (await detached).pid,
        originalPid,
        "the old session is now owned by another caller",
      );
    } finally {
      gate.resolve();
      await detached?.catch(() => {});
      held?.release();
      await db.pool.end();
    }
  },
);

test(
  "concurrent transaction borrowing fails before issuing a second BEGIN",
  options,
  async () => {
    const db = await fixture();
    try {
      await db.lock(randomUUID(), async () => {
        const first = await acquireDatabaseClient(db);
        try {
          await first.query("BEGIN");
          await assert.rejects(
            acquireDatabaseClient(db),
            /transaction already owns/i,
          );
          assert.equal((await first.query("SELECT 1 AS ok")).rows[0].ok, 1);
          await first.query("ROLLBACK");
        } finally {
          first.release();
        }
        const second = await acquireDatabaseClient(db);
        try {
          assert.equal((await second.query("SELECT 2 AS ok")).rows[0].ok, 2);
        } finally {
          second.release();
        }
      });
    } finally {
      await db.pool.end();
    }
  },
);


test(
  "saturated lock holders can await an ordinary database read started outside their scopes",
  options,
  async () => {
    const db = await fixture(), gate = deferred();
    let listener, shared;
    try {
      listener = await db.pool.connect();
      await listener.query("LISTEN frame_changes");
      // This read belongs to an older background refresh, not either lock scope.
      // It needs ordinary-query capacity after every lock session is occupied.
      shared = gate.promise.then(() => db.one("SELECT pg_backend_pid() AS pid"));
      let entered = 0;
      const results = await Promise.all([randomUUID(), randomUUID()].map((id) =>
        db.lock(id, async () => {
          const ownPid = (await db.one("SELECT pg_backend_pid() AS pid")).pid;
          if (++entered === 2) gate.resolve();
          const result = await shared;
          assert.notEqual(result.pid, ownPid);
          return result.pid;
        })
      ));
      assert.equal(results[0], results[1], "the callbacks share the same outside-scope read");
      assert.equal(db.pool.waitingCount, 0);
      assert.equal(db.lockPool.waitingCount, 0);
    } finally {
      gate.resolve();
      await shared?.catch(() => {});
      listener?.release();
      await db.pool.end();
    }
  },
);
