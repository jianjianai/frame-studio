import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectPath } from "./project-paths.mjs";

/** Console handoff stays compact; full evidence is retained as a project-owned JSON report. */
export function commandReport(root, id, command, result, { detail = false } = {}) {
  if (!Array.isArray(result.input?.files) || detail) return result;
  const file = result.report ?? projectPath(root, id, "exports/reports/" + command + "-" + randomUUID() + ".json");
  if (!result.report) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, command, ...result }, null, 2) + "\n");
  }
  const { files, ...input } = result.input;
  return { ...result, input: { ...input, fileCount: files.length }, report: file,
    reportDetail: "Full input hashes are in report; use --detail to include them in stdout." };
}
