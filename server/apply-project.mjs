import fs from "node:fs/promises";
import path from "node:path";
import { copyTree, treeHash, exists } from "./project-files.mjs";

// Resumable journal and complete conflict checks, without blocking HTTP or WebSocket I/O.
export async function applyProject({ source, destination, run, id, fingerprint }) {
  const journal = path.join(run, "apply.json"), stage = destination + ".frame-" + id;
  const backup = path.join(run, "original-project");
  if (!(await exists(path.join(source, "project.ts")))) throw new Error("Task did not produce project.ts");
  const output = await treeHash(source);
  if (!(await exists(journal))) {
    if (await treeHash(destination) !== fingerprint)
      throw new Error("Source changed. Task copy retained; resolve conflict before applying.");
    if (await exists(stage) || await exists(backup))
      throw new Error("Ambiguous prior application; task copy retained for recovery.");
    await copyTree(source, stage);
    if (await treeHash(stage) !== output || await treeHash(source) !== output)
      throw new Error("Task output changed during staging; all copies retained.");
    const handle = await fs.open(journal, "wx");
    try { await handle.writeFile(JSON.stringify({ output })); await handle.sync(); }
    finally { await handle.close(); }
  } else if (JSON.parse(await fs.readFile(journal, "utf8")).output !== output) {
    throw new Error("Task output changed during application; all copies retained.");
  }
  if (await exists(destination) && await treeHash(destination) === output) return;
  if (!(await exists(stage)) || await treeHash(stage) !== output)
    throw new Error("Application stage missing or changed; backup retained.");
  if (await exists(destination)) {
    if (await treeHash(destination) !== fingerprint || await exists(backup))
      throw new Error("Source changed during application; backup retained.");
    await fs.rename(destination, backup);
  } else if (await exists(backup) && await treeHash(backup) !== fingerprint) {
    throw new Error("Original backup changed; application stopped.");
  }
  await fs.rename(stage, destination);
}
