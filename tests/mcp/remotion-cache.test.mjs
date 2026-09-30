import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { acquireRemotionBundle } from "../../scripts/remotion-bundle-cache.mjs";

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
    await fs.symlink(outside, file);
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
