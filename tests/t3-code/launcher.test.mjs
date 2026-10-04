import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { t3Environment, runT3Cli } from "../../scripts/start-t3.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));

async function hangingCli(t) {
  const data = await fs.mkdtemp(path.join(root, ".cache/t3-launcher-")), entry = path.join(data, "auth-cli.mjs"), receipt = path.join(data, "pid");
  await fs.writeFile(entry, 'import fs from "node:fs"; process.on("SIGTERM", () => {}); fs.writeFileSync(process.env.FRAME_TEST_PID_FILE, String(process.pid)); setInterval(() => {}, 1000);\n');
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  return { entry, receipt, env: { ...process.env, FRAME_TEST_PID_FILE: receipt } };
}

test("a hung native authentication CLI times out and its owned process is gone before rejection", async t => {
  const fixture = await hangingCli(t);
  await assert.rejects(runT3Cli(fixture.entry, [], fixture.env, { timeoutMs: 1000, killAfterMs: 50 }), /authentication CLI timed out/);
  const pid = Number(await fs.readFile(fixture.receipt, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("closing local startup cancels and cleans its authentication CLI instead of waiting for its timeout", async t => {
  const fixture = await hangingCli(t), controller = new AbortController();
  const operation = runT3Cli(fixture.entry, [], fixture.env, { signal: controller.signal, killAfterMs: 50 });
  // Observe the rejection from launch, before cancellation can settle it.
  const cancelled = assert.rejects(operation, { name: "AbortError" });
  const deadline = Date.now() + 5000;
  let pid;
  while (Date.now() < deadline && !pid) {
    pid = await fs.readFile(fixture.receipt, "utf8").then(Number, () => null);
    if (!pid) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(pid, "Owned CLI did not become ready for cancellation");
  controller.abort(); await cancelled;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("local T3 retains actual CLI login homes while its native UI state has an independent directory", () => {
  const inherited = { HOME: "/users/creator", USERPROFILE: "C:\\Users\\Creator", PATH: "/tools", FRAME_LOCAL_MODE: "1", CODEX_HOME: "/users/creator/.codex", T3CODE_DEV_AUTH_TOKEN: "fixture-only" };
  const env = t3Environment({ runtimeRoot: "/runtime/t3", dataRoot: "/frame-data", inherited });
  assert.equal(env.HOME, inherited.HOME); assert.equal(env.USERPROFILE, inherited.USERPROFILE);
  assert.equal(env.CODEX_HOME, inherited.CODEX_HOME);
  assert.equal(env.T3CODE_HOME, path.join("/frame-data", "ai/t3"));
  assert.equal(env.T3CODE_DEV_AUTH_TOKEN, undefined);
});
test("Docker T3 uses its persistent shared CLI home and allows explicit service environment overrides", () => {
  const env = t3Environment({ runtimeRoot: "/runtime/t3", dataRoot: "/frame-data", inherited: { HOME: "/root", PATH: "/original" }, env: { PATH: "/managed", FRAME_CALLBACK_URL: "http://frame-web:3000" } });
  assert.equal(env.HOME, path.join("/frame-data", "ai/t3/home"));
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.PATH, path.join("/runtime/t3", "bin") + path.delimiter + "/managed");
  assert.equal(env.FRAME_CALLBACK_URL, "http://frame-web:3000");
});
