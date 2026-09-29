import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { command } from "./process.mjs";
import { confined, problem } from "./security.mjs";

export async function versionTree(repos, work, version) {
  if (!/^[a-f0-9]{40}$/.test(version)) throw problem(400, "只能预览当前作品的 Git 历史版本");
  const { repo } = await repos.project(work.repo, work.project);
  const ancestor = await repos.git(repo.root, ["merge-base", "--is-ancestor", version, "HEAD"]).then(() => true, () => false);
  if (!ancestor) throw problem(400, "该版本不属于当前作品历史");
  const prefix = `projects/${work.project}/`;
  const output = await command("git", ["ls-tree", "-rz", "--full-tree", version, "--", prefix], { cwd: repo.root, max: 4 * 1024 * 1024 });
  const entries = output.split("\0").filter(Boolean).map(line => {
    const split = line.indexOf("\t");
    const [mode, type, oid] = line.slice(0, split).split(" ");
    const name = line.slice(split + 1);
    if (split < 0 || !["100644", "100755"].includes(mode) || type !== "blob" || !/^[a-f0-9]{40}$/.test(oid) || !name.startsWith(prefix))
      throw problem(400, "历史版本包含不允许的链接或文件类型");
    const relative = name.slice(prefix.length);
    confined(path.join(repo.root, "projects", work.project), relative);
    return { mode, oid, path: relative };
  }).filter(entry => !entry.path.split("/").some(part => ["exports", ".cache", ".history"].includes(part)));
  if (!entries.some(entry => entry.path === "project.ts")) throw problem(404, "历史版本缺少作品入口");
  if (entries.length > 20000) throw problem(413, "历史版本文件过多，无法在线预览");
  return { root: repo.root, entries };
}

// Copy immutable Git blobs, not a checkout. Never run hooks or change HEAD/index/work files.
async function copyBlob(root, oid, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const child = spawn("git", ["cat-file", "blob", oid], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let error = "";
  child.stderr.on("data", chunk => { error = (error + chunk).slice(-4000); });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(error || "读取历史文件失败")));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
  try {
    await Promise.all([pipeline(child.stdout, fs.createWriteStream(target, { flags: "wx" })), exited]);
  } catch (error) {
    child.kill(); await exited.catch(() => {}); throw error;
  } finally { clearTimeout(timer); }
}
export async function snapshotVersion(repos, work, version, destination) {
  const tree = await versionTree(repos, work, version);
  if (fs.existsSync(destination)) throw problem(409, "历史预览输出已存在");
  fs.mkdirSync(destination, { recursive: true });
  // Avoid unbounded memory/file descriptors when a work contains many assets.
  for (let i = 0; i < tree.entries.length; i += 4) {
    const results = await Promise.allSettled(tree.entries.slice(i, i + 4).map(entry => copyBlob(tree.root, entry.oid, confined(destination, entry.path))));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  return destination;
}
export async function compareVersion(repos, work, version) {
  const tree = await versionTree(repos, work, version);
  const head = await repos.git(tree.root, ["rev-parse", "HEAD"]);
  const output = await command("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", version, "--", `projects/${work.project}/`], { cwd: tree.root, max: 1024 * 1024 });
  const fields = output.split("\0"), changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i]) changes.push({ status: fields[i], path: fields[i + 1].replace(`projects/${work.project}/`, "") });
  const untracked = await command("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", `projects/${work.project}/`], { cwd: tree.root, max: 1024 * 1024 });
  for (const name of untracked.split("\0").filter(Boolean)) changes.push({ status: "A", path: name.replace(`projects/${work.project}/`, "") });
  return { version, current: head, changes: changes.slice(0, 500), total: changes.length, truncated: changes.length > 500, comparison: "selected-to-current", note: "列出所选版本到当前作品（含未提交修改）的文件变化。预览不会恢复或修改当前作品。" };
}
