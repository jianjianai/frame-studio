import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { hash, problem, relativeParts } from "./security.mjs";

export async function exists(file) {
  try { await fsp.lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function regular(stat) {
  if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1) || (!stat.isFile() && !stat.isDirectory()))
    throw problem(400, "Links and special files are not allowed");
  return stat;
}
export async function confinedAsync(base, relative) {
  let current = path.resolve(base);
  for (const part of relativeParts(relative)) {
    current = path.join(current, part);
    try { regular(await fsp.lstat(current)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return current;
}
/** Bounded buffers and async reads: large media must not block the API event loop. */
export async function fileSha256(file) {
  const before = regular(await fsp.lstat(file));
  if (!before.isFile()) throw problem(400, "Expected a regular file");
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = regular(await handle.stat());
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw problem(409, "File changed while opening");
    const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const current = regular(await fsp.lstat(file));
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        current.dev !== opened.dev || current.ino !== opened.ino || current.size !== after.size ||
        current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs)
      throw problem(409, "File changed while hashing");
    return digest.digest("hex");
  } finally { await handle.close(); }
}
const ignored = new Set([".git", "node_modules", ".cache", ".history", "exports"]);
/** Same canonical fingerprint as the legacy synchronous helper. */
export async function treeHash(root) {
  const files = [];
  const walk = async (dir, relative = "") => {
    if (!(await exists(dir))) return;
    regular(await fsp.lstat(dir));
    const names = (await fsp.readdir(dir)).filter(name => !ignored.has(name)).sort();
    for (const name of names) {
      const rel = relative ? relative + "/" + name : name;
      const file = await confinedAsync(root, rel), stat = regular(await fsp.lstat(file));
      if (stat.isDirectory()) await walk(file, rel);
      else files.push([rel, await fileSha256(file)]);
    }
    const after = (await fsp.readdir(dir)).filter(name => !ignored.has(name)).sort();
    if (JSON.stringify(after) !== JSON.stringify(names)) throw problem(409, "Project changed while hashing");
  };
  await walk(root);
  return hash(JSON.stringify(files));
}
export async function copyTree(source, target) {
  await fsp.cp(source, target, {
    recursive: true,
    filter: async file => {
      const name = path.basename(file);
      if (ignored.has(name) || name === ".env" || name.startsWith(".env.")) return false;
      regular(await fsp.lstat(file));
      return true;
    },
  });
}
