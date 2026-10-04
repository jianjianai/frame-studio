import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runtimeIdentity } from "./runtime-identity.mjs";
import { sharedRuntimeNames } from "./shared-runtime.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const publishedNames = [...sharedRuntimeNames, "server"];
const markerName = "FRAME-RUNTIME.json";

/** Publish one immutable film toolchain for a separately versioned AI service. */
export async function publishRuntime({ source = sourceRoot, destination, identity = runtimeIdentity, names = publishedNames } = {}) {
  if (!destination || !path.isAbsolute(destination)) throw Error("Runtime publication needs an absolute destination");
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (destination === source || destination.startsWith(source + path.sep))
    throw Error("Published runtime must live outside its source tree");
  for (const name of names) {
    if (path.basename(name) !== name || name === "." || name === "..") throw Error("Invalid public runtime entry");
  }
  const runtime = await identity(source, { refresh: true });
  if (!/^[a-f0-9]{64}$/.test(runtime.fingerprint || "")) throw Error("Invalid film runtime fingerprint");
  await fs.mkdir(destination, { recursive: true });
  const target = path.join(destination, runtime.fingerprint);
  const stage = path.join(destination, ".publish-" + randomUUID());
  const temporaryLink = path.join(destination, ".current-" + randomUUID());
  const current = path.join(destination, "current");
  let created = false;
  try {
    let existing;
    try { existing = await fs.lstat(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw Error("Published runtime is not a managed directory");
      const marker = JSON.parse(await fs.readFile(path.join(target, markerName), "utf8"));
      if (marker.schemaVersion !== 1 || marker.fingerprint !== runtime.fingerprint)
        throw Error("Published runtime identity differs from its directory");
      const installed = await identity(target, { refresh: true });
      if (installed.fingerprint !== runtime.fingerprint) throw Error("Published runtime source was changed");
      for (const name of names) await fs.access(path.join(target, name));
    } else {
      await fs.mkdir(stage);
      for (const name of names) {
        await fs.cp(path.join(source, name), path.join(stage, name), {
          recursive: true, dereference: false, force: false, errorOnExist: true, preserveTimestamps: true,
        });
      }
      await fs.writeFile(path.join(stage, markerName), JSON.stringify({
        schemaVersion: 1, ...runtime, names,
      }) + "\n", { flag: "wx", mode: 0o444 });
      const copied = await identity(stage, { refresh: true });
      if (copied.fingerprint !== runtime.fingerprint) throw Error("Film runtime changed during publication");
      // Preserve executability; shared dependencies and source are read-only for agents.
      const seal = async directory => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await seal(file);
          else {
            const stat = await fs.stat(file);
            await fs.chmod(file, stat.mode & 0o111 ? 0o555 : 0o444);
          }
        }
        await fs.chmod(directory, 0o555);
      };
      await seal(stage);
      await fs.rename(stage, target);
      created = true;
    }
    let installedLink;
    try { installedLink = await fs.lstat(current); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (installedLink && !installedLink.isSymbolicLink()) throw Error("Runtime current pointer is not a managed symlink");
    if (installedLink) {
      const previous = await fs.readlink(current);
      if (!/^[a-f0-9]{64}$/.test(previous)) throw Error("Runtime current pointer has an unknown target");
    }
    await fs.symlink(runtime.fingerprint, temporaryLink);
    await fs.rename(temporaryLink, current);
    return { root: target, current, created, runtime };
  } finally {
    await fs.rm(temporaryLink, { force: true });
    // A failed copy may already have sealed part of its tree. Only this call's stage is writable again.
    const unseal = async directory => {
      let entries;
      try { await fs.chmod(directory, 0o700); entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) await unseal(path.join(directory, entry.name));
    };
    await unseal(stage);
    await fs.rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error("Usage: node scripts/publish-runtime.mjs <absolute-runtime-directory>");
  console.log(JSON.stringify(await publishRuntime({ destination: process.argv[2] })));
}
