import { spawn } from "node:child_process";
import { problem } from "./security.mjs";

/** Git data must be complete. Unlike diagnostic command tails, patches must never be silently truncated. */
export function gitData(root, args, { input, env = {}, max = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false", ...args], {
      cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...env },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    const chunks = [];
    let bytes = 0, stderr = "", failure = null;
    const timer = setTimeout(() => { failure = problem(504, "版本操作超时，正式作品未被自动覆盖"); child.kill("SIGKILL"); }, 120000);
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > max) { failure ||= problem(413, "版本差异过大，请使用独立版本审查流程"); child.kill("SIGKILL"); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-6000); });
    child.stdin.on("error", () => {});
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(stderr || `Git operation exited ${code}`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

export async function changesBetween(root, project, before, after) {
  const prefix = `projects/${project}/`;
  const data = await gitData(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", before, after, "--", prefix], { max: 4 * 1024 * 1024 });
  const fields = data.split("\0"), changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (!fields[i]) continue;
    if (!fields[i + 1].startsWith(prefix)) throw Error("Version diff escaped the work directory");
    changes.push({ status: fields[i], path: fields[i + 1].slice(prefix.length) });
  }
  return { changes: changes.slice(0, 500), total: changes.length, truncated: changes.length > 500 };
}
