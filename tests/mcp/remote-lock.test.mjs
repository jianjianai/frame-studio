import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { acquireRemoteLock } from "../../scripts/mcp/remote-lock.mjs";
import { RemoteAuth } from "../../scripts/mcp/remote-auth.mjs";
import { loadRemoteConfig } from "../../scripts/mcp/remote-config.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
function directory(t) {
  const base = path.join(repo, ".cache", "remote-lock-tests");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "case-"));
  // This resolved directory is exclusively created by this test, inside its cache.
  assert.equal(path.dirname(root), base);
  t.after(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  );
  return root;
}
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  return child.pid;
}
const writeLock = (root, pid, token = randomUUID()) => {
  const text = JSON.stringify({ pid, token });
  fs.writeFileSync(path.join(root, "server.lock"), text);
  return text;
};

test("live owner blocks duplicate startup and close only removes its own lock", (t) => {
  const root = directory(t),
    lease = acquireRemoteLock(root);
  assert.throws(
    () => acquireRemoteLock(root),
    (error) => {
      assert.equal(error.code, "SERVER_ALREADY_RUNNING");
      assert.equal(error.details.pid, process.pid);
      assert.ok(!JSON.stringify(error.details).includes(lease.token));
      return true;
    },
  );
  lease.close();
  lease.close();
  const next = acquireRemoteLock(root);
  lease.close();
  assert.equal(JSON.parse(fs.readFileSync(next.file)).token, next.token);
  next.close();
});

test("legacy crash lock recovers without clearing persisted OAuth grants", (t) => {
  const root = directory(t);
  const config = loadRemoteConfig(root, {
    env: {
      FRAME_MCP_PROJECTS: "*",
      FRAME_MCP_AUTH_MODE: "bearer",
      FRAME_MCP_BEARER_TOKEN: "t".repeat(48),
    },
  });
  const original = new RemoteAuth(config);
  original.state.grants.retained = { expires: Date.now() + 3600000 };
  original.save();
  original.close();
  const prior = fs.readFileSync(original.file, "utf8");
  const pid = deadPid();
  writeLock(config.stateDirectory, pid);
  const recovered = new RemoteAuth(config);
  try {
    assert.deepEqual(recovered.lockRecovery, { pid });
    assert.equal(fs.readFileSync(original.file, "utf8"), prior);
    assert.equal(JSON.parse(fs.readFileSync(recovered.lock)).pid, process.pid);
    assert.deepEqual(fs.readdirSync(config.stateDirectory).sort(), [
      "oauth.json",
      "server.lock",
    ]);
  } finally {
    recovered.close();
  }
});

test("unknown owner status and malformed or linked locks are never reclaimed", (t) => {
  const root = directory(t),
    file = path.join(root, "server.lock");
  for (const contents of [
    "",
    "{",
    "null",
    JSON.stringify({ pid: 0, token: randomUUID() }),
    JSON.stringify({ pid: -1, token: randomUUID() }),
    JSON.stringify({ pid: "123", token: randomUUID() }),
    JSON.stringify({ pid: 2147483648, token: randomUUID() }),
    "x".repeat(4097),
  ]) {
    fs.writeFileSync(file, contents);
    assert.throws(() => acquireRemoteLock(root), {
      code: "INVALID_SERVER_LOCK",
    });
    assert.equal(fs.readFileSync(file, "utf8"), contents);
  }
  const contents = writeLock(root, process.pid);
  const denied = t.mock.method(process, "kill", () => {
    throw Object.assign(new Error(), { code: "EPERM" });
  });
  assert.throws(() => acquireRemoteLock(root), {
    code: "SERVER_LOCK_OWNER_UNKNOWN",
  });
  assert.equal(fs.readFileSync(file, "utf8"), contents);
  denied.mock.restore();
  const link = path.join(root, "other.lock");
  fs.linkSync(file, link);
  assert.throws(() => acquireRemoteLock(root), { code: "INVALID_SERVER_LOCK" });
  assert.equal(fs.readFileSync(link, "utf8"), contents);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => acquireRemoteLock(root), { code: "INVALID_SERVER_LOCK" });
});

test("a lock replaced during dead-owner inspection is preserved", (t) => {
  const root = directory(t),
    pid = deadPid();
  writeLock(root, pid);
  let replacement;
  const kill = process.kill.bind(process);
  t.mock.method(process, "kill", (target, signal) => {
    if (target === pid) {
      replacement = writeLock(root, process.pid);
      throw Object.assign(new Error(), { code: "ESRCH" });
    }
    return kill(target, signal);
  });
  assert.throws(() => acquireRemoteLock(root), {
    code: "SERVER_ALREADY_RUNNING",
  });
  assert.equal(
    fs.readFileSync(path.join(root, "server.lock"), "utf8"),
    replacement,
  );
  assert.deepEqual(fs.readdirSync(root), ["server.lock"]);
});

test("interrupted recovery reports its guard and preserves ambiguous state", (t) => {
  const root = directory(t),
    contents = writeLock(root, deadPid());
  const guard = path.join(
    root,
    `server-recovery-${createHash("sha256").update(contents).digest("hex")}.lock`,
  );
  fs.writeFileSync(guard, "interrupted");
  assert.throws(
    () => acquireRemoteLock(root),
    (error) => {
      assert.equal(error.code, "SERVER_LOCK_RECOVERY_BUSY");
      assert.equal(error.details.lockPath, guard);
      return true;
    },
  );
  assert.equal(
    fs.readFileSync(path.join(root, "server.lock"), "utf8"),
    contents,
  );
  assert.equal(fs.readFileSync(guard, "utf8"), "interrupted");
});

test("OAuth initialization and port binding failures release their new lock", async (t) => {
  const root = directory(t);
  const config = loadRemoteConfig(root, {
    env: {
      FRAME_MCP_PROJECTS: "*",
      FRAME_MCP_AUTH_MODE: "bearer",
      FRAME_MCP_PORT: "0",
      FRAME_MCP_BEARER_TOKEN: "t".repeat(48),
    },
  });
  fs.mkdirSync(config.stateDirectory, { recursive: true });
  fs.writeFileSync(path.join(config.stateDirectory, "oauth.json"), "{}");
  assert.throws(() => new RemoteAuth(config), /Invalid OAuth state/);
  assert.equal(
    fs.existsSync(path.join(config.stateDirectory, "server.lock")),
    false,
  );
  fs.writeFileSync(
    path.join(config.stateDirectory, "oauth.json"),
    JSON.stringify({
      version: 1,
      clients: {},
      grants: {},
      access: {},
      refresh: {},
    }),
  );
  const http = await import("node:http");
  const occupied = http.createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  try {
    config.port = occupied.address().port;
    const { startRemoteServer } =
      await import("../../scripts/mcp/remote-http.mjs");
    await assert.rejects(startRemoteServer(config), { code: "EADDRINUSE" });
    assert.equal(
      fs.existsSync(path.join(config.stateDirectory, "server.lock")),
      false,
    );
    assert.ok(occupied.listening);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test(
  "concurrent restart contenders elect one owner and recover after its forced exit",
  { timeout: 20000 },
  async (t) => {
    const root = directory(t);
    writeLock(root, deadPid());
    const module = pathToFileURL(
      path.join(repo, "scripts/mcp/remote-lock.mjs"),
    ).href;
    const source = `import { acquireRemoteLock } from ${JSON.stringify(module)};
    setInterval(() => {}, 1000); // Keep each contender alive until the parent stops it.
    process.send({status:'ready'});
    process.once('message', () => {
      try { acquireRemoteLock(process.argv[1]); process.send({status:'owner'}); }
      catch(e) { process.send({status:'blocked',code:e.code}); }
    });`;
    const children = Array.from({ length: 8 }, () =>
      spawn(process.execPath, ["--input-type=module", "-e", source, root], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      }),
    );
    try {
      await Promise.all(children.map((child) => once(child, "message")));
      const results = await Promise.all(
        children.map((child) => {
          const result = once(child, "message");
          child.send("start");
          return result;
        }),
      );
      const owners = results
        .map(([result]) => result)
        .filter((result) => result.status === "owner");
      assert.equal(owners.length, 1, JSON.stringify(results));
      const winning =
        children[results.findIndex(([result]) => result.status === "owner")];
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(root, "server.lock"))).pid,
        winning.pid,
      );
      assert.throws(() => acquireRemoteLock(root), {
        code: "SERVER_ALREADY_RUNNING",
      });
      const exited = once(winning, "exit");
      winning.kill("SIGKILL");
      await exited;
      const recovery = acquireRemoteLock(root);
      assert.deepEqual(recovery.recovered, { pid: winning.pid });
      recovery.close();
      assert.deepEqual(fs.readdirSync(root), []);
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }),
      );
    }
  },
);
