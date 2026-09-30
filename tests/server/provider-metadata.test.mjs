import test from "node:test";
import assert from "node:assert/strict";
import {
  apiModelMetadata,
  enrichModelMetadata,
  matchPublicModel,
} from "../../server/provider-metadata.mjs";
import { discoverModels } from "../../server/provider-catalog.mjs";
import { normalizeProviderUrl } from "../../server/provider-lifecycle.mjs";
import {
  effectiveModelSpecs,
  modelSpecSource,
} from "../../src/contracts/model-metadata.mjs";
import {
  providerModelsSchema,
  mergeDiscoveredModels,
  providerModels,
} from "../../src/contracts/ai-models.mjs";
const at = "2026-09-30T00:00:00.000Z";
const config = {
  mode: "api",
  tool: "codex",
  baseUrl: "https://gateway.invalid/v1",
  apiKey: "test-secret",
  publicCatalog: false,
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });
const reference = {
  name: "Reference",
  limit: { context: 200000, input: 190000, output: 32000 },
  modalities: { input: ["text", "image"], output: ["text"] },
  reasoning: true,
  tool_call: true,
  cost: { input: 3, output: 15, cache_read: 0.3 },
};

test("metadata normalizes explicit API capabilities, token limits and per-token pricing without guessing", () => {
  const metadata = apiModelMetadata(
    {
      display_name: "Example",
      context_length: "1000000",
      max_output_tokens: 64000,
      architecture: {
        input_modalities: ["text", "image", "image"],
        output_modalities: ["text"],
      },
      supported_parameters: ["tools", "reasoning", "response_format"],
      pricing: {
        prompt: "0.000002",
        completion: "0.000008",
        input_cache_read: "0",
      },
    },
    at,
  );
  assert.equal(metadata.contextWindow, 1000000);
  assert.equal(metadata.maxOutputTokens, 64000);
  assert.equal(metadata.inputPrice, 2);
  assert.equal(metadata.outputPrice, 8);
  assert.equal(metadata.cacheReadPrice, 0);
  assert.equal(metadata.vision, true);
  assert.equal(metadata.reasoning, true);
  assert.equal(metadata.toolCall, true);
  assert.equal(metadata.structuredOutput, true);
  assert.deepEqual(metadata.inputModalities, ["text", "image"]);
  assert(Object.values(metadata.sources).every((source) => source === "api"));
  const claude = apiModelMetadata(
    {
      max_input_tokens: 200000,
      max_tokens: 32000,
      capabilities: {
        image_input: { supported: true },
        thinking: { supported: false },
        structured_outputs: { supported: true },
      },
    },
    at,
  );
  assert.equal(claude.maxInputTokens, 200000);
  assert.equal(
    claude.contextWindow,
    undefined,
    "input-only limits are not claimed as total context",
  );
  assert.equal(claude.reasoning, false);
  assert.equal(claude.toolCall, undefined);
  const unknown = apiModelMetadata(
    {
      id: "latest-thinking-vision-1m",
      context_length: -1,
      max_output_tokens: "NaN",
      pricing: { prompt: -1 },
    },
    at,
  );
  assert.deepEqual(unknown.sources, {});
  assert.equal(unknown.vision, undefined);
  assert.equal(unknown.contextWindow, undefined);
});

test("public metadata is exact-match, optional, secondary to API values and safely unavailable", async () => {
  const catalog = {
    openai: { models: { exact: reference } },
    anthropic: { models: { ambiguous: reference } },
    google: { models: { ambiguous: reference } },
  };
  assert.equal(matchPublicModel(catalog, config, "exact"), reference);
  assert.equal(matchPublicModel(catalog, config, "ambiguous"), undefined);
  assert.equal(matchPublicModel(catalog, config, "exact-latest"), undefined);
  assert.equal(
    matchPublicModel(
      catalog,
      { ...config, baseUrl: "https://api.anthropic.com" },
      "exact",
    ),
    undefined,
  );
  const models = [
    {
      id: "exact",
      name: "API",
      metadata: apiModelMetadata(
        {
          name: "API",
          context_length: 128000,
          reasoning: false,
          pricing: { prompt: "0" },
        },
        at,
      ),
    },
  ];
  let reads = 0;
  assert.deepEqual(
    await enrichModelMetadata(models, config, async () => {
      reads++;
      return catalog;
    }),
    [],
  );
  assert.equal(reads, 0);
  await enrichModelMetadata(
    models,
    { ...config, publicCatalog: true },
    async () => {
      reads++;
      return catalog;
    },
  );
  assert.equal(reads, 1);
  assert.equal(models[0].metadata.contextWindow, 128000);
  assert.equal(models[0].metadata.inputPrice, 0);
  assert.equal(models[0].metadata.reasoning, false);
  assert.equal(models[0].metadata.maxOutputTokens, 32000);
  assert.equal(models[0].metadata.sources.maxOutputTokens, "catalog");
  assert.equal(models[0].metadata.sources.contextWindow, "api");
  assert.equal(models[0].name, "API");
  const failed = await discoverModels(
    { ...config, publicCatalog: true },
    async () => json({ data: [{ id: "exact" }] }),
    async () => {
      throw Error("sensitive failure");
    },
  );
  assert.equal(failed.models.length, 1);
  assert.equal(failed.warnings.length, 1);
  assert(!JSON.stringify(failed).includes("sensitive failure"));
});

test("API discovery follows bounded same-endpoint cursors and keeps partial results on a later-page failure", async () => {
  const requests = [];
  const result = await discoverModels(
    { ...config, tool: "claude" },
    async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1
        ? json({
            data: [{ id: "one" }],
            has_more: true,
            last_id: "one",
            next: "https://evil.invalid/steal",
          })
        : json({
            data: [{ id: "one" }, { id: "two", max_tokens: 8192 }],
            has_more: false,
          });
    },
  );
  assert.equal(result.pages, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["one", "two"],
  );
  assert.equal(
    requests[1].url,
    "https://gateway.invalid/v1/models?after_id=one",
  );
  assert.equal(requests[1].options.headers["x-api-key"], config.apiKey);
  assert.equal(requests[1].options.redirect, "error");
  let calls = 0;
  const partial = await discoverModels(config, async () =>
    ++calls === 1
      ? json({ data: [{ id: "one" }], has_more: true })
      : json({}, 503),
  );
  assert.equal(partial.models.length, 1);
  assert.equal(partial.truncated, true);
  assert.equal(partial.warnings.length, 1);
  calls = 0;
  const repeated = await discoverModels(config, async () => {
    calls++;
    return json({ data: [{ id: "one" }], has_more: true, last_id: "one" });
  });
  assert.equal(calls, 2);
  assert.equal(repeated.truncated, true);
  calls = 0;
  const bounded = await discoverModels(config, async () =>
    json({ data: [{ id: `model-${++calls}` }], has_more: true }),
  );
  assert.equal(calls, 10);
  assert.equal(bounded.models.length, 10);
  assert.equal(bounded.truncated, true);
});

test("catalog errors redact upstream content and reported secrets; duplicates do not claim missing pages", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(
      discoverModels(config, async () =>
        json({ error: config.apiKey }, status),
      ),
      (error) =>
        error.message.includes(`HTTP ${status}`) &&
        !error.message.includes(config.apiKey),
    );
  }
  const result = await discoverModels(config, async () =>
    json({
      data: [
        {
          id: "one",
          name: `API ${config.apiKey}`,
          description: `Description ${config.apiKey}`,
        },
        { id: "one" },
        { id: "bad\nname" },
        { id: config.apiKey },
      ],
    }),
  );
  assert.equal(result.models.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.skipped, 2);
  assert(!JSON.stringify(result).includes(config.apiKey));
});

test("synchronization preserves local names, disabled models, missing entries and manual overrides", () => {
  const metadata = apiModelMetadata(
    { display_name: "Remote old", context_length: 100000 },
    at,
  );
  const saved = [
    {
      id: "one",
      name: "我的主力",
      enabled: false,
      metadata,
      overrides: { contextWindow: 64000, vision: false, inputPrice: 0 },
    },
    { id: "two", name: "Remote old", metadata },
    { id: "missing", name: "Keep me" },
  ];
  const incoming = ["one", "two", "new"].map((id) => ({
    id,
    name: "Remote new",
    enabled: true,
    metadata: apiModelMetadata(
      { display_name: "Remote new", context_length: 200000 },
      at,
    ),
  }));
  const merged = mergeDiscoveredModels(saved, incoming, ["one", "two", "new"]);
  assert.equal(merged.length, 4);
  assert.equal(merged[0].enabled, false);
  assert.equal(merged[0].name, "我的主力");
  assert.equal(merged[1].name, "Remote new");
  assert.equal(merged[2].id, "missing");
  assert.equal(effectiveModelSpecs(merged[0]).contextWindow, 64000);
  assert.equal(effectiveModelSpecs(merged[0]).vision, false);
  assert.equal(effectiveModelSpecs(merged[0]).inputPrice, 0);
  assert.equal(modelSpecSource(merged[0], "contextWindow"), "manual");
  delete merged[0].overrides.contextWindow;
  assert.equal(effectiveModelSpecs(merged[0]).contextWindow, 200000);
  assert.equal(modelSpecSource(merged[0], "contextWindow"), "api");
  merged[0].overrides.contextWindow = null;
  assert.equal(effectiveModelSpecs(merged[0]).contextWindow, null);
  assert.equal(
    providerModelsSchema.safeParse([
      { id: "bad", name: "Bad", overrides: { contextWindow: -1 } },
    ]).success,
    false,
  );
  assert.deepEqual(providerModels({ mode: "api", models: [] }), []);
});

test("connection URLs normalize pasted endpoints without accepting embedded credentials or query parameters", () => {
  assert.equal(
    normalizeProviderUrl(" https://api.example.com/v1/responses/ "),
    "https://api.example.com/v1",
  );
  assert.equal(
    normalizeProviderUrl("https://api.example.com/v1/models"),
    "https://api.example.com/v1",
  );
  assert.equal(
    normalizeProviderUrl("https://api.example.com/v1/messages"),
    "https://api.example.com/v1",
  );
  assert.equal(normalizeProviderUrl("https://api.example.com/v1/messages", "claude"), "https://api.example.com");
  assert.equal(normalizeProviderUrl("https://api.example.com/gateway/v1/", "claude"), "https://api.example.com/gateway");
  assert.equal(normalizeProviderUrl("https://api.example.com/v1/responses", "codex"), "https://api.example.com/v1");
  assert.equal(normalizeProviderUrl(""), "");
  for (const url of [
    "https://name:secret@example.com/v1",
    "https://example.com?key=secret",
    "https://example.com/#fragment",
    "file:///etc/passwd",
    "not-a-url",
  ])
    assert.throws(() => normalizeProviderUrl(url));
});
