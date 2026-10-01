import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freezePaseoExecution, paseoExecutionConfig } from "../../server/paseo-selection.mjs";
import { resolveExecution } from "../../server/execution-selection.mjs";

test("Empty FRAME catalog freezes native model IDs without re-reading or substituting profile credentials", async () => {
  const connection = randomUUID();
  const config = { id: connection, tool: "codex", mode: "api", model: "", models: [],
    apiKey: "selected-only-fixture", auth_generation: "3", baseUrl: "https://fixture.invalid/v1" };
  config.model = "previous-frame-default"; // Clearing an explicit catalog restores native discovery.
  const selection = await freezePaseoExecution({ connection, config, model: "native-discovered-model",
    connections: { resolve: () => { throw Error("Already resolved profile must not be read again"); } } });
  assert.equal(selection.model, "native-discovered-model");
  assert.equal(selection.connection, connection);
  assert.equal(selection.authGeneration, "3");
  assert.equal(JSON.stringify(selection).includes(config.apiKey), false);
  assert.equal(resolveExecution(selection, paseoExecutionConfig(config), "codex").apiKey, config.apiKey);
});

test("Explicit FRAME model policy retains disabled, removed, legacy and official default rules", async () => {
  const connection = randomUUID(), config = { tool: "claude", mode: "api", apiKey: "fixture",
    model: "selected", models: [{ id: "selected", enabled: true }, { id: "disabled", enabled: false }] };
  const select = (model, provider = config) => freezePaseoExecution({ connection, config: provider, model });
  await select("selected");
  await assert.rejects(select("disabled"), error => error.statusCode === 400);
  await assert.rejects(select("missing"), error => error.statusCode === 400);
  await assert.rejects(select("-option"), /Invalid/);
  await select("legacy", { ...config, model: "legacy", models: undefined });
  await assert.rejects(select("missing", { ...config, model: "legacy", models: undefined }), error => error.statusCode === 400);
  const official = { ...config, mode: "official", apiKey: undefined };
  assert.equal((await select("", official)).model, "");
  const frozen = await select("selected");
  assert.throws(() => resolveExecution(frozen, paseoExecutionConfig({ ...config,
    models: [{ id: "selected", enabled: false }] }), "claude"), error => error.code === "EXECUTION_MODEL_DISABLED");
});
