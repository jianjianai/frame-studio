import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { nativeWorkflowFixture } from "./paseo-workflow-fixture.mjs";
import { command } from "../../server/process.mjs";

test("Actual ready preview, iframe, startup and reconciliation reuse one workspace while its preparation lock is held", {
  skip: !process.env.FRAME_TEST_DATABASE_URL, timeout: 120000,
}, async t => {
  const f = await nativeWorkflowFixture(t, { port: Number(process.env.FRAME_TEST_PORT || 59496), databasePrefix: "frame_test_workspace_" });
  const manager = f.services.paseoManager, workspace = f.services.paseoWorkspace;
  const first = await f.services.paseoStore.getWork(f.work.id), child = manager.children.get(f.work.id);
  const marker = path.join(f.data, "paseo", f.work.id, "workspace.json");
  const before = await fs.stat(marker, { bigint: true });
  const git = args => command("git", args, { cwd: f.ready.workspaceRoot });
  const index = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
  const indexBefore = await fs.stat(index, { bigint: true });
  const login = await fetch(f.origin + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: f.origin },
    body: JSON.stringify({ password: "owned-native-workflow-password" }) });
  assert.equal(login.status, 200, await login.text());
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const get = async url => {
    const response = await fetch(f.origin + url, { headers: { Cookie: cookie } });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return { response, body };
  };
  const probe = await f.db.pool.connect();
  let release, acquired;
  const released = new Promise(resolve => { release = resolve; });
  const locked = new Promise(resolve => { acquired = resolve; });
  const holding = f.db.lock("paseo-workspace:" + f.work.id, async () => { acquired(); await released; });
  await locked;
  try {
    // An independent PostgreSQL session proves this is an actual contended advisory lock.
    const result = await probe.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", ["paseo-workspace:" + f.work.id]);
    assert.equal(result.rows[0].acquired, false);
    for (let batch = 0; batch < 3; batch++) {
      const pending = [manager.start(f.work.id), manager.tick(), workspace.reconcile(f.work.id),
        ...Array.from({ length: 8 }, () => manager.ensure(f.work.id)),
        ...Array.from({ length: 4 }, () => get(`/api/paseo/works/${f.work.id}/session`)),
        ...Array.from({ length: 4 }, () => get(`/paseo/${f.work.id}/h/${f.ready.serverId}/workspace/${f.ready.workspaceId}`)),
        f.call("works_live_preview", { id: f.work.id }).then(async preview => {
          const html = await get(preview.url);
          assert.match(html.body, /__FRAME_LIVE_PREVIEW__/);
        })];
      const results = await Promise.all(pending);
      for (const ready of results.slice(3, 11)) {
        assert.equal(ready.generation, first.daemonGeneration);
        assert.equal(ready.workspaceRoot, f.ready.workspaceRoot);
        assert.equal(ready.serverId, first.serverId);
      }
      for (const { body } of results.slice(11, 15)) {
        const session = JSON.parse(body);
        assert.equal(session.bootstrap.workspaceId, first.workspaceId);
        assert.equal(session.status.native.state, "ready");
      }
      for (const { response, body } of results.slice(15, 19)) {
        assert.match(response.headers.get("content-type"), /^text\/html/);
        assert.match(body, /__PASEO_FRAME_EMBED__/);
      }
    }
  } finally { release(); try { await holding; } finally { probe.release(); } }
  const latest = await f.services.paseoStore.getWork(f.work.id);
  assert.equal(latest.state, "ready");
  assert.equal(latest.daemonGeneration, first.daemonGeneration);
  assert.equal(latest.serverId, first.serverId);
  assert.equal(latest.workspaceId, first.workspaceId);
  assert.equal(manager.children.size, 1);
  assert.strictEqual(manager.children.get(f.work.id), child);
  const after = await fs.stat(marker, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  const indexAfter = await fs.stat(index, { bigint: true });
  assert.equal(indexAfter.ino, indexBefore.ino);
  assert.equal((await git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim(), index);
});
