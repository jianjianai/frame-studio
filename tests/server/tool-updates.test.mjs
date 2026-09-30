import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ToolReleases,
  compareToolVersions,
  normalizeToolVersion,
  installedToolVersion,
} from "../../server/tool-releases.mjs";
import { toolManagementOperations } from "../../server/tool-management.mjs";
import { createOperationRegistry } from "../../server/operation-registry.mjs";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { Tasks } from "../../server/tasks.mjs";
import { operationError } from "../../src/contracts/errors.mjs";
const metadata = (provider, version) =>
  new Response(
    JSON.stringify({
      name:
        provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code",
      version,
    }),
  );
const fixture = async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "frame-tool-updates-"));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  return data;
};
test("versions compare numerically, handle prereleases and reject package addresses/ranges", () => {
  assert.equal(compareToolVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareToolVersions("1.0.0", "1.0.0-rc.99"), 1);
  assert.equal(compareToolVersions("1.0.0-rc.10", "1.0.0-rc.2"), 1);
  assert.equal(compareToolVersions("1.0.0-beta", "1.0.0-beta.1"), -1);
  assert.equal(compareToolVersions("1.0.0-beta-test", "1.0.0-beta"), 1);
  assert.equal(compareToolVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareToolVersions("1.0.0", "1.0.0"), 0);
  assert.equal(installedToolVersion("codex-cli 0.110.2\n"), "0.110.2");
  assert.equal(installedToolVersion("2.4.0 (Claude Code)"), "2.4.0");
  assert.equal(normalizeToolVersion(" v1.2.3 "), "1.2.3");
  for (const bad of [
    "latest",
    "^1.2.3",
    "01.2.3",
    "1.2.3-rc.01",
    "https://evil/package",
    "1.2.3; echo pwned",
  ])
    assert.throws(() => normalizeToolVersion(bad));
});
test("automatic checks cache and coalesce; explicit refresh bypasses cache; failures keep marked stale information", async () => {
  let clock = 1_800_000_000_000,
    calls = 0,
    broken = false,
    current = "1.2.3";
  const releases = new ToolReleases({
    now: () => clock,
    fetchImpl: async (url) => {
      calls++;
      assert.equal(url, "https://registry.npmjs.org/%40openai%2Fcodex/latest");
      if (broken) throw Error("fixture-network-secret");
      return metadata("codex", current);
    },
  });
  const [first, second] = await Promise.all([
    releases.check("codex"),
    releases.check("codex"),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  await releases.check("codex");
  assert.equal(calls, 1);
  current = "1.3.0";
  assert.equal(
    (await releases.check("codex", { force: true })).latestVersion,
    "1.3.0",
  );
  broken = true;
  const failed = await releases.check("codex", { force: true });
  assert.equal(failed.status, "error");
  assert.equal(failed.latestVersion, "1.3.0");
  assert.doesNotMatch(failed.error, /fixture-network-secret/);
  await assert.rejects(releases.resolve("codex"), (error) => {
    assert.match(operationError(error).error, /无法连接/);
    return true;
  });
  broken = false;
  clock += 15 * 60_000;
  assert.equal((await releases.check("codex")).status, "ready");
});
test("manual versions must exist in the official package and responses are bounded/validated", async () => {
  const urls = [];
  const releases = new ToolReleases({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith("/9.9.9")) return new Response("{}", { status: 404 });
      return metadata("codex", "1.2.3");
    },
  });
  assert.equal(await releases.resolve("codex", " v1.2.3 "), "1.2.3");
  await assert.rejects(releases.resolve("codex", "9.9.9"), /没有这个版本/);
  await assert.rejects(releases.resolve("codex", "1.2.4"), /版本与请求不一致/);
  await assert.rejects(releases.resolve("codex", "^1.2.3"), /完整版本号/);
  assert.equal(urls.length, 3);
  await assert.rejects(
    new ToolReleases({
      fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1)),
    }).resolve("codex", "1.2.3"),
    /超过读取上限/,
  );
  await assert.rejects(
    new ToolReleases({
      fetchImpl: async () => metadata("claude", "1.2.3"),
    }).resolve("codex", "1.2.3"),
    /不匹配/,
  );
});
test("tool operations pin latest before queueing, show history and reject duplicate active updates", async (t) => {
  const data = await fixture(t),
    queued = [];
  let active = null,
    releaseCalls = 0;
  await fs.mkdir(path.join(data, "tools/codex/1.9.0"), { recursive: true });
  await fs.mkdir(path.join(data, "tools/codex/1.10.0"), { recursive: true });
  await fs.mkdir(path.join(data, "tools/codex/.install-incomplete"), {
    recursive: true,
  });
  const registry = createOperationRegistry();
  const db = {
    one: async () => active,
    all: async (_sql, [provider]) =>
      queued.filter((task) => task.input.provider === provider),
  };
  toolManagementOperations({
    add: registry.add,
    db,
    data,
    releases: new ToolReleases({
      fetchImpl: async (url) => {
        releaseCalls++;
        return metadata(
          url.includes("openai") ? "codex" : "claude",
          url.endsWith("latest")
            ? "1.11.0"
            : decodeURIComponent(url.split("/").at(-1)),
        );
      },
    }),
    run: async (bin) => {
      if (bin === "claude") throw Error("not-installed");
      return "codex-cli 1.9.0";
    },
    tasks: {
      create: async (task) => {
        const result = { ...task, id: "fixture", state: "queued" };
        queued.push(result);
        return result;
      },
    },
  });
  const info = await registry.call("tools_info");
  assert.equal(info[0].updateAvailable, true);
  assert.deepEqual(info[0].installedVersions, ["1.10.0", "1.9.0"]);
  assert.equal(info[1].available, false);
  await registry.call("tools_info");
  assert.equal(releaseCalls, 2);
  const latest = await registry.call("tools_update", { provider: "codex" });
  assert.equal(latest.input.version, "1.11.0");
  assert.equal(latest.input.requestedVersion, "latest");
  const manual = await registry.call("tools_update", {
    provider: "codex",
    version: "v1.9.0",
  });
  assert.equal(manual.input.version, "1.9.0");
  assert.equal((await registry.call("tools_info"))[0].updates.length, 2);
  active = { id: "existing-update" };
  const before = releaseCalls;
  await assert.rejects(
    registry.call("tools_update", { provider: "claude" }),
    /另一项工具更新/,
  );
  assert.equal(releaseCalls, before);
  await registry.call("tools_check_updates");
  assert.equal(releaseCalls, before + 2);
});
test("local mode checks releases but leaves installation to the computer's CLI manager", async (t) => {
  const prior = process.env.FRAME_LOCAL_MODE;
  process.env.FRAME_LOCAL_MODE = "1";
  try {
    const registry = createOperationRegistry();
    toolManagementOperations({
      add: registry.add,
      db: {},
      data: await fixture(t),
      tasks: {},
      releases: new ToolReleases({
        fetchImpl: async () => metadata("codex", "1.2.3"),
      }),
    });
    await assert.rejects(
      registry.call("tools_update", { provider: "codex" }),
      /本地模式/,
    );
  } finally {
    if (prior === undefined) delete process.env.FRAME_LOCAL_MODE;
    else process.env.FRAME_LOCAL_MODE = prior;
  }
});


test("cancelling and unfinished publication prevent concurrent tool installers", async (t) => {
  const data = await fixture(t), db = await sqliteDatabase(path.join(data, "frame.sqlite"));
  const tasks = new Tasks(db, data, {}, null), registry = createOperationRegistry();
  let resolutions = 0;
  t.after(async () => { await tasks.close(); await db.pool.end(); });
  toolManagementOperations({ add: registry.add, db, data, tasks,
    releases: { resolve: async () => { resolutions++; return "1.2.3"; } },
  });
  const existing = await tasks.create({ kind: "tools-update", input: { provider: "claude", version: "1.2.3" } });
  for (const state of ["cancelling", "publishing", "publish_failed"]) {
    await db.pool.query("UPDATE tasks SET state=$2 WHERE id=$1", [existing.id, state]);
    await assert.rejects(registry.call("tools_update", { provider: "codex", version: "latest" }), { statusCode: 409 });
    await assert.rejects(tasks.create({ kind: "tools-update", input: { provider: "codex", version: "1.2.3" } }), { statusCode: 409 });
  }
  assert.equal(resolutions, 0, "Busy updates are rejected before querying external metadata");
  assert.equal((await db.one("SELECT count(*)::int AS n FROM tasks")).n, 1);
});
