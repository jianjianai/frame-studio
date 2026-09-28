import { spawn } from "node:child_process";
export function command(
  bin,
  args,
  {
    cwd,
    env,
    timeout = 120000,
    input,
    max = 8 * 1024 * 1024,
    combined = false,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (v) => (stdout = (stdout + v).slice(-max)));
    child.stderr.on("data", (v) => {
      stderr = (stderr + v).slice(-max);
      if (combined) stdout = (stdout + v).slice(-max);
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error((stderr || stdout || `${bin} exited ${code}`).slice(-6000)),
        );
    });
    child.stdin.end(input);
  });
}
