import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startT3 } from "../../scripts/start-t3.mjs";
import { AiClient } from "../../server/ai-client.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const runtime = path.resolve(process.env.FRAME_T3_TEST_RUNTIME || process.env.FRAME_T3_ROOT || path.join(root, ".cache/t3-runtime"));
const fixture = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const pause = duration => new Promise(resolve => setTimeout(resolve, duration));
async function availablePort() {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
async function until(operation, check, description, timeout = 30000) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) { value = await operation(); if (check(value)) return value; await pause(100); }
  assert.fail(description + ": " + JSON.stringify(value));
}
test("portable T3 runs actual Claude SDK IPC turns in two projects with independent context and streaming completion", { timeout: 90000 }, async t => {
  await fs.access(path.join(runtime, "dist/bin.mjs"));
  const data = await fs.mkdtemp(path.join(root, ".cache/t3-claude-")), capture = path.join(data, "claude.jsonl");
  let service, client, callback;
  t.after(async () => { client?.close(); await service?.stop(); if (callback) await new Promise(resolve => callback.close(resolve)); await fs.rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const control = { version: 1, secret: randomUUID() + randomUUID() };
  await fs.mkdir(path.join(data, "ai/shared"), { recursive: true });
  await fs.writeFile(path.join(data, "ai/shared/control.json"), JSON.stringify(control), { mode: 0o600 });
  const contexts = new Map(), requests = [];
  callback = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks)); requests.push(value);
    const context = contexts.get(value.threadId);
    if (request.url !== "/api/ai/internal/context" || request.headers.authorization !== "Bearer " + control.secret || !context || context.cwd !== value.cwd || value.provider !== "claudeAgent") { response.writeHead(400); response.end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ version: 1, workId: context.workId, project: context.project, instructions: "Owned FRAME project " + context.project,
      env: { FRAME_WORK_ID: context.workId, FRAME_PROJECT: context.project, FRAME_THREAD_ID: value.threadId, FRAME_AGENT_TOKEN: "owned-" + value.threadId, FRAME_AGENT_URL: "http://127.0.0.1/owned-fixture" } }));
  });
  await new Promise(resolve => callback.listen(0, "127.0.0.1", resolve));
  const callbackUrl = "http://127.0.0.1:" + callback.address().port;
  const home = path.join(data, "owned-claude-home"), state = path.join(data, "ai/t3/userdata");
  await fs.mkdir(home); await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "settings.json"), JSON.stringify({ responseStreamingMode: "token", enableProviderUpdateChecks: false, providerInstances: {
    codex: { driver: "codex", enabled: false },
    claudeAgent: { driver: "claudeAgent", enabled: true, displayName: "Claude Code", environment: [{ name: "FRAME_FAKE_CLAUDE_CAPTURE", value: capture }], config: { binaryPath: fixture, homePath: home, customModels: ["owned-claude"] } },
  }, textGenerationModelSelection: { instanceId: "claudeAgent", model: "owned-claude" } }));
  const port = await availablePort(); service = await startT3({ runtimeRoot: runtime, dataRoot: data, port, env: { FRAME_CALLBACK_URL: callbackUrl }, stdio: "ignore" });
  const url = "http://127.0.0.1:" + port, token = (await fs.readFile(service.tokenFile, "utf8")).trim();
  await until(() => fetch(url + "/api/auth/session", { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(1000) }).then(response => response.ok, () => false), value => value, "Native T3 readiness");
  client = new AiClient({ data, url });
  const config = await until(() => client.config(), value => value.providers.some(item => item.instanceId === "claudeAgent" && item.status === "ready"), "Claude native provider readiness");
  const provider = config.providers.find(item => item.instanceId === "claudeAgent");
  assert.equal(provider.driver, "claudeAgent"); assert.equal(provider.displayName, "Claude Code"); assert.equal(provider.auth.status, "authenticated");
  assert.ok(provider.models.some(model => model.slug === "owned-claude"));
  const events = [];
  client.socket.on("message", data => {
    for (const item of [JSON.parse(data.toString())].flat()) if (item._tag === "Chunk" && String(item.requestId).startsWith("claude-smoke-")) {
      events.push(...item.values); client.socket.send(JSON.stringify({ _tag: "Ack", requestId: item.requestId }));
    }
  });
  for (const index of [1, 2]) {
    const projectId = randomUUID(), threadId = randomUUID(), cwd = path.join(data, "canonical-" + index), workId = randomUUID(), project = "owned-project-" + index;
    await fs.mkdir(cwd); contexts.set(threadId, { cwd, workId, project });
    const createdAt = new Date().toISOString();
    await client.dispatch({ type: "project.create", commandId: randomUUID(), projectId, title: project, workspaceRoot: cwd, createdAt });
    await client.dispatch({ type: "thread.create", commandId: randomUUID(), threadId, projectId, title: "Claude smoke " + index, modelSelection: { instanceId: "claudeAgent", model: "owned-claude" }, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdAt });
    client.socket.send(JSON.stringify({ _tag: "Request", id: "claude-smoke-" + index, tag: "orchestration.subscribeThread", payload: { threadId, turnLimit: 1, requestCompletionMarker: true }, headers: [] }));
    await client.dispatch({ type: "thread.turn.start", commandId: randomUUID(), threadId, message: { messageId: randomUUID(), role: "user", text: "Local Claude fixture " + index, attachments: [] }, runtimeMode: "full-access", interactionMode: "default", createdAt: new Date().toISOString() });
    const detail = await until(() => client.detail(threadId), value => value.thread.latestTurn?.state === "completed" || value.thread.latestTurn?.state === "error", "Claude turn completion");
    assert.equal(detail.thread.latestTurn.state, "completed", JSON.stringify(detail.thread.activities));
    assert.equal(detail.thread.modelSelection.instanceId, "claudeAgent");
    assert.ok(detail.thread.messages.some(message => message.role === "assistant" && message.text === "Claude fixture complete" && !message.streaming));
    assert.ok(events.some(value => value.kind === "event" && value.event.type === "thread.message-sent" && value.event.payload.threadId === threadId && value.event.payload.role === "assistant" && value.event.payload.streaming && value.event.payload.text === "Claude "), "The native thread must deliver a partial assistant stream before completion: " + JSON.stringify(events.filter(value => value.kind === "event" && value.event.type === "thread.message-sent").map(value => value.event.payload)));
    const rows = (await fs.readFile(capture, "utf8")).trim().split("\n").map(JSON.parse);
    const invocation = rows.find(row => row.kind === "user" && row.env.FRAME_THREAD_ID === threadId);
    assert.ok(invocation); assert.equal(invocation.cwd, cwd); assert.equal(invocation.env.FRAME_WORK_ID, workId); assert.equal(invocation.env.FRAME_PROJECT, project);
    assert.equal(invocation.env.FRAME_AGENT_TOKEN, "owned-" + threadId); assert.equal(invocation.env.CLAUDE_CONFIG_DIR, home);
    assert.equal(invocation.env.FRAME_AI_CONTROL_FILE, undefined); assert.equal(invocation.env.FRAME_CALLBACK_URL, undefined);
    assert.ok(rows.some(row => row.pid === invocation.pid && row.kind === "control" && row.request.subtype === "initialize" && row.request.appendSystemPrompt.includes("Owned FRAME project " + project)));
  }
  assert.equal(requests.length, 2); assert.notEqual(requests[0].threadId, requests[1].threadId); assert.notEqual(requests[0].cwd, requests[1].cwd);
});
