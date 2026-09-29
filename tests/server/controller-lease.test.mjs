import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ControllerLease } from "../../server/controller-lease.mjs";

test("one dedicated database session owns admission, and connection loss fences it", async () => {
  let owner = null;
  class Client extends EventEmitter {
    async query({ text }) {
      if (text.includes("pg_try_advisory_lock")) { const ok = !owner; if (ok) owner = this; return { rows: [{ ok }] }; }
      return { rows: [{}] };
    }
    release() { if (owner === this) owner = null; }
  }
  const pool = { connect: async () => new Client() };
  const first = new ControllerLease(pool), second = new ControllerLease(pool);
  assert.equal(await first.acquire(), true);
  assert.equal(await second.acquire(), false);
  const old = first.client;
  old.emit("error", new Error("Connection lost"));
  await assert.rejects(first.assert(), /leadership/);
  assert.equal(await second.acquire(), true);
  first.close(); second.close();
  assert.equal(owner, null);
});
