import { spawn } from "node:child_process";
import { processLaunch } from "./local-tools.mjs";
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
    signal,
  } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const launch = processLaunch(bin, args);
    const child = spawn(launch.bin, launch.args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
      detached: !!signal && process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "", timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const stop = () => {
      // The group can outlive its leader while descendants still hold output pipes.
      if (signal && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL"); }
      } else if (signal && process.platform === "win32") {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => child.kill("SIGKILL"));
      } else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", (v) => (stdout = (stdout + v).slice(-max)));
    child.stderr.on("data", (v) => {
      stderr = (stderr + v).slice(-max);
      if (combined) stdout = (stdout + v).slice(-max);
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(signal.reason || Error("Command cancelled"));
      else if (timedOut) reject(new Error(bin + " timed out after " + timeout + "ms"));
      else if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error((stderr || stdout || `${bin} exited ${code}`).slice(-6000)),
        );
    });
    child.stdin.end(input);
  });
}
