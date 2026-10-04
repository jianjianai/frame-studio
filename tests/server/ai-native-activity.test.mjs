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

test("Native semantic activity invalidates only requested works and ignores token/usage/terminal-label chunks", async t => {
  const client = new AiClient({ data: "/unused-native-activity" });
  client.connect = async () => {};
  const bindings = [
    { workId: "work-a", projectId: "pa", cwd: "/a", repo: "repo-a", project: "film-a", state: "ready" },
    { workId: "work-b", projectId: "pb", cwd: "/b", repo: "repo-b", project: "film-b", state: "ready" },
  ];
  let queries = 0, sequence = 0;
  const store = { listWorks: async options => { assert.deepEqual(options, { requested: true, limit: 10000 }); queries++; return bindings; },
    getWork: async id => bindings.find(binding => binding.workId === id) };
  const manager = new AiManager({ store, data: "/unused-native-activity", client }), changes = [];
  manager.on("activity", change => changes.push(change)); t.after(() => manager.close());
  const thread = { id: "a", projectId: "pa", worktreePath: null, session: { status: "running" } };
  const upsert = value => client.apply({ kind: "thread-upserted", sequence: ++sequence, thread: value });
  const terminals = value => {
    if (value.type === "snapshot") client.terminals = new Map(value.terminals.map(item => [JSON.stringify([item.threadId, item.terminalId]), item]));
    else if (value.type === "upsert") client.terminals.set(JSON.stringify([value.terminal.threadId, value.terminal.terminalId]), value.terminal);
    else client.terminals.delete(JSON.stringify([value.threadId, value.terminalId]));
    client.terminalsReady = true; client.emit("terminal", value);
  };
  client.apply({ kind: "snapshot", snapshot: { projects: [], threads: [thread], snapshotSequence: sequence } });
  terminals({ type: "snapshot", terminals: [terminal("a", "/a", true)] });
  await manager.flushActivity();
  assert.equal(queries, 1, "Shell and terminal snapshots share one requested-work query");
  assert.deepEqual(changes.map(change => change.work), ["work-a", "work-b"]); changes.length = 0;
  for (let i = 0; i < 500; i++) upsert({ ...thread, messages: [{ text: "token " + i }], usage: { inputTokens: i } });
  terminals({ type: "upsert", terminal: { ...terminal("a", "/a", true), label: "another title" } });
  await manager.flushActivity();
  assert.equal(queries, 1); assert.deepEqual(changes, []);
  upsert({ ...thread, hasPendingApprovals: true }); await manager.flushActivity();
  assert.deepEqual(changes.map(change => change.work), ["work-a"]);
  assert.equal((await manager.observe("work-a")).pendingPermissions, 1, "Permission changes notify even while the thread stays running");
  changes.length = 0;
  upsert({ ...thread, projectId: "pb" }); await manager.flushActivity();
  assert.deepEqual(changes.map(change => change.work), ["work-a", "work-b"], "Thread moves invalidate the former and current work");
  assert.equal((await manager.observe("work-a")).incomplete, true, "A foreign native project still running in this physical work blocks source changes");
  assert.equal((await manager.cancelWork("work-a")).stopped, 0, "Physical uncertainty never broadens native stop ownership");
  changes.length = 0;
  client.apply({ kind: "thread-removed", threadId: "a", sequence: ++sequence }); await manager.flushActivity();
  assert.deepEqual(changes.map(change => change.work), ["work-b"], "The physical work remains blocked while the former native owner updates");
  changes.length = 0;
  upsert({ ...thread, projectId: "pb" }); await manager.flushActivity(); changes.length = 0;
  terminals({ type: "remove", threadId: "a", terminalId: "term-1" }); await manager.flushActivity();
  assert.deepEqual(changes.map(change => change.work), ["work-a", "work-b"], "A moved terminal removal resolves its native owner and releases its physical directory");
  changes.length = 0;
  client.terminalsReady = false; client.emit("disconnect"); client.emit("disconnect"); await manager.flushActivity();
  assert.deepEqual(changes.map(change => change.work), ["work-a", "work-b"]);
  assert.equal((await manager.observe("work-b")).incomplete, true);
  changes.length = 0;
  terminals({ type: "snapshot", terminals: [] }); await manager.flushActivity();
  assert.deepEqual(changes.map(change => change.work), ["work-a", "work-b"]);
  assert.equal((await manager.observe("work-b")).incomplete, false);
  changes.length = 0;
  client.apply({ kind: "snapshot", snapshot: { projects: [], threads: [{ ...thread, projectId: "pb" }], snapshotSequence: sequence } });
  await manager.flushActivity(); assert.deepEqual(changes, [], "Identical snapshots do not publish redundant work notifications");
});
