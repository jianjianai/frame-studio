import {
  modelSpecsSchema,
  modelSpecKeys,
} from "../src/contracts/model-metadata.mjs";
import { problem } from "./security.mjs";

export const PUBLIC_MODEL_CATALOG = "https://models.dev/api.json";
let catalogCache;

/** Read streams with a real byte bound, including responses without Content-Length. */
export async function readCatalogJson(
  response,
  maxBytes,
  message = "模型目录响应过大",
) {
  if (!response.body) throw problem(502, "提供商返回空模型目录");
  const reader = response.body.getReader(),
    chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw problem(502, message);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Fixed public URL; never send user endpoints, model IDs or credentials here. */
export async function loadPublicModelCatalog() {
  if (catalogCache?.until > Date.now()) return catalogCache.promise;
  const cache = { until: Date.now() + 60 * 60 * 1000 };
  cache.promise = (async () => {
    try {
      const response = await fetch(PUBLIC_MODEL_CATALOG, {
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error("Public catalog unavailable");
      }
      const data = await readCatalogJson(response, 24 * 1024 * 1024);
      if (
        !data ||
        Array.isArray(data) ||
        typeof data !== "object" ||
        !data.openai?.models
      )
        throw Error("Invalid public catalog");
      return data;
    } catch {
      cache.until = Date.now() + 30000;
      throw problem(
        502,
        "公共规格目录暂不可用；已保留 API 返回的模型，可稍后重新获取",
      );
    }
  })();
  catalogCache = cache;
  return cache.promise;
}
const number = (value) =>
  typeof value === "number"
    ? value
    : typeof value === "string" &&
        value.trim() &&
        /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())
      ? Number(value)
      : undefined;
const bool = (value) =>
  typeof value === "boolean"
    ? value
    : typeof value?.supported === "boolean"
      ? value.supported
      : undefined;
const list = (value) =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter((v) =>
            [
              "text",
              "image",
              "audio",
              "video",
              "pdf",
              "file",
              "embedding",
            ].includes(v),
          ),
        ),
      ].slice(0, 7)
    : undefined;
const text = (value) =>
  typeof value === "string"
    ? value
        .trim()
        .replace(/[\x00-\x1f\x7f]/g, "")
        .slice(0, 100)
    : undefined;
function setSpec(target, key, value, source) {
  if (value == null) return;
  const parsed = modelSpecsSchema.shape[key].safeParse(value);
  if (parsed.success) {
    target[key] = parsed.data;
    target.sources[key] = source;
  }
}

/** Normalize only explicitly advertised fields, never guess capabilities from a model name. */
export function apiModelMetadata(entry, fetchedAt) {
  const result = { sources: {}, fetchedAt };
  const name = text(entry.display_name) || text(entry.name);
  if (name) {
    result.name = name;
    result.sources.name = "api";
  }
  const cap = entry.capabilities || {},
    arch = entry.architecture || {};
  const params = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters
    : undefined;
  const inputs = list(arch.input_modalities ?? entry.input_modalities);
  const outputs = list(arch.output_modalities ?? entry.output_modalities);
  const values = {
    contextWindow: number(
      entry.top_provider?.context_length ??
        entry.context_length ??
        entry.context_window ??
        entry.max_context_length,
    ),
    maxInputTokens: number(entry.max_input_tokens ?? entry.input_token_limit),
    maxOutputTokens: number(
      entry.top_provider?.max_completion_tokens ??
        entry.max_output_tokens ??
        entry.max_completion_tokens ??
        entry.max_tokens ??
        entry.output_token_limit,
    ),
    inputModalities: inputs,
    outputModalities: outputs,
    vision:
      bool(cap.image_input ?? cap.vision ?? entry.vision) ??
      (inputs?.length ? inputs.includes("image") : undefined),
    reasoning:
      bool(cap.thinking ?? cap.reasoning ?? entry.reasoning) ??
      (params
        ? params.some((p) =>
            ["reasoning", "reasoning_effort", "include_reasoning"].includes(p),
          )
        : undefined),
    toolCall:
      bool(cap.tool_call ?? cap.tools ?? entry.tool_call) ??
      (params
        ? params.some((p) =>
            ["tools", "tool_choice", "function_call"].includes(p),
          )
        : undefined),
    structuredOutput:
      bool(cap.structured_outputs ?? entry.structured_output) ??
      (params
        ? params.some((p) =>
            ["structured_outputs", "response_format"].includes(p),
          )
        : undefined),
  };
  // OpenRouter-compatible pricing is USD/token; the UI consistently uses USD/1M tokens.
  for (const [key, field] of Object.entries({
    inputPrice: "prompt",
    outputPrice: "completion",
    cacheReadPrice: "input_cache_read",
    cacheWritePrice: "input_cache_write",
  })) {
    const cost = number(entry.pricing?.[field]);
    if (cost !== undefined) values[key] = cost * 1_000_000;
  }
  for (const [key, value] of Object.entries(values))
    setSpec(result, key, value, "api");
  return result;
}

function publicMetadata(entry) {
  const result = { sources: {} };
  const name = text(entry.name);
  if (name) {
    result.name = name;
    result.sources.name = "catalog";
  }
  const inputs = list(entry.modalities?.input),
    outputs = list(entry.modalities?.output);
  const values = {
    contextWindow: number(entry.limit?.context),
    maxInputTokens: number(entry.limit?.input),
    maxOutputTokens: number(entry.limit?.output),
    inputModalities: inputs,
    outputModalities: outputs,
    vision: inputs?.length ? inputs.includes("image") : undefined,
    reasoning: bool(entry.reasoning),
    toolCall: bool(entry.tool_call),
    structuredOutput: bool(entry.structured_output),
    inputPrice: number(entry.cost?.input),
    outputPrice: number(entry.cost?.output),
    cacheReadPrice: number(entry.cost?.cache_read),
    cacheWritePrice: number(entry.cost?.cache_write),
  };
  for (const [key, value] of Object.entries(values))
    setSpec(result, key, value, "catalog");
  return result;
}

export function matchPublicModel(catalog, config, id) {
  const host = new URL(
    config.baseUrl ||
      (config.tool === "codex"
        ? "https://api.openai.com/v1"
        : "https://api.anthropic.com"),
  ).hostname;
  const provider = {
    "api.openai.com": "openai",
    "api.anthropic.com": "anthropic",
    "openrouter.ai": "openrouter",
  }[host];
  if (provider) return catalog[provider]?.models?.[id];
  // A custom gateway can advertise an exact canonical ID. Ambiguous aliases remain unknown.
  const authors = [
    "openai",
    "anthropic",
    "google",
    "deepseek",
    "xai",
    "mistral",
    "cohere",
    "qwen",
  ];
  const matches = authors
    .map((name) => catalog[name]?.models?.[id])
    .filter(Boolean);
  if (matches.length === 1) return matches[0];
  if (!matches.length && id.includes("/"))
    return catalog.openrouter?.models?.[id];
  return undefined;
}

export async function enrichModelMetadata(
  models,
  config,
  catalogLoader = loadPublicModelCatalog,
) {
  const warnings = [];
  if (config.publicCatalog === false || !models.length) return warnings;
  let catalog;
  try {
    catalog = await catalogLoader();
  } catch {
    return [
      "公共规格目录暂不可用；模型列表仍可导入，缺失参数可稍后重新获取或手动补充。",
    ];
  }
  for (const model of models) {
    const match = matchPublicModel(catalog || {}, config, model.id);
    if (!match) continue;
    const reference = publicMetadata(match),
      metadata = model.metadata;
    for (const key of ["name", ...modelSpecKeys]) {
      if (metadata[key] == null && reference[key] != null) {
        metadata[key] = reference[key];
        metadata.sources[key] = "catalog";
      }
    }
    model.name = metadata.name || model.name;
  }
  return warnings;
}
