import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export class GitError extends Error {
  constructor(args, code, stderr) {
    super(`git ${args[0]} failed: ${stderr.trim().split("\n").slice(-3).join(" ") || "exit " + code}`);
    this.code = "GIT_FAILED";
    this.exitCode = code;
    this.stderr = stderr;
  }
}

const identity = ["-c", "user.name=FRAME", "-c", "user.email=frame@localhost", "-c", "core.quotepath=false", "-c", "init.defaultBranch=main"];

/** Run git without a shell. `env` may carry credentials for one call; they are never written to config. */
export function git(cwd, args, { input, env, allowCodes = [0], maxBytes = 64 * 1024 * 1024, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...identity, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      signal,
    });
    const out = [];
    let size = 0,
      stderr = "";
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) child.kill();
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (size > maxBytes) return reject(new Error(`git ${args[0]} output exceeded ${maxBytes} bytes`));
      if (!allowCodes.includes(code)) return reject(new GitError(args, code, stderr));
      resolve(Buffer.concat(out).toString("utf8"));
    });
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

/** Run git and write its (binary) output to a file, e.g. a blob of an earlier version. */
export function gitToFile(cwd, args, file, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...identity, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const out = fs.createWriteStream(file);
    let stderr = "";
    child.stdout.pipe(out);
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      out.end(() => (code === 0 ? resolve() : reject(new GitError(args, code, stderr))));
    });
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

export const gitOk = (cwd, args) =>
  git(cwd, args).then(
    () => true,
    () => false,
  );

/**
 * Save one edit of one file as a version of its own: `edit` turns the file as the last version
 * has it into the new one, so whatever else is changed or staged in the worktree stays unsaved.
 * The file on disk is the caller's to edit. Returns the commit, or null when nothing changed.
 */
export async function commitEdit(root, file, edit, message) {
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  const [mode, , before] = (await git(root, ["ls-tree", "HEAD", "--", file])).split(/\s+/);
  const text = await git(root, ["show", `${head}:${file}`]);
  const next = edit(text);
  if (next === text) return null;
  const blob = (await git(root, ["hash-object", "-w", "--stdin"], { input: next })).trim();
  // A scratch index built from the last version: the real one may hold staged changes.
  const env = { GIT_INDEX_FILE: path.join((await git(root, ["rev-parse", "--absolute-git-dir"])).trim(), `frame-index-${process.pid}-${Date.now()}`) };
  let commit;
  try {
    await git(root, ["read-tree", head], { env });
    await git(root, ["update-index", "--cacheinfo", `${mode},${blob},${file}`], { env });
    const tree = (await git(root, ["write-tree"], { env })).trim();
    commit = (await git(root, ["commit-tree", tree, "-p", head, "-m", message])).trim();
  } finally {
    fs.rmSync(env.GIT_INDEX_FILE, { force: true });
  }
  await git(root, ["update-ref", "-m", `commit: ${message}`, "HEAD", commit, head]);
  // The real index had the last version of the file (as it does between saves): it gets the new one.
  if ((await git(root, ["ls-files", "-s", "--", file])).split(/\s+/)[1] === before) await git(root, ["update-index", "--cacheinfo", `${mode},${blob},${file}`]);
  return commit;
}

/**
 * Add a worktree on a new branch with no history. Equivalent to
 * `git worktree add --orphan` (git 2.42+), which Debian bookworm's git lacks:
 * the worktree starts detached on a throwaway empty commit, then switches to
 * an unborn branch with an empty index.
 */
export async function addOrphanWorktree(repoDir, branch, dir) {
  const tree = (await git(repoDir, ["mktree"], { input: "" })).trim();
  const seed = (await git(repoDir, ["commit-tree", tree, "-m", "empty"])).trim();
  await git(repoDir, ["worktree", "add", "--detach", "--", dir, seed]);
  await git(dir, ["checkout", "-q", "--orphan", branch]);
  await git(dir, ["read-tree", "--empty"]);
}

/**
 * Authenticated remote calls pass the token through a one-shot credential header.
 * The header is scoped to github.com: Git LFS uploads go to presigned storage URLs
 * that reject requests carrying an extra Authorization header.
 */
export function authEnv(token) {
  if (!token) return {};
  const basic = Buffer.from("x-access-token:" + token).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: Basic " + basic,
  };
}

export function parseStatus(raw) {
  const result = { branch: "", upstream: "", ahead: 0, behind: 0, files: [] };
  for (const line of raw.split("\n")) {
    if (line.startsWith("# branch.head ")) result.branch = line.slice(14);
    else if (line.startsWith("# branch.upstream ")) result.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const [, ahead, behind] = /\+(\d+) -(\d+)/.exec(line) || [];
      result.ahead = Number(ahead || 0);
      result.behind = Number(behind || 0);
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const file = line.startsWith("2 ") ? parts.slice(9).join(" ").split("\t")[0] : parts.slice(8).join(" ");
      result.files.push({ path: file, status: parts[1].replace(/\./g, "") || "M" });
    } else if (line.startsWith("? ")) result.files.push({ path: line.slice(2), status: "?" });
    else if (line.startsWith("u ")) result.files.push({ path: line.split(" ").slice(10).join(" "), status: "U" });
  }
  return result;
}
