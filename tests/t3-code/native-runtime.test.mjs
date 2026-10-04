import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startT3, ensureGatewayCredential, t3Environment } from "../../scripts/start-t3.mjs";
import { verifyT3Bundle } from "../../scripts/build-t3.mjs";
import { AiClient } from "../../server/ai-client.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const runtime = path.resolve(process.env.FRAME_T3_TEST_RUNTIME || process.env.FRAME_T3_ROOT || path.join(root, ".cache/t3-runtime"));
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
test("the pinned portable native T3 runtime authenticates HTTP and exposes one shared shell over actual RPC", { timeout: 90000 }, async t => {
  // A missing real candidate must fail this release gate, never become a skipped UI test.
  await fs.access(path.join(runtime, "dist/bin.mjs"));
  const { source, proof } = await verifyT3Bundle(runtime);
  assert.equal(source.version, "0.0.45"); assert.equal(proof.commit, source.commit);
  const data = await fs.mkdtemp(path.join(root, ".cache/t3-test-")), port = await freePort();
  let service, client;
  t.after(async () => { await client?.close(); await service?.stop(); await fs.rm(data, { recursive: true, force: true }); });
  service = await startT3({ runtimeRoot: runtime, dataRoot: data, port, env: { FRAME_CALLBACK_URL: "" }, stdio: "ignore" });
  const url = new URL("http://127.0.0.1:" + port), token = (await fs.readFile(service.tokenFile, "utf8")).trim();
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    assert.equal(service.child.exitCode, null, "Native T3 exited before readiness");
    ready = await fetch(new URL("/api/auth/session", url), { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(1000) }).then(response => response.ok, () => false);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, "Native T3 did not become ready");
  const receipt = await fs.readFile(path.join(service.baseDir, "frame-service-session.json"), "utf8");
  assert.equal(await ensureGatewayCredential({ entry: service.entry, baseDir: service.baseDir,
    env: t3Environment({ runtimeRoot: runtime, dataRoot: data }) }), service.tokenFile);
  assert.equal(await fs.readFile(path.join(service.baseDir, "frame-service-session.json"), "utf8"), receipt,
    "Restarting the shared launcher must reuse its native session rather than issuing another credential");
  client = new AiClient({ data, url: url.href });
  const config = await client.config();
  assert.ok(config.environment.environmentId);
  const cwd = path.join(data, "canonical"); await fs.mkdir(cwd);
  const projectId = randomUUID(), command = { type: "project.create", commandId: randomUUID(), projectId, title: "FRAME native fixture", workspaceRoot: cwd, createdAt: new Date().toISOString() };
  await client.dispatch(command); await client.dispatch(command);
  const snapshot = await client.request("/api/orchestration/shell");
  assert.equal(snapshot.projects.filter(project => project.id === projectId).length, 1);
  assert.equal(snapshot.projects.find(project => project.id === projectId).workspaceRoot, cwd);
  const html = await fetch(url).then(response => response.text());
  assert.match(html, /\/ai\/assets\//);
  assert.doesNotMatch(html, /paseo/i);
});
