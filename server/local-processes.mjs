import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./local-worker.mjs", import.meta.url));

/** Native Windows workers retain a durable exit marker in their task directory. */
export class LocalProcesses {
  constructor(data) { this.data = data; this.children = new Map(); }
  runDir(id) { return path.join(this.data, "runs", id); }
  launch(id, env) {
    const child = spawn(process.execPath, [worker, this.runDir(id)], {
      env, cwd: path.dirname(worker), windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.children.set(id, child);
    child.once("exit", () => this.children.delete(id));
    return child.pid;
  }
  inspect(id, pid) {
    const file = path.join(this.runDir(id), "exit.json");
    if (fs.existsSync(file)) {
      const exit = JSON.parse(fs.readFileSync(file, "utf8"));
      return { Running: false, ExitCode: exit.code };
    }
    try { process.kill(Number(pid), 0); return { Running: true }; }
    catch { throw Error("Local worker is not running and has no exit record"); }
  }
  logs(id) {
    const file = path.join(this.runDir(id), "worker.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").slice(-1024 * 1024) : "";
  }
  async stop(id, pid) {
    const child = this.children.get(id);
    if (child?.connected) child.send({ type: "stop" });
    else { try { process.kill(Number(pid), "SIGTERM"); } catch { /* Already exited. */ } }
  }
  async close() {
    const pending = [...this.children];
    for (const [id, child] of pending) await this.stop(id, child.pid);
    await Promise.all(pending.map(([, child]) => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 5000).unref();
    })));
  }
}
