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

export const gitOk = (cwd, args) =>
  git(cwd, args).then(
    () => true,
    () => false,
  );

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
