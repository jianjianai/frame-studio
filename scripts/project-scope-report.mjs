import { execFileSync } from "node:child_process";
import { validProjectId } from "./project-metadata.mjs";

/** A workspace diff cannot identify its author. Never infer ownership from a path. */
export function inspectProjectScope(root, id, { base, limit = 40 } = {}) {
  if (!validProjectId(id)) throw new Error("Invalid project id");
  if (base && !/^[a-fA-F0-9]{7,40}$/.test(base))
    throw new Error("Use a commit SHA for base");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Path limit must be 1..200");
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split("\0")
      .filter(Boolean);
  const files = [
    ...new Set([
      ...git([
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        base || "HEAD",
        "--",
      ]),
      ...git([
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
        "-z",
        "HEAD",
        "--",
      ]),
      ...git(["diff", "--name-only", "--no-renames", "-z", "--"]),
      ...git(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]),
  ].sort();
  const local = [],
    shared = [],
    other = new Map();
  for (const file of files) {
    if (file.startsWith(`projects/${id}/`)) local.push(file);
    else {
      const match = /^projects\/([^/]+)\//.exec(file);
      if (match && validProjectId(match[1])) {
        if (!other.has(match[1])) other.set(match[1], []);
        other.get(match[1]).push(file);
      } else shared.push(file);
    }
  }
  const bounded = (paths) => ({
    count: paths.length,
    paths: paths.slice(0, limit),
    truncated: paths.length > limit,
  });
  const outsideCount = files.length - local.length;
  return {
    schemaVersion: 1,
    project: id,
    mode: "strict",
    passed: outsideCount === 0,
    exitCode: outsideCount ? 1 : 0,
    status: outsideCount ? "outside_changes" : "passed",
    attribution: "unknown",
    projectChanges: bounded(local),
    outsideCount,
    externalWorkspaceChanges: {
      projects: [...other]
        .slice(0, limit)
        .map(([project, paths]) => ({ project, ...bounded(paths) })),
      projectCount: other.size,
      truncated: other.size > limit,
      shared: bounded(shared),
    },
    nextAction: outsideCount
      ? "Review external changes against your task baseline or use an isolated checkout. Other-project paths alone do not identify the author. Structural checks and previews may continue; scope is not verified."
      : "All currently observed changes are inside the project boundary.",
  };
}
