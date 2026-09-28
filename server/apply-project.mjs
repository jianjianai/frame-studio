import fs from "node:fs";
import path from "node:path";
import { copyTree, treeHash } from "./security.mjs";

// A durable journal makes application resumable across controller restarts.
export function applyProject({ source, destination, run, id, fingerprint }) {
  const journal = path.join(run, "apply.json");
  const stage = destination + ".frame-" + id;
  const backup = path.join(run, "original-project");
  if (!fs.existsSync(path.join(source, "project.ts")))
    throw new Error("Task did not produce project.ts");
  const output = treeHash(source);
  if (!fs.existsSync(journal)) {
    if (treeHash(destination) !== fingerprint)
      throw new Error(
        "Source changed. Task copy retained; resolve conflict before applying.",
      );
    if (fs.existsSync(stage) || fs.existsSync(backup))
      throw new Error(
        "Ambiguous prior application; task copy retained for recovery.",
      );
    copyTree(source, stage);
    fs.writeFileSync(journal, JSON.stringify({ output }), { flag: "wx" });
  } else if (JSON.parse(fs.readFileSync(journal, "utf8")).output !== output) {
    throw new Error(
      "Task output changed during application; all copies retained.",
    );
  }
  if (fs.existsSync(destination) && treeHash(destination) === output) return;
  if (!fs.existsSync(stage) || treeHash(stage) !== output)
    throw new Error("Application stage missing or changed; backup retained.");
  if (fs.existsSync(destination)) {
    if (treeHash(destination) !== fingerprint || fs.existsSync(backup))
      throw new Error("Source changed during application; backup retained.");
    fs.renameSync(destination, backup);
  } else if (fs.existsSync(backup) && treeHash(backup) !== fingerprint) {
    throw new Error("Original backup changed; application stopped.");
  }
  fs.renameSync(stage, destination);
}
