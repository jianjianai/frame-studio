import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { inside, projectPath } from "./project-paths.mjs";

const stamp = (stat) =>
  [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mode,
    stat.nlink,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
const failure = (file) =>
  new Error("Project asset changed during build: " + file);

async function sourceDirectories(asset) {
  if (!asset.base) return;
  if (!inside(asset.base, asset.file))
    throw new Error("Project asset escapes its source directory");
  let directory = path.dirname(asset.file);
  while (inside(asset.base, directory)) {
    const stat = await fsp.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Project assets cannot use symlink directories");
    if (directory === asset.base) break;
    directory = path.dirname(directory);
  }
}

/** The manifest holds paths and stable file identities, never media bytes. */
export async function scanProjectAssets(root, ids) {
  const files = [];
  for (const id of ids) {
    const base = projectPath(root, id, "public");
    const walk = async (directory, prefix) => {
      let stat;
      try {
        stat = await fsp.lstat(directory);
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Project assets cannot be symlinks or special files");
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (/[\\:%?#\u0000-\u001f]/.test(entry.name))
          throw new Error("Invalid project asset filename: " + entry.name);
        const file = path.join(directory, entry.name),
          name = prefix + "/" + entry.name;
        if (entry.isSymbolicLink())
          throw new Error("Project assets cannot be symlinks");
        if (entry.isDirectory()) await walk(file, name);
        else {
          const stat = await fsp.lstat(file, { bigint: true });
          if (!stat.isFile() || stat.nlink !== 1n)
            throw new Error(
              "Project assets must be regular files without hardlinks",
            );
          files.push({
            file,
            name,
            base,
            size: Number(stat.size),
            stamp: stamp(stat),
          });
        }
      }
    };
    await walk(base, "films/" + id);
  }
  return files;
}

async function outputPath(directory, name) {
  const base = path.resolve(directory),
    destination = path.resolve(base, name);
  if (!inside(base, destination) || destination === base)
    throw new Error("Project asset output escapes build directory");
  // Validate all existing ancestors, including outDir, before mkdir or writing.
  let ancestor = path.dirname(destination);
  while (true) {
    try {
      const stat = await fsp.lstat(ancestor);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Project asset output cannot use symlink directories");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (ancestor === path.dirname(ancestor)) break;
    ancestor = path.dirname(ancestor);
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    const stat = await fsp.lstat(destination);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("Project asset output must be a regular file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return destination;
}

/** An exclusive temp plus atomic rename prevents readers seeing partial media. */
export async function copyProjectAsset(asset, directory, { buffer } = {}) {
  await sourceDirectories(asset);
  const destination = await outputPath(directory, asset.name);
  const temporary = path.join(
    path.dirname(destination),
    ".frame-asset-" + randomUUID(),
  );
  const source = await fsp.open(
    asset.file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  let target;
  try {
    const before = await source.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      stamp(before) !== asset.stamp
    )
      throw failure(asset.file);
    target = await fsp.open(temporary, "wx", 0o644);
    // Reuse one buffer; a ReadStream allocates a new Buffer on each read and lets
    // media-sized garbage accumulate until the next collection.
    buffer ??= Buffer.allocUnsafe(Math.min(asset.size, 1024 * 1024));
    let position = 0;
    while (position < asset.size) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, asset.size - position),
        position,
      );
      if (!bytesRead) throw failure(asset.file);
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await target.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (!bytesWritten)
          throw new Error("Project asset output write made no progress");
        written += bytesWritten;
      }
      position += bytesRead;
    }
    await target.close();
    target = undefined;
    const after = await source.stat({ bigint: true });
    const current = await fsp.lstat(asset.file, { bigint: true });
    await sourceDirectories(asset);
    if (
      !current.isFile() ||
      current.nlink !== 1n ||
      after.nlink !== 1n ||
      stamp(after) !== asset.stamp ||
      stamp(current) !== asset.stamp
    )
      throw failure(asset.file);
    // Revalidate output directories and destination before the atomic publish.
    await outputPath(directory, asset.name);
    await fsp.rename(temporary, destination);
  } finally {
    await target?.close();
    await source.close();
    await fsp.rm(temporary, { force: true });
  }
  return destination;
}

export async function readProjectAsset(asset) {
  await sourceDirectories(asset);
  const source = await fsp.open(
    asset.file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const before = await source.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      stamp(before) !== asset.stamp
    )
      throw failure(asset.file);
    const bytes = await source.readFile();
    const current = await fsp.lstat(asset.file, { bigint: true });
    await sourceDirectories(asset);
    if (
      !current.isFile() ||
      current.nlink !== 1n ||
      stamp(await source.stat({ bigint: true })) !== asset.stamp ||
      stamp(current) !== asset.stamp
    )
      throw failure(asset.file);
    return bytes;
  } finally {
    await source.close();
  }
}

/** Parse one bank in a short-lived worker; each preset is flushed immediately. */
export async function writeSoundfontParts(file, directory, { buffer } = {}) {
  const temporary = directory + ".frame-" + randomUUID();
  await outputPath(
    path.dirname(directory),
    path.basename(directory) + ".marker",
  );
  await fsp.mkdir(temporary, { recursive: false });
  try {
    const manifest = await new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./soundfont-parts-worker.mjs", import.meta.url),
        {
          workerData: { file, directory: temporary },
        },
      );
      let result;
      worker.once("message", (message) => {
        result = message;
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code || result === undefined)
          reject(new Error("Soundfont worker exited before completing"));
        else resolve(result);
      });
    });
    if (!manifest) return null;
    buffer ??= Buffer.allocUnsafe(1024 * 1024);
    for (const part of new Map(
      manifest.parts.map((part) => [part.file, part]),
    ).values()) {
      const stat = await fsp.lstat(path.join(temporary, part.file), {
        bigint: true,
      });
      await copyProjectAsset(
        {
          file: path.join(temporary, part.file),
          name: part.file,
          base: temporary,
          size: Number(stat.size),
          stamp: stamp(stat),
        },
        directory,
        { buffer },
      );
    }
    const index = path.join(temporary, "index.json");
    const stat = await fsp.lstat(index, { bigint: true });
    await copyProjectAsset(
      {
        file: index,
        name: "index.json",
        base: temporary,
        size: Number(stat.size),
        stamp: stamp(stat),
      },
      directory,
      { buffer },
    );
    return manifest;
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}
