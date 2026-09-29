import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { parseAgentDiff, publicAgentText } from "./agent-public-data.mjs";

const git = (cwd, args, limit = 256000) => new Promise((resolve, reject) => {
  const child = spawn("git", ["--no-optional-locks", "-c", "core.quotepath=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  let value = Buffer.alloc(0), truncated = false, stderr = "";
  child.stdout.on("data", (chunk) => { if (value.length + chunk.length > limit) truncated = true; value = Buffer.concat([value, chunk]).subarray(0, limit); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  child.once("error", reject);
  child.once("close", (code) => { clearTimeout(timer); code === 0 || (args.includes("--no-index") && code === 1) ? resolve({ text: value.toString("utf8"), truncated }) : reject(Error(publicAgentText(stderr || "Unable to inspect file changes"))); });
});
/** Include command-written files as well as native patch tools. No working tree
 * mutation, staging, checkout, textconv filter or follow-through symlink read.
 */
export function createAgentFileInspector({ cwd, project, baseline, emit }) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(project) || !/^[a-f0-9]{40,64}$/.test(baseline)) throw Error("Invalid inspection boundary");
  let last = "";
  return async () => {
    const scope = `projects/${project}`;
    const patch = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", baseline, "--", scope]);
    const list = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", scope], 64000);
    const files = parseAgentDiff(publicAgentText(patch.text, { limit: 256000 }));
    let remaining = Math.max(0, 256000 - patch.text.length), truncated = patch.truncated || list.truncated;
    for (const file of list.text.split("\0").filter(Boolean).slice(0, 100 - files.length)) {
      if (!file.startsWith(scope + "/") || path.isAbsolute(file) || file.split("/").includes("..")) continue;
      const stat = fs.lstatSync(path.join(cwd, file));
      if (stat.isSymbolicLink() || !stat.isFile()) { files.push({ path: file, kind: "add", binary: true, diff: "", note: "符号链接或非普通文件，不读取目标内容" }); continue; }
      if (stat.size > 256000 || remaining < 1000) { truncated = true; files.push({ path: file, kind: "add", diff: "", truncated: true, bytes: stat.size }); continue; }
      const value = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-index", "--unified=3", "--", "/dev/null", file], remaining);
      remaining -= value.text.length;
      const entries = parseAgentDiff(publicAgentText(value.text, { limit: Math.max(0, remaining + value.text.length) }));
      files.push(...entries.map((entry) => ({ ...entry, path: file, kind: "add", truncated: entry.truncated || value.truncated })));
      truncated ||= value.truncated;
    }
    const signature = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    if (signature === last) return;
    last = signature;
    emit({ type: "agent-item", version: 1, id: "workspace-changes", kind: "files", phase: "completed", at: Date.now(), title: "本轮文件变更", cumulative: true, source: "isolated-git", baseline, files, truncated });
  };
}
