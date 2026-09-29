import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freezeExecution, resolveExecution, resumableSession, continuationContext } from "../../server/execution-selection.mjs";

test("execution selection freezes model without persisting credentials and ignores a display-name change", async () => {
  const id = randomUUID();
  const config = { tool: "codex", mode: "api", name: "Provider", apiKey: "not-a-real-secret", baseUrl: "https://model.example/v1/", model: "chosen-model" };
  const connections = { resolve: async () => ({ ...config }) };
  const input = { provider: "codex", connection: id };
  const first = await freezeExecution({ connections, input });
  assert.equal(first.model, "chosen-model");
  assert.equal(first.baseUrl, "https://model.example/v1");
  assert(!JSON.stringify(first).includes(config.apiKey));
  config.model = "new-default";
  assert.equal(resolveExecution(first, config, "codex").model, "chosen-model");
  config.model = "chosen-model";
  config.name = "Renamed";
  assert.equal((await freezeExecution({ connections, input })).sessionKey, first.sessionKey);
  assert.throws(() => resolveExecution(first, { ...config, baseUrl: "https://another.example/v1" }, "codex"), e => e.code === "EXECUTION_SELECTION_CHANGED");
  assert.throws(() => resolveExecution(first, { ...config, tool: "claude" }, "codex"));
});

test("official login identity changes cannot silently reuse a queued selection", async () => {
  const config = { tool: "claude", mode: "official", name: "Official", auth_generation: "3", model: "model-a" };
  const selection = await freezeExecution({ connections: { resolve: async () => config }, input: { provider: "claude", connection: randomUUID() } });
  assert.throws(() => resolveExecution(selection, { ...config, auth_generation: "4" }, "claude"), e => e.code === "EXECUTION_SELECTION_CHANGED");
  assert.equal(resumableSession({ upstream: "thread", upstream_execution: selection.sessionKey }, selection), "thread");
  assert.equal(resumableSession({ upstream: "thread", upstream_execution: "other" }, selection), null);
  assert.equal(resumableSession({ upstream: "legacy" }, null), "legacy");
});

test("a changed execution session carries bounded prior context, not an incompatible upstream id", async () => {
  const db = { all: async sql => sql.includes("FROM tasks") ? [{ id: "t", input: { prompt: "p".repeat(30000) } }] : [{ kind: "message", data: { id: "m", text: "a".repeat(30000) } }] };
  const result = await continuationContext(db, { id: "current", chat: "chat" }, { upstream: "old", upstream_execution: "old" }, { sessionKey: "new" });
  assert.equal(result.upstream, null);
  assert.equal(result.strategy, "new-with-context");
  assert.equal(result.turns[0].prompt.length, 4000);
  assert.equal(result.turns[0].answer.length, 4000);
});
