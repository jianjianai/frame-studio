import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireRemotionBundle } from "../../scripts/remotion-bundle-cache.mjs";
import { createTestLink } from "../links.mjs";

const key = (value) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = path.resolve(
    import.meta.dirname,
    "../../.cache/remotion-cache-tests",
    randomUUID(),
  );
  await fs.mkdir(path.join(root, "projects/test-film"), { recursive: true });
  return {
    root,
    base: path.join(root, "projects/test-film/.cache/remotion-bundles"),
    close: () => fs.rm(root, { recursive: true, force: true }),
  };
}
async function build(directory, value = "frozen bytes") {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "index.html"), value);
}

const childCompiler = `
  import fs from "node:fs/promises";
  import path from "node:path";
  const [root, key, hold, moduleUrl] = process.argv.slice(1);
  const { acquireRemotionBundle } = await import(moduleUrl);
  let lease;
  try {
    lease = await acquireRemotionBundle({
      root, id: "test-film", key, signal: AbortSignal.timeout(10000),
      async build(directory) {
        await fs.appendFile(path.join(root, "builds.log"), process.pid + "\\n");
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, "index.html"), "frozen bytes");
        process.send({ type: "started" });
        if (hold === "true") await new Promise(resolve => process.once("message", resolve));
      }
    });
    await lease.close();
    process.send({ type: "result", reused: lease.reused });
  } catch (error) {
    process.send({ type: "error", message: error.message });
    process.exitCode = 1;
  } finally {
    await lease?.close();
    process.disconnect();
  }
`;
function compiler(f, cacheKey, hold = false) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      childCompiler,
      f.root,
      cacheKey,
      String(hold),
      new URL("../../scripts/remotion-bundle-cache.mjs", import.meta.url).href,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let startedResolve,
    startedReject,
    resultResolve,
    reject,
    stderr = "",
    settled = false;
  const started = new Promise((resolve, fail) => {
    startedResolve = resolve;
    startedReject = fail;
  });
  const result = new Promise((resolve, fail) => {
    resultResolve = resolve;
    reject = fail;
  });
  // An intentionally killed compiler has no result; keep its rejection observed.
  started.catch(() => {});
  result.catch(() => {});
  const fail = (error) => {
    startedReject(error);
    reject(error);
  };
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("message", (message) => {
    if (message.type === "started") startedResolve();
    if (message.type === "result") {
      settled = true;
      resultResolve(message);
    }
    if (message.type === "error") fail(Error(message.message));
  });
  child.on("error", fail);
  const exited = once(child, "exit");
  exited.then(([code, signal]) => {
    if (!settled)
      fail(Error("Compiler stopped: " + (signal ?? code) + " " + stderr));
  }, fail);
  return {
    child,
    started,
    result,
    exited,
    finished: () => settled,
    async close() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    },
  };
}

test(
  "independent processes share one native compilation without stale-lock recovery races",
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      workers = [];
    try {
      // Old directory-lock debris must not participate in the OS-managed lock.
      await fs.mkdir(path.join(f.base, ".control"), { recursive: true });
      await fs.utimes(path.join(f.base, ".control"), new Date(0), new Date(0));
      const first = compiler(f, key("process-race"), true);
      workers.push(first);
      await first.started;
      const second = compiler(f, key("process-race"));
      workers.push(second);
      await delay(100);
      assert.equal(second.finished(), false);
      first.child.send({ type: "continue" });
      const results = await Promise.all(workers.map((worker) => worker.result));
      assert.deepEqual(
        results.map((result) => result.reused),
        [false, true],
      );
      for (const worker of workers)
        assert.deepEqual(await worker.exited, [0, null]);
      assert.equal(
        (await fs.readFile(path.join(f.root, "builds.log"), "utf8"))
          .trim()
          .split("\n").length,
        1,
      );
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
      await f.close();
    }
  },
);

test(
  "a killed compiler releases its lock and simultaneous processes recover with one complete bundle",
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      workers = [];
    try {
      const killed = compiler(f, key("process-crash"), true);
      workers.push(killed);
      await killed.started;
      const waiting = [
        compiler(f, key("process-crash")),
        compiler(f, key("process-crash")),
      ];
      workers.push(...waiting);
      await delay(100);
      assert.ok(waiting.every((worker) => !worker.finished()));
      killed.child.kill("SIGKILL");
      await killed.exited;
      const results = await Promise.all(waiting.map((worker) => worker.result));
      assert.deepEqual(results.map((result) => result.reused).sort(), [
        false,
        true,
      ]);
      for (const worker of waiting)
        assert.deepEqual(await worker.exited, [0, null]);
      assert.equal(
        (await fs.readFile(path.join(f.root, "builds.log"), "utf8"))
          .trim()
          .split("\n").length,
        2,
      );
      const lease = await acquireRemotionBundle({
        root: f.root,
        id: "test-film",
        key: key("process-crash"),
        build,
      });
      assert.equal(lease.reused, true);
      assert.equal(
        await fs.readFile(path.join(lease.directory, "index.html"), "utf8"),
        "frozen bytes",
      );
      await lease.close();
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
      await f.close();
    }
  },
);

test("cache lock database and SQLite sidecars reject links without touching outside bytes", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.base, { recursive: true });
    const outside = path.join(f.root, "outside.sqlite");
    await fs.writeFile(outside, "unchanged");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const file = path.join(f.base, ".control.sqlite" + suffix);
      for (const kind of ["symbolic", "hard"]) {
        if (kind === "symbolic") createTestLink(outside, file);
        else await fs.link(outside, file);
        await assert.rejects(
          acquireRemotionBundle({
            root: f.root,
            id: "test-film",
            key: key("lock-links"),
            build,
          }),
          /Invalid Remotion cache lock file/,
        );
        assert.equal(await fs.readFile(outside, "utf8"), "unchanged");
        await fs.unlink(file);
      }
    }
  } finally {
    await f.close();
  }
});

test("native bundle cache deduplicates concurrent compilation and pins leased inputs during eviction", async () => {
  const f = await fixture();
  let builds = 0;
  const leases = [];
  try {
    const options = {
      root: f.root,
      id: "test-film",
      key: key("first"),
      maxEntries: 1,
      async build(directory) {
        builds++;
        await delay(30);
        await build(directory);
      },
    };
    leases.push(
      ...(await Promise.all([
        acquireRemotionBundle(options),
        acquireRemotionBundle(options),
      ])),
    );
    assert.equal(builds, 1);
    assert.equal(leases[0].directory, leases[1].directory);
    assert.deepEqual(leases.map((lease) => lease.reused).sort(), [false, true]);
    const second = await acquireRemotionBundle({
      ...options,
      key: key("second"),
    });
    leases.push(second);
    await fs.access(leases[0].directory);
    await second.close();
    // Closing the newest entry must not evict the old entry that is still being rendered.
    await fs.access(leases[0].directory);
    await assert.rejects(fs.access(second.directory), { code: "ENOENT" });
    await leases[0].close();
    await leases[1].close();
    await fs.access(leases[0].directory);
  } finally {
    await Promise.all(leases.map((lease) => lease.close()));
    await f.close();
  }
});

test("changed same-size cached bytes, corrupt old metadata and failed builds cannot poison later renders", async () => {
  const f = await fixture();
  let builds = 0,
    lease;
  const options = {
    root: f.root,
    id: "test-film",
    key: key("bytes"),
    async build(directory) {
      builds++;
      await build(directory, "original");
    },
  };
  try {
    lease = await acquireRemotionBundle(options);
    const file = path.join(lease.directory, "index.html");
    await lease.close();
    const stat = await fs.stat(file);
    await fs.writeFile(file, "replaced");
    await fs.utimes(file, stat.atime, stat.mtime);
    lease = await acquireRemotionBundle(options);
    assert.equal(lease.reused, false);
    assert.equal(builds, 2);
    assert.equal(
      await fs.readFile(path.join(lease.directory, "index.html"), "utf8"),
      "original",
    );
    await lease.close();
    const broken = path.join(f.base, key("corrupt"));
    await fs.mkdir(broken);
    await fs.writeFile(path.join(broken, "bundle.json"), "{");
    lease = await acquireRemotionBundle(options);
    assert.equal(lease.reused, true);
    await assert.rejects(fs.access(broken), { code: "ENOENT" });
    await lease.close();
    await assert.rejects(
      acquireRemotionBundle({
        ...options,
        key: key("failed"),
        async build(directory) {
          await build(directory);
          throw Error("compiler failed");
        },
      }),
      /compiler failed/,
    );
    assert.deepEqual(
      (await fs.readdir(f.base)).filter((name) =>
        name.startsWith(".building-"),
      ),
      [],
    );
    lease = await acquireRemotionBundle({ ...options, key: key("failed") });
    assert.equal(lease.reused, false);
  } finally {
    await lease?.close();
    await f.close();
  }
});

test("linked cache bytes are rejected and an aborted cache waiter leaves the active compiler intact", async () => {
  const f = await fixture();
  let lease;
  try {
    const options = { root: f.root, id: "test-film", key: key("links"), build };
    lease = await acquireRemotionBundle(options);
    const file = path.join(lease.directory, "index.html"),
      outside = path.join(f.root, "outside.html");
    await fs.link(file, outside);
    await assert.rejects(
      acquireRemotionBundle(options),
      /Invalid Remotion bundle file/,
    );
    await fs.unlink(outside);
    await lease.close();
    await fs.unlink(file);
    createTestLink(outside, file);
    await assert.rejects(
      acquireRemotionBundle(options),
      /links are not allowed/,
    );
    await fs.unlink(file);
    let began, release;
    const started = new Promise((resolve) => (began = resolve));
    const wait = new Promise((resolve) => (release = resolve));
    const pending = acquireRemotionBundle({
      ...options,
      key: key("slow"),
      async build(directory) {
        began();
        await wait;
        await build(directory);
      },
    });
    await started;
    const controller = new AbortController();
    const waiter = acquireRemotionBundle({
      ...options,
      key: key("slow"),
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(waiter, { name: "AbortError" });
    release();
    lease = await pending;
    assert.equal(
      await fs.readFile(path.join(lease.directory, "index.html"), "utf8"),
      "frozen bytes",
    );
  } finally {
    await lease?.close();
    await f.close();
  }
});
