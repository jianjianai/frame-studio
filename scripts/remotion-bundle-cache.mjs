import fs from "node:fs/promises";
import { constants, openSync, fstatSync, closeSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { projectPath } from "./project-paths.mjs";

// Only derived, frozen bundles live here. Readers hold a lease until their renderer closes.
const signature = (stat) =>
  [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.mode,
    stat.nlink,
  ].join(":");
const digests = new Map();
const leaseLifetime = 120000;
const namespace = await fs.stat("/proc/self/ns/pid").then(
  (s) => String(s.ino),
  () => process.platform,
);

async function safeDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Invalid Remotion cache directory");
}
async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value), { flag: "wx" });
}
async function owner(directory, token) {
  const file = path.join(directory, token + ".json");
  const data = { pid: process.pid, namespace, token };
  await writeJson(file, data);
  const timer = setInterval(() => {
    void fs.utimes(file, new Date(), new Date()).catch(() => {});
  }, 30000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await fs.rm(file, { force: true });
  };
}
async function live(file) {
  try {
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 4096
    )
      throw Error("Invalid Remotion cache lease");
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    if (
      !Number.isSafeInteger(data.pid) ||
      data.pid <= 0 ||
      typeof data.namespace !== "string"
    )
      throw Error("Invalid Remotion cache lease owner");
    if (data.namespace === namespace) {
      try {
        process.kill(data.pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        return true;
      }
    }
    return Date.now() - stat.mtimeMs < leaseLifetime;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function lockFiles(file) {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const stat = await fs
      .lstat(file + suffix)
      .catch((error) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
      );
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
      throw Error("Invalid Remotion cache lock file");
  }
}
async function lock(base, signal) {
  // A stale directory cannot be removed with a filesystem compare-and-swap:
  // another contender can publish its new lock between the check and unlink.
  // SQLite's OS-managed transaction lock survives awaits and releases on process
  // death, without deleting/replacing the shared lock inode or reaping owners.
  const file = path.join(base, ".control.sqlite"),
    began = Date.now();
  // Do not open/close an existing lock outside SQLite: closing another file
  // descriptor can release this process's POSIX record locks. Synchronous
  // exclusive creation has no await where another local connection can lock it.
  let handle;
  try {
    handle = openSync(
      file,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1)
      throw Error("Invalid Remotion cache lock file");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  for (;;) {
    signal?.throwIfAborted();
    await lockFiles(file);
    let database;
    try {
      database = new DatabaseSync(file);
      // Never block the API/event loop waiting for another renderer's transaction.
      database.exec(
        "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE",
      );
      await lockFiles(file);
      database.exec(
        "CREATE TABLE IF NOT EXISTS mutex (id INTEGER PRIMARY KEY)",
      );
      signal?.throwIfAborted();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          database.exec("COMMIT");
        } finally {
          database.close();
        }
      };
    } catch (error) {
      // Closing rolls back an interrupted initialization and always releases the OS lock.
      database?.close();
      if (error.code !== "ERR_SQLITE_ERROR" || ![5, 6].includes(error.errcode))
        throw error;
      if (Date.now() - began > 600000)
        throw Error("Timed out waiting for Remotion bundle cache");
      await delay(50, undefined, { signal });
    }
  }
}
async function files(directory, relative = "") {
  const found = [];
  for (const entry of await fs.readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const name = relative ? relative + "/" + entry.name : entry.name;
    const stat = await fs.lstat(path.join(directory, name), { bigint: true });
    if (stat.isSymbolicLink())
      throw Error("Remotion bundle links are not allowed");
    if (stat.isDirectory()) found.push(...(await files(directory, name)));
    else if (stat.isFile() && stat.nlink === 1n)
      found.push({ path: name, stat });
    else throw Error("Invalid Remotion bundle file");
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
async function digest(file, expected) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || signature(before) !== signature(expected))
      throw Error("Remotion bundle changed during verification");
    const key = signature(before);
    let sha256 = digests.get(key);
    if (!sha256) {
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        hash.update(chunk);
      sha256 = hash.digest("hex");
      if (digests.size >= 10000) digests.clear();
      digests.set(key, sha256);
    }
    if (signature(await handle.stat({ bigint: true })) !== signature(before))
      throw Error("Remotion bundle changed during verification");
    return sha256;
  } finally {
    await handle.close();
  }
}
async function manifest(directory) {
  const result = [];
  for (const entry of await files(directory))
    result.push({
      path: entry.path,
      bytes: Number(entry.stat.size),
      signature: signature(entry.stat),
      sha256: await digest(path.join(directory, entry.path), entry.stat),
    });
  return result;
}
async function valid(directory, key) {
  try {
    const entryStat = await fs.lstat(directory);
    if (!entryStat.isDirectory() || entryStat.isSymbolicLink())
      throw Error("Invalid Remotion bundle cache entry");
    const metadataFile = path.join(directory, "bundle.json");
    const stat = await fs.lstat(metadataFile);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 8 * 1024 * 1024
    )
      return null;
    const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
    if (
      metadata.schemaVersion !== 1 ||
      metadata.key !== key ||
      !Number.isSafeInteger(metadata.bytes) ||
      metadata.bytes < 0
    )
      return null;
    if (!Array.isArray(metadata.files) || metadata.files.length > 40000)
      return null;
    const actual = await files(path.join(directory, "bundle"));
    if (actual.length !== metadata.files.length) return null;
    for (let index = 0; index < actual.length; index++) {
      const entry = actual[index],
        expected = metadata.files[index];
      if (
        !expected ||
        entry.path !== expected.path ||
        Number(entry.stat.size) !== expected.bytes ||
        !/^[a-f0-9]{64}$/.test(expected.sha256)
      )
        return null;
      // ctime + inode cannot be preserved when the bytes change. Persisted identities allow
      // a new process to reuse untouched large media without re-reading all their bytes.
      if (
        signature(entry.stat) !== expected.signature &&
        (await digest(
          path.join(directory, "bundle", entry.path),
          entry.stat,
        )) !== expected.sha256
      )
        return null;
    }
    return metadata;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}
async function leased(base, key) {
  const directory = path.join(base, ".leases", key);
  const directoryStat = await fs
    .lstat(directory)
    .catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));
  if (
    directoryStat &&
    (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
  )
    throw Error("Invalid Remotion cache lease directory");
  const names = directoryStat ? await fs.readdir(directory) : [];
  let active = false;
  for (const name of names) {
    const file = path.join(directory, name);
    if (await live(file)) active = true;
    else await fs.rm(file, { force: true });
  }
  return active;
}
async function prune(base, maxEntries, maxBytes) {
  const candidates = [];
  for (const name of await fs.readdir(base)) {
    if (name.startsWith(".building-")) {
      const abandoned = path.join(base, name),
        stat = await fs.lstat(abandoned);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw Error("Invalid Remotion staging directory");
      if (Date.now() - stat.mtimeMs > leaseLifetime)
        await fs.rm(abandoned, { recursive: true, force: true });
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const directory = path.join(base, name),
      stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Invalid Remotion bundle cache entry");
    const active = await leased(base, name);
    let metadata;
    try {
      const file = path.join(directory, "bundle.json"),
        metadataStat = await fs.lstat(file);
      if (
        !metadataStat.isFile() ||
        metadataStat.isSymbolicLink() ||
        metadataStat.nlink !== 1 ||
        metadataStat.size > 8 * 1024 * 1024
      )
        throw Error("Invalid cache metadata");
      metadata = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        metadata.schemaVersion !== 1 ||
        metadata.key !== name ||
        !Number.isSafeInteger(metadata.bytes) ||
        metadata.bytes < 0
      )
        throw Error("Invalid cache size");
    } catch (error) {
      if (active) continue;
      await fs.rm(directory, { recursive: true, force: true });
      continue;
    }
    candidates.push({
      name,
      directory,
      modified: stat.mtimeMs,
      bytes: metadata.bytes,
      active,
    });
  }
  candidates.sort((a, b) => b.modified - a.modified);
  let entries = candidates.length,
    bytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of [...candidates].reverse()) {
    if (entries <= maxEntries && bytes <= maxBytes) break;
    if (entry.active) continue;
    await fs.rm(entry.directory, { recursive: true, force: true });
    entries--;
    bytes -= entry.bytes;
  }
}

/** Atomic publishing and reader leases prevent partially built or evicted native inputs. */
export async function acquireRemotionBundle({
  root,
  id,
  key,
  build,
  signal,
  maxEntries = 3,
  maxBytes = 2 * 1024 * 1024 * 1024,
}) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error("Invalid Remotion bundle key");
  const base = projectPath(root, id, ".cache/remotion-bundles");
  await safeDirectory(path.dirname(base));
  await safeDirectory(base);
  await safeDirectory(path.join(base, ".leases"));
  const release = await lock(base, signal);
  let staging, releaseLease;
  try {
    const directory = path.join(base, key);
    let metadata = await valid(directory, key),
      reused = Boolean(metadata);
    if (!metadata) {
      if (await leased(base, key))
        throw Error("Active Remotion bundle cache entry changed");
      await fs.rm(directory, { recursive: true, force: true });
      staging = path.join(base, ".building-" + key + "-" + randomUUID());
      await safeDirectory(staging);
      await build(path.join(staging, "bundle"));
      signal?.throwIfAborted();
      const listed = await manifest(path.join(staging, "bundle"));
      metadata = {
        schemaVersion: 1,
        key,
        files: listed,
        bytes: listed.reduce((sum, f) => sum + f.bytes, 0),
      };
      await writeJson(path.join(staging, "bundle.json"), metadata);
      await fs.rename(staging, directory);
      staging = undefined;
    }
    const leaseDirectory = path.join(base, ".leases", key);
    await safeDirectory(leaseDirectory);
    releaseLease = await owner(leaseDirectory, randomUUID());
    await fs.utimes(directory, new Date(), new Date());
    await prune(base, maxEntries, maxBytes);
    let closing;
    return {
      directory: path.join(directory, "bundle"),
      reused,
      key,
      close() {
        closing ??= (async () => {
          await releaseLease();
          const unlock = await lock(base);
          try {
            await prune(base, maxEntries, maxBytes);
          } finally {
            await unlock();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    await releaseLease?.();
    if (staging) await fs.rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await release();
  }
}
