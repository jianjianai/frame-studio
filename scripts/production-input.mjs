import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { projectPath, inside } from "./project-paths.mjs";
import { sharedRuntime, linkSharedRuntime } from "./shared-runtime.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// SHA-256 remains authoritative. Metadata only decides whether a verified digest
// can be reused; ctime detects writes even when the author restores mtime.
const digests = new Map();
const MAX_DIGESTS = 65536;
const digestStats = { hashedBytes: 0, hashedFiles: 0, cacheHits: 0 };
export const inputDigestMetrics = () => ({ ...digestStats });
export function fileSignature(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}
function regularFile(stat, file) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
    throw new Error(
      "Input links and non-regular files are not allowed: " + file,
    );
}
export function fileSha256(file, { cache = true } = {}) {
  const before = fs.lstatSync(file, { bigint: true });
  regularFile(before, file);
  const signature = fileSignature(before);
  const cached = cache && digests.get(file);
  if (cached?.signature === signature) {
    digestStats.cacheHits++;
    digests.delete(file);
    digests.set(file, cached);
    return cached.sha256;
  }
  const handle = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    ),
    digest = createHash("sha256"),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  let sha256;
  try {
    const opened = fs.fstatSync(handle, { bigint: true });
    regularFile(opened, file);
    if (fileSignature(opened) !== signature)
      throw new Error("Input changed while opening: " + file);
    for (;;) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!count) break;
      digest.update(buffer.subarray(0, count));
      digestStats.hashedBytes += count;
    }
    const after = fs.fstatSync(handle, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    regularFile(current, file);
    if (
      fileSignature(after) !== signature ||
      fileSignature(current) !== signature
    )
      throw new Error("Input changed while hashing: " + file);
    sha256 = digest.digest("hex");
    digestStats.hashedFiles++;
  } finally {
    fs.closeSync(handle);
  }
  if (cache) {
    digests.delete(file);
    digests.set(file, { signature, sha256 });
    if (digests.size > MAX_DIGESTS) digests.delete(digests.keys().next().value);
  }
  return sha256;
}
const excluded = new Set([
  ".cache",
  ".history",
  "exports",
  "records",
  "node_modules",
  ".git",
  "test-results",
  "playwright-report",
]);
export function inputFiles(root, id, { runtime: descriptor } = {}) {
  projectPath(root, id);
  const runtime = sharedRuntime(root, descriptor);
  const files = [];
  function walk(relative) {
    const file = path.join(root, relative);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
      throw new Error("Input links are not allowed: " + relative);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort())
        if (!excluded.has(name)) walk(relative + "/" + name);
    } else if (stat.isFile()) files.push(relative);
    else throw new Error("Unsupported input: " + relative);
  }
  for (const name of [
    "src",
    "public",
    "scripts",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "vite.config.ts",
    "index.html",
    "pnpm-workspace.yaml",
    ".npmrc",
    "projects/" + id,
  ])
    if (!runtime?.names.has(name)) walk(name);
  return files.sort();
}
export function inputManifest(root, id, { runtime: descriptor } = {}) {
  const runtime = sharedRuntime(root, descriptor);
  const files = inputFiles(root, id, { runtime: descriptor }).map((file) => ({
    path: file,
    sha256: fileSha256(path.join(root, file)),
  }));
  return {
    schemaVersion: 1,
    project: id,
    fingerprint: hash(JSON.stringify(runtime ? { files, runtime: runtime.fingerprint } : files)),
    files,
    ...(runtime ? { runtimeFingerprint: runtime.fingerprint } : {}),
  };
}
function snapshotClose(root, id, directory, workspace) {
  const ownedBase = workspace ? ".history/workspaces" : ".cache/production";
  return () => {
    const base = projectPath(root, id, ownedBase);
    if (!inside(base, directory) || directory === base)
      throw new Error("Invalid owned snapshot");
    const dependencies = path.join(directory, "node_modules");
    try {
      fs.lstatSync(dependencies);
      fs.unlinkSync(dependencies);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  };
}
/** Copy independently owned bytes. Reject changes to avoid a mixed input. */
export function captureInput(root, id, { workspace = false, runtime: descriptor } = {}) {
  const before = inputManifest(root, id, { runtime: descriptor });
  const ownedBase = workspace ? ".history/workspaces" : ".cache/production";
  const directory = projectPath(root, id, ownedBase + "/" + randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, ".owner.json"),
    JSON.stringify({
      pid: process.pid,
      task: process.env.FRAME_TASK_ID ?? null,
    }),
  );
  const close = snapshotClose(root, id, directory, workspace);
  try {
    for (const file of before.files) {
      const target = path.join(directory, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Reflink when supported; fallback also owns independent bytes.
      fs.copyFileSync(
        path.join(root, file.path),
        target,
        fs.constants.COPYFILE_FICLONE,
      );
      if (fileSha256(target, { cache: false }) !== file.sha256)
        throw new Error("Input changed during capture: " + file.path);
    }
    if (inputManifest(root, id, { runtime: descriptor }).fingerprint !== before.fingerprint)
      throw new Error("Input changed during capture; retry");
    const runtime = sharedRuntime(root, descriptor);
    // Render sessions replace their tiny entry HTML, never the shared core HTML.
    if (runtime) linkSharedRuntime(directory, runtime.root, { mutableIndex: true, names: runtime.names });
    if (!fs.existsSync(path.join(directory, "node_modules")))
    fs.symlinkSync(
      fs.realpathSync(path.join(root, "node_modules")),
      path.join(directory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    fs.writeFileSync(
      path.join(directory, "input.json"),
      JSON.stringify(before),
    );
    return { root: directory, manifest: before, close };
  } catch (error) {
    close();
    throw error;
  }
}
/** Identical frozen-input contract, with heavy work off the API event loop. */
export async function captureInputAsync(root, id, options = {}) {
  const { runProjectIo } = await import("./project-io.mjs");
  const snapshot = await runProjectIo({
    root,
    operation: "captureInput",
    arguments: [id, options],
  });
  return {
    ...snapshot,
    close: snapshotClose(root, id, snapshot.root, options.workspace ?? false),
  };
}
