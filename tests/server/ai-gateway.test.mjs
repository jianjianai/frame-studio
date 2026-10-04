import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import http from "node:http";
import Fastify from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { installAiGateway } from "../../server/ai-gateway.mjs";
import { until } from "./ai-test-fixture.mjs";

test("Native streaming captures one work binding, filters other projects and preserves chunk order without token queries", async () => {
  const workId = randomUUID(), projectId = randomUUID(), foreignProject = randomUUID();
  const native = http.createServer(), nativeWs = new WebSocketServer({ server: native });
  await new Promise(resolve => native.listen(0, "127.0.0.1", resolve));
  const app = Fastify(); app.parseCookie = () => ({});
  let bindingReads = 0, socket, filteredAck = false;
  const store = { async getWork(id) { assert.equal(id, workId); bindingReads++; return { state: "ready", projectId, cwd: "/owned/work" }; } };
  const manager = { store, client: { url: new URL("http://127.0.0.1:" + native.address().port),
    threads: new Map([["own", { projectId }], ["foreign", { projectId: foreignProject }]]), async shell() { return {}; },
    async request(route) { assert.equal(route, "/api/auth/websocket-ticket"); return { ticket: "owned-fixture-ticket" }; } } };
  const workService = { works: { async get(id) { assert.equal(id, workId); return { id }; } } };
  nativeWs.on("connection", client => {
    client.on("message", bytes => { const value = JSON.parse(bytes); if (value._tag === "Ack" && value.requestId === "terminal-stream") filteredAck = true; });
    client.send(JSON.stringify({ _tag: "Chunk", requestId: "terminal-stream", values: [{ type: "upsert", terminal: { threadId: "foreign", terminalId: "term-1" } }] }));
    // A non-scoped project should never reach the embedded native work.
    for (let sequence = 0; sequence < 100; sequence++) client.send(JSON.stringify({ _tag: "Chunk", id: "stream", values: [
      { kind: "thread-upserted", thread: { id: "own", projectId, sequence } },
      { kind: "thread-upserted", thread: { id: "foreign", projectId: foreignProject } },
    ] }));
    client.send(JSON.stringify({ _tag: "Exit", id: "shell", exit: { _tag: "Success", value: {
      projects: [{ id: projectId }, { id: foreignProject }], threads: [{ projectId }, { projectId: foreignProject }],
    } } }));
  });
  try {
    await installAiGateway({ app, manager, workService, store, workspace: {}, authenticate: async () => {} });
    await app.listen({ host: "127.0.0.1", port: 0 });
    socket = new WebSocket("ws://127.0.0.1:" + app.server.address().port + "/ai/works/" + workId + "/ws");
    const messages = []; socket.on("message", data => messages.push(JSON.parse(data)));
    await once(socket, "open");
    await until(() => messages.length === 101, "Native chunks were not forwarded");
    assert.equal(bindingReads, 1, "An established stream must not load the work for each token");
    assert.deepEqual(messages.slice(0, 100).map(message => message.values[0].thread.sequence), Array.from({ length: 100 }, (_, index) => index));
    assert.ok(messages.slice(0, 100).every(message => message.values.length === 1 && message.values[0].thread.id === "own"));
    assert.deepEqual(messages[100].exit.value, { projects: [{ id: projectId }], threads: [{ projectId }] });
    await until(() => filteredAck, "Filtered terminal events must still acknowledge native backpressure");
  } finally {
    socket?.terminate(); await app.close();
    for (const client of nativeWs.clients) client.terminate();
    await new Promise(resolve => nativeWs.close(resolve));
    await new Promise(resolve => native.close(resolve));
  }
});
