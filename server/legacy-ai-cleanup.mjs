import fs from "node:fs/promises";
import path from "node:path";
import { command } from "./process.mjs";
import { assertTaskContainer } from "./task-workspace.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownedDirectory(data, folder, id, prefix = "") {
  if (!uuid.test(id)) throw Error("Invalid retired AI identity");
  const root = path.resolve(data, folder);
  const target = path.resolve(root, prefix + id);
  const rootStat = await fs.lstat(root).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (rootStat?.isSymbolicLink()) throw Error("Legacy AI cleanup root is a symbolic link");
  const stat = await fs.lstat(target).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (path.dirname(target) !== root || stat?.isSymbolicLink() || (stat && !stat.isDirectory()))
    throw Error("Retired AI directory ownership does not match");
  return { target, exists: !!stat };
}

/** Drain a migration-owned identity journal. Never scan or delete arbitrary data folders. */
export async function clearLegacyAiFiles({ db, data, hostData = process.env.FRAME_HOST_DATA || data,
  runCommand = command, localMode = process.env.FRAME_LOCAL_MODE === "1" }) {
  return db.lock("legacy-ai-cleanup", async () => {
    const records = await db.all("SELECT kind,id,container FROM legacy_ai_cleanup ORDER BY kind,id");
    const retiredSessions = new Set(records.filter(record => ["task", "chat"].includes(record.kind)).map(record => record.id));
    const containers = new Map();
    // Validate every identity and mount before deleting any shared legacy session.
    for (const record of records) {
      if (!uuid.test(record.id) || !["task", "chat", "undo"].includes(record.kind))
        throw Error("Invalid legacy AI cleanup journal");
    }
    for (const record of records) {
      if (record.kind === "task" && !localMode) {
        const name = "frame-task-" + record.id;
        if (record.container && record.container !== name)
          throw Error("Retired AI container name does not match its task");
        // A missing old SQL container field must not bypass an existing executor.
        const ids = await runCommand("docker", ["container", "ls", "--all", "--quiet", "--filter", "name=^/" + name + "$"]);
        if (ids.trim()) {
          const metadata = JSON.parse(await runCommand("docker", ["inspect", "--format", "{{json .}}", name]));
          const state = assertTaskContainer(metadata, { id: record.id }, path.join(hostData, "runs", record.id));
          if (state.Running || state.Restarting || state.Paused)
            throw Error("Retired AI container is still active; stop it before cleanup");
          for (const mount of metadata.Mounts) {
            if (typeof mount.RW !== "boolean") throw Error("Retired AI container mount access is unknown");
            if (!mount.RW) continue;
            const source = path.resolve(mount.Source), sessionRoot = path.resolve(hostData, "sessions");
            const workspace = mount.Destination === "/workspace" && source === path.resolve(hostData, "runs", record.id);
            const session = mount.Destination === "/sessions" && path.dirname(source) === sessionRoot && retiredSessions.has(path.basename(source));
            if (mount.Type !== "bind" || !workspace && !session)
              throw Error("Retired AI container has an unrelated writable mount; cleanup refused");
          }
          containers.set(record.id, name);
        }
      }
    }
    let removed = 0;
    for (const record of records) {
      if (containers.has(record.id)) await runCommand("docker", ["rm", containers.get(record.id)]);
      const folders = record.kind === "task" ? [
        await ownedDirectory(data, "runs", record.id),
        await ownedDirectory(data, "sessions", record.id),
      ] : record.kind === "chat" ? [await ownedDirectory(data, "sessions", record.id)]
        : [await ownedDirectory(data, "restores", record.id, "undo-")];
      for (const { target, exists } of folders) {
        if (!exists) continue;
        if (record.kind === "task" && path.basename(path.dirname(target)) === "runs") {
          const taskFile = path.join(target, "task.json");
          const metadata = await fs.readFile(taskFile, "utf8").then(JSON.parse).catch(error => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (metadata && (metadata.id !== record.id || metadata.kind !== "agent"))
            throw Error("Retired AI run metadata does not match its journal");
        }
        await fs.rm(target, { recursive: true, force: true });
        removed++;
      }
      await db.pool.query("DELETE FROM legacy_ai_cleanup WHERE kind=$1 AND id=$2", [record.kind, record.id]);
    }
    return { retiredIdentities: records.length, removedDirectories: removed };
  });
}
