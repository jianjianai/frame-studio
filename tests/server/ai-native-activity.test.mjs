import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WebSocketServer } from "ws";
import { AiClient } from "../../server/ai-client.mjs";
import { nativeWorkSummary, AiManager } from "../../server/ai-manager.mjs";
import { scopedAiPayload } from "../../server/ai-gateway.mjs";
import { until } from "./ai-test-fixture.mjs";

const terminal = (threadId, cwd, running = false) => ({ threadId, terminalId: "term-1", cwd, worktreePath: null,
  status: "running", pid: 123, hasRunningSubprocess: running, label: "shell", updatedAt: new Date().toISOString() });

test("The shared native connection waits for terminal metadata and applies subprocess updates without polling", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "frame-terminal-stream-")), tokenFile = path.join(directory, "token");
  await fs.writeFile(tokenFile, "owned-test-token");
  let snapshots = 0, peer;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/orchestration/shell") { snapshots++; res.end(JSON.stringify({ projects: [], threads: [{ id: "a", projectId: "pa" }], snapshotSequence: 0 })); }
    else res.end(JSON.stringify({ ticket: "owned-fixture-ticket" }));
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", socket => { peer = socket; socket.on("message", bytes => {
    const value = JSON.parse(bytes);
    if (value.tag === "subscribeTerminalMetadata") socket.send(JSON.stringify({ _tag: "Chunk", requestId: value.id,
      values: [{ type: "snapshot", terminals: [terminal("a", "/a", true)] }] }));
  }); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new AiClient({ data: directory, tokenFile, url: "http://127.0.0.1:" + server.address().port });
  try {
    const shell = await client.shell();
    assert.equal(shell.terminalsReady, true); assert.equal(shell.terminals[0].hasRunningSubprocess, true);
    peer.send(JSON.stringify({ _tag: "Chunk", requestId: "frame-terminals", values: [{ type: "upsert", terminal: terminal("a", "/a", false) }] }));
    await until(() => [...client.terminals.values()][0]?.hasRunningSubprocess === false);
    assert.equal((await client.shell()).terminals[0].hasRunningSubprocess, false);
    assert.equal(snapshots, 1, "Activity updates use the existing native subscription");
    peer.terminate(); await until(() => client.terminalsReady === false);
    assert.equal(nativeWorkSummary({ projectId: "pa", cwd: "/a" }, { ...shell, terminalsReady: false }).incomplete, true);
  } finally {
    client.close(); for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Terminal subprocesses block only their canonical work; stop closes its terminals and preserves another work", async () => {
  const binding = { state: "ready", projectId: "pa", cwd: "/a" }, snapshot = {
    threads: [{ id: "a", projectId: "pa" }, { id: "b", projectId: "pb" }],
    terminals: [terminal("a", "/a"), terminal("b", "/b", true)], terminalsReady: true,
  };
  assert.equal(nativeWorkSummary(binding, snapshot).activeTerminals, 0, "An idle shell does not block source operations");
  snapshot.terminals[0].hasRunningSubprocess = true;
  assert.equal(nativeWorkSummary(binding, snapshot).activeTerminals, 1);
  assert.equal(nativeWorkSummary(binding, { ...snapshot, terminalsReady: false }).incomplete, true);
  assert.equal(nativeWorkSummary(binding, { ...snapshot, terminals: [terminal("a", "/wrong", true)] }).incomplete, true);
  const closed = [], manager = new AiManager({ store: { getWork: async () => binding }, data: "/data", client: {
    shell: async () => snapshot, rpc: async (tag, value) => { assert.equal(tag, "terminal.close"); closed.push(value); },
  } });
  assert.equal((await manager.cancelWork("owned-work")).stopped, 1);
  assert.deepEqual(closed, [{ threadId: "a", terminalId: "term-1" }]);
  const owns = id => id === "a";
  assert.deepEqual(scopedAiPayload({ type: "snapshot", terminals: snapshot.terminals }, "pa", owns).terminals, [snapshot.terminals[0]]);
  assert.equal(scopedAiPayload({ type: "upsert", terminal: snapshot.terminals[1] }, "pa", owns), null);
  assert.equal(scopedAiPayload({ type: "remove", threadId: "b", terminalId: "term-1" }, "pa", owns), null);
});
