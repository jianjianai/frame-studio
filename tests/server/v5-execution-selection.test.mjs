import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  freezeExecution,
  resolveExecution,
} from "../../server/execution-selection.mjs";

test("execution selection freezes model without persisting credentials and ignores a display-name change", async () => {
  const id = randomUUID();
  const config = {
    tool: "codex",
    mode: "api",
    name: "Provider",
    apiKey: "not-a-real-secret",
    baseUrl: "https://model.example/v1/",
    model: "chosen-model",
  };
  const connections = { resolve: async () => ({ ...config }) };
  const input = { provider: "codex", connection: id };
  const first = await freezeExecution({ connections, input });
  assert.equal(first.model, "chosen-model");
  assert.equal(first.baseUrl, "https://model.example/v1");
  assert(!JSON.stringify(first).includes(config.apiKey));
  config.model = "new-default";
  assert.equal(resolveExecution(first, config, "codex").model, "chosen-model");
  assert.throws(
    () => resolveExecution(first, { ...config, model: "", models: [] }, "codex"),
    (error) => error.code === "EXECUTION_MODEL_DISABLED",
    "Removing the final catalog model must invalidate its queued selection",
  );
  config.model = "chosen-model";
  config.name = "Renamed";
  assert.equal(
    (await freezeExecution({ connections, input })).sessionKey,
    first.sessionKey,
  );
  assert.throws(
    () =>
      resolveExecution(
        first,
        { ...config, baseUrl: "https://another.example/v1" },
        "codex",
      ),
    (e) => e.code === "EXECUTION_SELECTION_CHANGED",
  );
  assert.throws(() =>
    resolveExecution(first, { ...config, tool: "claude" }, "codex"),
  );
  assert.throws(
    () => resolveExecution(first, { ...config, auth_generation: "1" }, "codex"),
    (error) => error.code === "EXECUTION_SELECTION_CHANGED",
  );
  assert.throws(
    () =>
      resolveExecution(
        first,
        { ...config, models: [{ id: "chosen-model", enabled: false }] },
        "codex",
      ),
    (error) => error.code === "EXECUTION_MODEL_DISABLED",
  );
});

test("official login identity changes cannot silently reuse a queued selection", async () => {
  const config = {
    tool: "claude",
    mode: "official",
    name: "Official",
    auth_generation: "3",
    model: "model-a",
  };
  const selection = await freezeExecution({
    connections: { resolve: async () => config },
    input: { provider: "claude", connection: randomUUID() },
  });
  assert.throws(
    () =>
      resolveExecution(
        selection,
        { ...config, auth_generation: "4" },
        "claude",
      ),
    (e) => e.code === "EXECUTION_SELECTION_CHANGED",
  );
});
