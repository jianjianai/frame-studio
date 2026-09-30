import fsp from "node:fs/promises";
import path from "node:path";
import { confinedAsync } from "./project-files.mjs";
import { problem, relativeParts } from "./security.mjs";

const CONCURRENCY = 16;
const MAX_INDEXES = 24;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const indexes = new Map();
const ignored = new Set(["exports", "node_modules"]);
const extension =
  /\.(?:tsx?|jsx?|mjs|json|md|txt|svg|css|glsl|wgsl|vert|frag|csv|srt|vtt)$/i;
const invalid = (status, code, message) =>
  Object.assign(problem(status, message), {
    code,
    recovery: "list-project-files",
  });
const signature = (stat) =>
  [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(":");
function regular(stat) {
  if (
    stat.isSymbolicLink() ||
    (stat.isFile() && stat.nlink !== 1n) ||
    (!stat.isFile() && !stat.isDirectory())
  )
    throw problem(400, "Links and special files are not allowed");
  return stat;
}
async function mapBounded(items, fn) {
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}
async function currentDirectories(index) {
  return (
    await mapBounded(index.directories, async ({ folder, version }) => {
      try {
        const stat = regular(await fsp.lstat(folder, { bigint: true }));
        return stat.isDirectory() && signature(stat) === version;
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
        throw error;
      }
    })
  ).every(Boolean);
}
async function scan(root, directory) {
  const start = directory ? await confinedAsync(root, directory) : root;
  const files = [],
    directories = [],
    queue = [{ folder: start, prefix: directory, depth: 0 }];
  // Ancestors of a narrowed scan are part of its stability/security boundary too.
  if (directory) {
    let ancestor = path.resolve(root);
    for (const part of relativeParts(directory)) {
      const stat = regular(await fsp.lstat(ancestor, { bigint: true }));
      if (!stat.isDirectory())
        throw invalid(
          404,
          "DIRECTORY_NOT_FOUND",
          "Project directory not found: " + directory,
        );
      directories.push({ folder: ancestor, version: signature(stat) });
      ancestor = path.join(ancestor, part);
    }
  }
  let visited = 0;
  while (queue.length) {
    // Directory batches and file metadata reads have fixed concurrency, independent of tree width.
    const batch = queue.splice(0, CONCURRENCY);
    for (const { folder, prefix, depth } of batch) {
      if (depth > 32)
        throw invalid(
          400,
          "TREE_TOO_DEEP",
          "Select a narrower directory (maximum depth: 32).",
        );
      let before, entries;
      try {
        before = regular(await fsp.lstat(folder, { bigint: true }));
        if (!before.isDirectory())
          throw Object.assign(new Error(), { code: "ENOTDIR" });
        entries = (await fsp.readdir(folder, { withFileTypes: true })).filter(
          (e) => !e.name.startsWith(".") && !ignored.has(e.name),
        );
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(error.code))
          throw invalid(
            404,
            "DIRECTORY_NOT_FOUND",
            "Project directory not found: " + directory,
          );
        throw error;
      }
      visited += entries.length;
      if (visited > 20000)
        throw invalid(
          400,
          "TREE_TOO_LARGE",
          "Select a narrower directory (maximum: 10,000 files).",
        );
      const children = await mapBounded(entries, async (entry) => {
        const relative = prefix ? prefix + "/" + entry.name : entry.name;
        relativeParts(relative);
        // Each ancestor was checked once by traversal, rather than again for every descendant.
        const stat = regular(
          await fsp.lstat(path.join(folder, entry.name), { bigint: true }),
        );
        if (stat.isDirectory())
          return {
            folder: path.join(folder, entry.name),
            prefix: relative,
            depth: depth + 1,
          };
        files.push({
          path: relative,
          bytes: Number(stat.size),
          editable: extension.test(relative) && stat.size <= 1048576n,
        });
        return null;
      });
      if (files.length > 10000)
        throw invalid(
          400,
          "TREE_TOO_LARGE",
          "Select a narrower directory (maximum: 10,000 files).",
        );
      queue.push(...children.filter(Boolean));
      const after = regular(await fsp.lstat(folder, { bigint: true }));
      if (signature(before) !== signature(after))
        throw invalid(
          409,
          "TREE_CHANGED",
          "Project files changed while indexing; list the current files again.",
        );
      directories.push({ folder, version: signature(after) });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const estimatedBytes =
    files.reduce((n, file) => n + file.path.length * 2 + 160, 0) +
    directories.reduce(
      (n, dir) => n + dir.folder.length * 2 + dir.version.length * 2 + 160,
      0,
    );
  const index = { files, directories, estimatedBytes };
  if (!(await currentDirectories(index)))
    throw invalid(
      409,
      "TREE_CHANGED",
      "Project directories changed while indexing; list the current files again.",
    );
  return index;
}

/**
 * Paths are cached, contents never are. Directory inode and nanosecond mtime/ctime are checked
 * on every reuse, so external create/delete/rename is visible without TTLs or watcher races.
 * Returned file metadata is re-read, and source reads retain their independent hash/confinement.
 */
export async function sourceIndex(root, directory = "") {
  // A narrowed index also checks ancestors outside the indexed subtree on every reuse.
  if (directory) await confinedAsync(root, directory);
  const key = path.resolve(root) + "\0" + directory;
  let entry = indexes.get(key);
  if (entry?.pending) return entry.pending;
  if (!entry) {
    entry = {};
    indexes.set(key, entry);
  } else {
    indexes.delete(key);
    indexes.set(key, entry);
  }
  const pending = (async () => {
    if (entry.index && (await currentDirectories(entry.index)))
      return entry.index;
    return (entry.index = await scan(root, directory));
  })().finally(() => {
    delete entry.pending;
    if (!entry.index) indexes.delete(key);
    let bytes = [...indexes.values()].reduce(
      (n, value) => n + (value.index?.estimatedBytes || 0),
      0,
    );
    while (indexes.size > MAX_INDEXES || bytes > MAX_INDEX_BYTES) {
      const oldest = [...indexes].find(([, value]) => !value.pending);
      if (!oldest) break;
      indexes.delete(oldest[0]);
      bytes -= oldest[1].index?.estimatedBytes || 0;
    }
  });
  entry.pending = pending;
  return pending;
}

export async function sourcePage(root, directory, offset, limit) {
  const index = await sourceIndex(root, directory);
  const files = await mapBounded(
    index.files.slice(offset, offset + limit),
    async (file) => {
      const full = await confinedAsync(root, file.path);
      const stat = regular(await fsp.lstat(full, { bigint: true }));
      if (!stat.isFile())
        throw invalid(
          409,
          "TREE_CHANGED",
          "Project files changed while reading a page; list again.",
        );
      return {
        path: file.path,
        bytes: Number(stat.size),
        editable: extension.test(file.path) && stat.size <= 1048576n,
      };
    },
  );
  if (!(await currentDirectories(index)))
    throw invalid(
      409,
      "TREE_CHANGED",
      "Project directories changed while reading a page; list again.",
    );
  return {
    files,
    total: index.files.length,
    nextOffset: offset + limit < index.files.length ? offset + limit : null,
  };
}

export function sourceCandidate(file) {
  return extension.test(file.path);
}
export function invalidateSourceIndex(root) {
  const prefix = path.resolve(root) + "\0";
  for (const key of indexes.keys())
    if (key.startsWith(prefix)) indexes.delete(key);
}

export async function verifySourceIndex(index) {
  if (!(await currentDirectories(index)))
    throw invalid(
      409,
      "TREE_CHANGED",
      "Project directories changed while searching; retry the search against current files.",
    );
}
