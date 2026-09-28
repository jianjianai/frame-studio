import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { projectPath, inside } from "./project-paths.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function fileSha256(file) {
  const handle = fs.openSync(file, "r"),
    digest = createHash("sha256"),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!count) break;
      digest.update(buffer.subarray(0, count));
    }
    return digest.digest("hex");
  } finally {
    fs.closeSync(handle);
  }
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
export function inputFiles(root, id) {
  projectPath(root, id);
  const files = [];
  function walk(relative) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
      throw new Error("Input links are not allowed: " + relative);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort())
        if (!excluded.has(name)) walk(relative + "/" + name);
    } else if (stat.isFile()) files.push(relative);
    else throw new Error("Unsupported input: " + relative);
  }
  for (const name of [
    "src/engine",
    "public",
    "scripts",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "projects/" + id,
  ])
    walk(name);
  return files.sort();
}
export function inputManifest(root, id) {
  const files = inputFiles(root, id).map((file) => ({
    path: file,
    sha256: fileSha256(path.join(root, file)),
  }));
  return {
    schemaVersion: 1,
    project: id,
    fingerprint: hash(JSON.stringify(files)),
    files,
  };
}
/** Copy bytes, not links. Reject changes while capturing to avoid a mixed input. */
export function captureInput(root, id, { workspace = false } = {}) {
  const before = inputManifest(root, id);
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
  const close = () => {
    const base = projectPath(root, id, ownedBase);
    if (!inside(base, directory) || directory === base)
      throw new Error("Invalid owned snapshot");
    const dependencies = path.join(directory, "node_modules");
    if (fs.existsSync(dependencies)) fs.unlinkSync(dependencies);
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  };
  try {
    for (const file of before.files) {
      const target = path.join(directory, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file.path), target);
      if (fileSha256(target) !== file.sha256)
        throw new Error("Input changed during capture: " + file.path);
    }
    if (inputManifest(root, id).fingerprint !== before.fingerprint)
      throw new Error("Input changed during capture; retry");
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
