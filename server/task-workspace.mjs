import fs from "node:fs/promises";
import path from "node:path";
import { confined, problem } from "./security.mjs";
import { copyTree, treeHash, exists } from "./project-files.mjs";

const hashSource = dir => treeHash(dir, { includeExecutableMode: true });
const diagnostics = new Set(["task.json", "result.json", "progress.json", "exit.json", "workspace.json"]);

export function taskDirectory(data, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw Error("Invalid task workspace identity");
  return confined(path.join(data, "runs"), id);
}

/** Admission owns the work lock only while taking a consistent saved-source snapshot. */
export async function freezeRenderWorkspace({ data, repos, task, runtime }) {
  const run = taskDirectory(data, task.id);
  await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(run, "workspace.json"), JSON.stringify({ id: task.id, project: task.project, kind: task.kind }));
  try {
    const { dir } = await repos.project(task.repo, task.project);
    const sourceRevision = await hashSource(dir);
    const sourceCommit = await repos.checkpoint(task.repo, task.project, "导出冻结版本");
    if (await hashSource(dir) !== sourceRevision)
      throw problem(409, "作品在保存导出版本时发生变化，请重新提交导出。");
    const destination = path.join(run, "projects", task.project);
    await copyTree(dir, destination);
    if (await hashSource(destination) !== sourceRevision || await hashSource(dir) !== sourceRevision)
      throw problem(409, "作品在准备导出快照时发生变化，请重新提交导出。");
    const frozen = { version: 1, acceptedAt: new Date().toISOString(), sourceRevision, sourceCommit,
      runtimeFingerprint: runtime.fingerprint, image: runtime.image, input: structuredClone(task.input) };
    await fs.writeFile(path.join(run, "task.json"), JSON.stringify({ id: task.id, project: task.project,
      kind: task.kind, input: task.input, runtime, sourceCommit, frozen }));
    return { frozen, fingerprint: sourceRevision, sourceCommit, runtime };
  } catch (error) {
    await fs.rm(run, { recursive: true, force: true });
    throw error;
  }
}

export async function assertFrozenWorkspace(data, task) {
  if (!task.frozen || task.frozen.version !== 1 || task.frozen.sourceRevision !== task.fingerprint ||
      task.frozen.runtimeFingerprint !== task.runtime?.fingerprint || task.frozen.image !== task.runtime?.image ||
      JSON.stringify(task.frozen.input) !== JSON.stringify(task.input))
    throw Error("导出任务缺少有效的已冻结版本，不能改用当前作品重新导出。");
  const source = path.join(taskDirectory(data, task.id), "projects", task.project);
  if (!(await exists(source)) || await hashSource(source) !== task.frozen.sourceRevision)
    throw Error("导出冻结副本不存在或已变化，请基于明确的作品版本提交新导出。");
}

/** Keep only downloadable output and bounded diagnostics, never an editable source tree. */
export async function cleanTaskWorkspace(data, task, { retainExports = task.state === "succeeded" || ["publishing", "publish_failed"].includes(task.state) } = {}) {
  const run = taskDirectory(data, task.id);
  if (!(await exists(run))) return;
  const keep = new Set(diagnostics);
  const exportDir = task.project ? path.join(run, "projects", task.project, "exports") : null;
  const hasExports = retainExports && exportDir && await exists(exportDir);
  if (hasExports) keep.add("projects");
  for (const entry of await fs.readdir(run, { withFileTypes: true })) {
    if (!keep.has(entry.name) || entry.isSymbolicLink())
      await fs.rm(path.join(run, entry.name), { recursive: true, force: true });
  }
  if (!hasExports) return;
  const projects = path.join(run, "projects");
  if (!(await exists(projects))) return;
  for (const entry of await fs.readdir(projects, { withFileTypes: true })) {
    const dir = path.join(projects, entry.name);
    if (entry.name !== task.project || !entry.isDirectory()) {
      await fs.rm(dir, { recursive: true, force: true });
      continue;
    }
    for (const item of await fs.readdir(dir, { withFileTypes: true }))
      if (item.name !== "exports" || !item.isDirectory())
        await fs.rm(path.join(dir, item.name), { recursive: true, force: true });
    // Encoder partial files are never retained as successful downloadable output.
    const purge = async base => {
      for (const item of await fs.readdir(base, { withFileTypes: true })) {
        const file = path.join(base, item.name);
        if (item.isSymbolicLink() || item.name.startsWith(".") || /\.tmp(?:\.|$)/i.test(item.name))
          await fs.rm(file, { recursive: true, force: true });
        else if (item.isDirectory()) await purge(file);
      }
    };
    if (await exists(path.join(dir, "exports"))) await purge(path.join(dir, "exports"));
  }
}

/** Check complete container identity before any cleanup can touch its bind mount. */
export function assertTaskContainer(container, task, hostRun) {
  if (container.Name !== "/frame-task-" + task.id || container.Config?.Labels?.["frame.task"] !== task.id ||
      !container.Mounts?.some(mount => mount.Destination === "/workspace" &&
        path.resolve(mount.Source) === path.resolve(hostRun)))
    throw Error("Task container identity or workspace mount does not match; cleanup deferred");
  if (typeof container.State?.Running !== "boolean") throw Error("Docker returned an incomplete task state");
  return container.State;
}

/** A controller can die between snapshot creation and SQL insertion. Only journaled orphans expire. */
export async function cleanOrphanTaskWorkspaces({ data, db, now = Date.now(), graceMs = 10 * 60000 }) {
  const root = path.join(data, "runs");
  if (!(await exists(root))) return;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const run = taskDirectory(data, entry.name), marker = path.join(run, "workspace.json");
    if (!(await exists(marker)) || now - (await fs.lstat(marker)).mtimeMs < graceMs) continue;
    const journal = JSON.parse(await fs.readFile(marker, "utf8"));
    if (journal.id !== entry.name || journal.kind !== "render") continue;
    if (!await db.one("SELECT id FROM tasks WHERE id=$1", [entry.name])) await fs.rm(run, { recursive: true, force: true });
  }
}
