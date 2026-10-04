import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const sharedRuntimeNames = Object.freeze(["src", "scripts", "templates", "docs", "public", "node_modules",
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "tsconfig.json", "index.html",
  "vite.config.ts", "vitest.config.ts", "AGENTS.md"]);

/** Only executor/daemon-controlled top-level links may refer to the pinned runtime. */
export function sharedRuntime(root, descriptor) {
  const runtimeRoot = descriptor ? descriptor.root : process.env.FRAME_SHARED_RUNTIME_ROOT,
    fingerprint = descriptor ? descriptor.fingerprint : process.env.FRAME_SHARED_RUNTIME_FINGERPRINT;
  if (!runtimeRoot && !fingerprint) return null;
  if (!path.isAbsolute(runtimeRoot || "") || !/^[a-f0-9]{64}$/.test(fingerprint || ""))
    throw Error("Shared runtime needs an absolute pinned core and verified fingerprint");
  const core = fs.realpathSync(runtimeRoot), names = new Set();
  for (const name of sharedRuntimeNames) {
    const target = path.join(root, name), expected = path.join(core, name);
    if (!fs.existsSync(expected) || !fs.existsSync(target)) continue;
    const installed = fs.lstatSync(target);
    if (!installed.isSymbolicLink()) continue; // Ordinary standalone CLI files remain frozen inputs.
    if (fs.realpathSync(target) !== fs.realpathSync(expected))
      throw Error("Shared runtime link points outside the pinned core: " + name);
    names.add(name);
  }
  return { root: core, fingerprint, names };
}

export function linkSharedRuntime(work, core, { mutableIndex = false, names = sharedRuntimeNames } = {}) {
  for (const name of names) {
    if (!sharedRuntimeNames.includes(name)) throw Error("Unsupported shared runtime path");
    const shared = path.join(core, name), target = path.join(work, name);
    if (!fs.existsSync(shared)) continue;
    if (mutableIndex && name === "index.html") {
      const installed = fs.lstatSync(target, { throwIfNoEntry: false });
      if (installed && !installed.isSymbolicLink()) {
        if (!installed.isFile() || installed.nlink !== 1) throw Error("Mutable HTML entry must be a private regular file");
        continue;
      }
      if (installed && fs.realpathSync(target) !== fs.realpathSync(shared))
        throw Error("Mutable HTML entry points outside the pinned core");
      // Vite resolves HTML links through their real path. Atomically replace only our
      // known runtime link with an independently editable, tiny entry in this checkout.
      const temporary = target + "." + randomUUID() + ".tmp";
      try { fs.copyFileSync(shared, temporary, fs.constants.COPYFILE_EXCL); fs.renameSync(temporary, target); }
      finally { fs.rmSync(temporary, { force: true }); }
      continue;
    }
    if (fs.existsSync(target)) {
      if (!fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== fs.realpathSync(shared))
        throw Error("Task runtime path already exists with different content: " + name);
      continue;
    }
    const directory = fs.statSync(shared).isDirectory();
    try { fs.symlinkSync(shared, target, directory && process.platform === "win32" ? "junction" : directory ? "dir" : "file"); }
    catch (error) {
      // Windows may disallow file symlinks. Small configuration files can be
      // independently copied; public/source/dependencies are never duplicated.
      if (process.platform !== "win32" || directory || !["EPERM", "EACCES"].includes(error.code)) throw error;
      fs.copyFileSync(shared, target);
    }
  }
}
