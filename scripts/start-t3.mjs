import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Atomic, private service files; incomplete writes never become active credentials. */
async function privateWrite(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
function cli(entry, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "", error = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { error = (error + chunk).slice(-8192); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error("T3 native CLI exited " + code + ": " + error)));
  });
}
export async function ensureGatewayCredential({ entry, baseDir, env }) {
  await fs.mkdir(baseDir, { recursive: true });
  const tokenFile = path.join(baseDir, "frame-service-token");
  const receiptFile = path.join(baseDir, "frame-service-session.json");
  const receipt = await fs.readFile(receiptFile, "utf8").then(JSON.parse).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  const location = ["--base-dir", baseDir];
  if (receipt && Date.parse(receipt.expiresAt) > Date.now() + 86400_000) {
    const sessions = JSON.parse(await cli(entry, ["auth", "session", "list", ...location, "--json"], env));
    if (sessions.some(item => item.sessionId === receipt.sessionId && item.subject === "frame-gateway") &&
        await fs.readFile(tokenFile, "utf8").then(value => !!value.trim(), () => false)) return tokenFile;
  }
  const issued = JSON.parse(await cli(entry, ["auth", "session", "issue", ...location,
    "--subject", "frame-gateway", "--ttl", "3650d", "--json"], env));
  if (typeof issued.token !== "string" || !issued.token || typeof issued.sessionId !== "string" || !Number.isFinite(Date.parse(issued.expiresAt))) throw new Error("T3 did not issue a gateway session");
  await privateWrite(tokenFile, issued.token + "\n");
  await privateWrite(receiptFile, JSON.stringify({ sessionId: issued.sessionId, expiresAt: issued.expiresAt }) + "\n");
  if (receipt?.sessionId && receipt.sessionId !== issued.sessionId) await cli(entry, ["auth", "session", "revoke", receipt.sessionId, ...location], env);
  return tokenFile;
}

export function t3Environment({ runtimeRoot, dataRoot, env = {}, inherited = process.env }) {
  const baseDir = path.join(dataRoot, "ai/t3"), merged = { ...inherited, ...env };
  const home = path.join(baseDir, "home");
  const output = { ...merged, ...(merged.FRAME_LOCAL_MODE === "1" ? {} : { HOME: home, USERPROFILE: home }), T3CODE_HOME: baseDir,
    T3CODE_NO_BROWSER: "true", T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    FRAME_AI_CONTROL_FILE: path.join(dataRoot, "ai/shared/control.json"),
    PATH: path.join(runtimeRoot, "bin") + path.delimiter + (merged.PATH ?? merged.Path ?? "") };
  delete output.T3CODE_DEV_AUTH_TOKEN;
  return output;
}

/** Desktop and Docker share one native launcher and lifecycle. Provider sessions remain owned by T3. */
export async function startT3({ runtimeRoot = process.env.FRAME_T3_ROOT, entry = process.env.FRAME_T3_ENTRY,
  dataRoot = process.env.FRAME_DATA, host = "127.0.0.1", port = 3773, env = {}, stdio = "inherit" } = {}) {
  if (!dataRoot || !path.isAbsolute(dataRoot)) throw new Error("T3 needs an absolute FRAME data directory");
  runtimeRoot = path.resolve(runtimeRoot || (entry ? path.join(path.dirname(entry), "..") : ".cache/t3-runtime"));
  entry = path.resolve(entry || path.join(runtimeRoot, "dist/bin.mjs"));
  await fs.access(entry);
  const baseDir = path.join(dataRoot, "ai/t3"), home = path.join(baseDir, "home");
  const nativeEnv = t3Environment({ runtimeRoot, dataRoot, env });
  // Desktop CLIs keep the user's existing login homes; Docker uses its persistent shared home.
  if (nativeEnv.FRAME_LOCAL_MODE !== "1") await fs.mkdir(home, { recursive: true });
  const tokenFile = await ensureGatewayCredential({ entry, baseDir, env: nativeEnv });
  const child = spawn(process.execPath, [entry, "serve", "--base-dir", baseDir, "--host", host, "--port", String(port)],
    { env: nativeEnv, cwd: baseDir, stdio, windowsHide: true });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  // Keep rejection observed even when a caller defers awaiting readiness.
  void exited.catch(() => {});
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000); timer.unref();
    try { await exited; } finally { clearTimeout(timer); }
  }
  return { child, exited, stop, baseDir, entry, tokenFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await startT3({ host: process.env.T3CODE_HOST || "0.0.0.0", port: Number(process.env.T3CODE_PORT || 3773) });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void service.stop(); });
  const result = await service.exited;
  process.exitCode = result.code || 0;
}
