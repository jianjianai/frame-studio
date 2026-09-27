import { execFileSync } from "node:child_process";
import { validProjectId } from "./project-metadata.mjs";
const [id, ...rest] = process.argv.slice(2);
if (
  !validProjectId(id) ||
  (rest.length && (rest.length !== 2 || rest[0] !== "--base"))
)
  throw new Error("Usage: pnpm project:scope <id> [--base <commit>]");
const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", windowsHide: true })
    .split("\0")
    .filter(Boolean);
const files = new Set([
  ...git([
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    rest[1] || "HEAD",
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
]);
const outside = [...files].filter(
  (file) => !file.startsWith(`projects/${id}/`),
);
if (outside.length) {
  console.error("Changes outside projects/" + id + "/:\n" + outside.join("\n"));
  process.exitCode = 1;
} else console.log("All changes stay inside projects/" + id + "/");
