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
const digestCache = new Map();
const maxDigestCache = 32768;
const fileSignature = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
/** Content digests reuse unchanged inode metadata, with nanosecond race checks and a bounded LRU. */
export async function fileSha256(file, { cache = true } = {}) {
  const before = regular(await fsp.lstat(file, { bigint: true }));
  if (!before.isFile()) throw problem(400, "Expected a regular file");
  const signature = fileSignature(before);
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = regular(await handle.stat({ bigint: true }));
    if (fileSignature(opened) !== signature) throw problem(409, "File changed while opening");
    const cached = cache && digestCache.get(file);
    let value;
    if (cached?.signature === signature) value = cached.value;
    else {
      const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Number(before.size) || 1));
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        digest.update(buffer.subarray(0, bytesRead));
      }
      value = digest.digest("hex");
    }
    const after = await handle.stat({ bigint: true }), current = regular(await fsp.lstat(file, { bigint: true }));
    if (fileSignature(after) !== signature || fileSignature(current) !== signature)
      throw problem(409, "File changed while hashing");
    if (cache) {
      digestCache.delete(file); digestCache.set(file, { signature, value });
      if (digestCache.size > maxDigestCache) digestCache.delete(digestCache.keys().next().value);
    }
    return value;
  } finally { await handle.close(); }
}
const ignored = new Set([".git", "node_modules", ".cache", ".history", "exports"]);
/** Git saves share the source inventory boundary, even when imported works lack .gitignore. */
export function sourceGitExclusions(root) {
  return [...ignored].flatMap(name => [
    `:(exclude,glob)${root}/**/${name}`,
    `:(exclude,glob)${root}/**/${name}/**`,
  ]);
}
export function sourceGitUntrackedExclusions(root) {
  return [...ignored].map(name => `--exclude=${root}/**/${name}`);
}
/** Ask Git to prune generated untracked directories before enumeration; tracked history stays visible. */
export async function sourceGitStatus(git) {
  const [tracked, untracked] = await Promise.all([
    git(["status", "--porcelain=v2", "-z", "--untracked-files=no", "--renames"]),
    git(["ls-files", "--others", "--exclude-standard", ...sourceGitUntrackedExclusions("projects"), "-z"]),
  ]);
  return tracked + untracked.split("\0").filter(Boolean).map(file => "? " + file + "\0").join("");
}
/** Same canonical fingerprint as the legacy synchronous helper. */
export async function projectInventory(root, { includeExecutableMode = false, includeIgnored = false } = {}) {
  const files = [];
  const walk = async (dir, relative = "") => {
    if (!(await exists(dir))) return;
    regular(await fsp.lstat(dir));
    const names = (await fsp.readdir(dir)).filter(name => includeIgnored || !ignored.has(name)).sort();
    for (const name of names) {
      const rel = relative ? relative + "/" + name : name;
      const file = await confinedAsync(root, rel), stat = regular(await fsp.lstat(file, { bigint: true }));
      if (stat.isDirectory()) await walk(file, rel);
      else {
        const entry = [rel, await fileSha256(file)];
        if (fileSignature(regular(await fsp.lstat(file, { bigint: true }))) !== fileSignature(stat))
          throw problem(409, "Project file changed while hashing");
        // Content-only snapshots stay compatible; authoritative revisions additionally track Git executable mode.
        if (includeExecutableMode) entry.push(stat.mode & 0o100n ? "100755" : "100644");
        files.push(entry);
      }
    }
    const after = (await fsp.readdir(dir)).filter(name => includeIgnored || !ignored.has(name)).sort();
    if (JSON.stringify(after) !== JSON.stringify(names)) throw problem(409, "Project changed while hashing");
  };
  await walk(root);
  return files;
}
export async function treeHash(root, options) {
  return hash(JSON.stringify(await projectInventory(root, options)));
}
export async function copyTree(source, target, { includeIgnored = false } = {}) {
  await fsp.cp(source, target, {
    recursive: true,
    filter: async file => {
      const name = path.basename(file);
      if ((!includeIgnored && ignored.has(name)) || name === ".git" || name === "node_modules" || name === ".env" || name.startsWith(".env.")) return false;
      regular(await fsp.lstat(file));
      return true;
    },
  });
}
