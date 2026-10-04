// Explicit Docker acceptance: run inside the built T3 candidate, with no production data mounted.
// The portable native suite uses user CLI paths and does not require these Docker-only aliases.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startT3 } from "../../scripts/start-t3.mjs";
import { AiClient } from "../../server/ai-client.mjs";

const runtime = "/opt/t3", version = "9.8.7";
const claudeFixture = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
async function ownedData(t, dispose = async () => {}) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "frame-t3-managed-cli-"));
  t.after(async () => { await dispose(); await fs.rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return data;
}
async function installFixture(data, tool, source) {
  const directory = path.join(data, "tools", tool), binary = path.join(directory, version, "node_modules/.bin", tool);
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, source, { mode: 0o755 });
  await fs.writeFile(path.join(directory, "current"), version + "\n");
}
function loginCommand(data, tool, args = [], { input = "", signal, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    // Positional arguments preserve Unicode and shell metacharacters while using the actual login-shell PATH.
    const child = spawn("/bin/bash", ["-ilc", 'exec "$@"', "frame-owned-cli", tool, ...args], {
      env: { ...process.env, FRAME_DATA: data, HOME: path.join(data, "home") }, stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    let stdout = "", stderr = "", failure, killTimer;
    const timer = setTimeout(() => {
      failure = Error("Owned CLI acceptance timed out"); child.kill("SIGTERM");
      // Failure cleanup must still finish when the wrapper's forwarding is the behavior under test.
      killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 1000); killTimer.unref();
    }, 10000); timer.unref();
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; if (onStdout?.(stdout)) child.kill(signal); });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (failure) reject(failure); else resolve({ stdout, stderr, code, signal: exitSignal });
    });
    child.stdin.end(input);
  });
}
async function port() {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value;
}
async function until(operation, predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    last = await operation(); if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(description);
}

test("Docker login-shell commands fall back to the preserved stock CLIs without recursion", async t => {
  const data = await ownedData(t);
  for (const tool of ["codex", "claude"]) {
    const standard = "/usr/local/bin/" + tool, fallback = standard + "-frame-fallback";
    assert.equal(await fs.realpath(standard), runtime + "/bin/" + tool);
    assert.notEqual(await fs.realpath(fallback), await fs.realpath(standard));
    const stock = await loginCommand(data, fallback, ["--version"]);
    const actual = await loginCommand(data, tool, ["--version"]);
    assert.equal(stock.code, 0, stock.stderr); assert.equal(actual.code, 0, actual.stderr);
    assert.match(actual.stdout, /\d+\.\d+\.\d+/); assert.equal(actual.stdout, stock.stdout);
  }
});

test("Docker login-shell commands use marked CLIs and preserve arguments, stdin, stderr and exit status", async t => {
  const data = await ownedData(t), args = ["--owned-fixture", "中文 空格", "& $(never-run)", '"引号"', ""], input = "owned stdin 中文\n";
  const source = `#!/usr/bin/env node
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
process.stdin.once('end', () => { console.log(JSON.stringify({ args: process.argv.slice(2), input })); console.error('owned-stderr'); process.exitCode = 7; });
`;
  for (const tool of ["codex", "claude"]) {
    await installFixture(data, tool, source);
    const actual = await loginCommand(data, tool, args, { input });
    assert.equal(actual.code, 7); assert.equal(actual.signal, null);
    assert.deepEqual(JSON.parse(actual.stdout), { args, input }); assert.match(actual.stderr, /owned-stderr/);
  }
});

test("Docker managed CLI launchers forward termination signals and leave no owned child", async t => {
  const data = await ownedData(t);
  const source = "#!/usr/bin/env node\nconsole.log(JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000);\n";
  for (const tool of ["codex", "claude"]) {
    await installFixture(data, tool, source);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      let ready = false;
      const actual = await loginCommand(data, tool, [], { signal, onStdout: stdout => {
        if (ready || !stdout.includes("\n")) return false;
        ready = true; return true;
      } });
      assert.equal(actual.code, null); assert.equal(actual.signal, signal);
      const { pid } = JSON.parse(actual.stdout); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
  }
});

test("actual T3 health and Claude SDK initialization select the marked CLI through the bare Docker command", { timeout: 60000 }, async t => {
  let service, client;
  const data = await ownedData(t, async () => { client?.close(); await service?.stop(); }), capture = path.join(data, "claude.jsonl"), home = path.join(data, "owned-claude-home");
  await fs.mkdir(home);
  await installFixture(data, "claude", `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.FRAME_FAKE_CLAUDE_CAPTURE, JSON.stringify({ kind: 'launch', args: process.argv.slice(2), executable: process.argv[1] }) + '\\n');
if (process.argv.includes('--version')) { console.log('2.1.287 (Claude Code)'); process.exit(0); }
await import(${JSON.stringify(pathToFileURL(claudeFixture).href)});
`);
  const state = path.join(data, "ai/t3/userdata"); await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "settings.json"), JSON.stringify({ enableProviderUpdateChecks: false, providerInstances: {
    codex: { driver: "codex", enabled: false },
    claudeAgent: { driver: "claudeAgent", displayName: "Owned managed Claude", enabled: true,
      environment: [{ name: "FRAME_FAKE_CLAUDE_CAPTURE", value: capture }], config: { binaryPath: "claude", homePath: home } },
  } }));
  const ownPort = await port();
  service = await startT3({ runtimeRoot: runtime, dataRoot: data, port: ownPort, env: { FRAME_DATA: data, FRAME_CALLBACK_URL: "" }, stdio: "ignore" });
  const url = "http://127.0.0.1:" + ownPort, token = (await fs.readFile(service.tokenFile, "utf8")).trim();
  await until(() => fetch(url + "/api/auth/session", { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false), Boolean, "Owned native readiness");
  client = new AiClient({ data, url });
  const config = await until(() => client.config(), value => value.providers.some(p => p.instanceId === "claudeAgent" && p.status === "ready"), "Managed native provider readiness");
  const provider = config.providers.find(p => p.instanceId === "claudeAgent");
  assert.equal(provider.version, "2.1.287"); assert.equal(provider.auth.status, "authenticated");
  assert.equal(config.settings.providerInstances.claudeAgent.config.binaryPath, "claude");
  const log = await fs.readFile(capture, "utf8");
  const rows = log.slice(0, log.lastIndexOf("\n")).split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(rows.some(row => row.kind === "launch" && row.args.includes("--version")), "Health must execute the marked CLI");
  assert.ok(rows.some(row => row.kind === "launch" && row.args.includes("stream-json")), "The real SDK must execute the marked CLI");
  assert.ok(rows.some(row => row.kind === "control" && row.request.subtype === "initialize"), "The existing local Claude fixture must complete actual SDK initialization IPC");
  assert.equal(rows.some(row => row.kind === "user"), false, "Acceptance must not start any user turn");
});
