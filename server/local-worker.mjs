import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const run = path.resolve(process.argv[2] || "");
if (!fs.existsSync(path.join(run, "task.json"))) throw Error("Task input missing");
const core = path.dirname(fileURLToPath(import.meta.url));
const log = fs.createWriteStream(path.join(run, "worker.log"), { flags: "a" });
const child = spawn(process.execPath, [path.join(core, "executor.mjs")], {
  cwd: run, windowsHide: true,
  env: { ...process.env, FRAME_EXECUTOR_WORK: run, FRAME_EXECUTOR_CORE: path.dirname(core) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  try { child.kill("SIGTERM"); } catch { /* Already exited. */ }
};
process.on("message", (message) => { if (message?.type === "stop") stop(); });
process.on("disconnect", stop);
process.on("SIGTERM", stop);
child.once("error", (error) => { log.write(String(error.stack || error) + "\n"); });
child.once("exit", (code, signal) => {
  const value = { code: Number.isInteger(code) ? code : 1, signal: signal || null, finished: new Date().toISOString() };
  const temporary = path.join(run, "exit.json.tmp");
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, path.join(run, "exit.json"));
  log.end(() => process.exit(value.code));
});
