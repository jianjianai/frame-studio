#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const tool = path.basename(process.argv[1]) === "codex" ? "codex" : "claude";
const data = process.env.FRAME_DATA || "/data";
const directory = path.join(data, "tools", tool), marker = path.join(directory, "current");
const fallback = "/usr/local/bin/" + tool + "-frame-fallback";
let binary = fs.existsSync(fallback) ? fallback : "/usr/local/bin/" + tool;
if (fs.existsSync(marker)) {
  const version = fs.readFileSync(marker, "utf8").trim();
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw Error("Invalid installed CLI version");
  binary = path.join(directory, version, "node_modules/.bin", tool);
}
const child = spawn(binary, process.argv.slice(2), { env: process.env, stdio: "inherit" });
child.once("error", error => { console.error("Could not launch " + tool + ": " + error.message); process.exitCode = 1; });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.once("exit", (code, signal) => { if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exitCode = code ?? 1; });
