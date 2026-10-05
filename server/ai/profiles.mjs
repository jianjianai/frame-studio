import { randomUUID } from "node:crypto";
import { problem, notFound } from "../util.mjs";

/**
 * An AI profile = which agent runs (Claude Code or Codex) + how it authenticates.
 *   account        built-in: the CLI's own login (Claude subscription / ChatGPT)
 *   anthropic      Anthropic API key, or any Anthropic-compatible endpoint (baseUrl)
 *   openai         OpenAI API key, or any OpenAI Responses-compatible endpoint (baseUrl)
 */
export const BUILTIN_PROFILES = [
  { id: "claude-account", name: "Claude 账号", agent: "claude", kind: "account", builtin: true },
  { id: "codex-account", name: "ChatGPT 账号（Codex）", agent: "codex", kind: "account", builtin: true },
];

export const PROVIDER_PRESETS = [
  { id: "anthropic", name: "Anthropic API", kind: "anthropic", baseUrl: "", models: [] },
  { id: "openai", name: "OpenAI API", kind: "openai", baseUrl: "", models: [] },
  {
    id: "deepseek",
    name: "DeepSeek（Anthropic 兼容）",
    kind: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  { id: "moonshot", name: "Kimi（Anthropic 兼容）", kind: "anthropic", baseUrl: "https://api.moonshot.cn/anthropic", models: ["kimi-k2-turbo-preview"] },
  { id: "zhipu", name: "智谱 GLM（Anthropic 兼容）", kind: "anthropic", baseUrl: "https://open.bigmodel.cn/api/anthropic", models: ["glm-4.6"] },
  { id: "openrouter", name: "OpenRouter（OpenAI 兼容）", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", models: [] },
];

export class Profiles {
  constructor(settings) {
    this.settings = settings;
  }
  list() {
    const custom = this.settings.get("ai").profiles.map((profile) => ({ ...profile, hasKey: this.settings.hasSecret("ai:" + profile.id) }));
    return [...BUILTIN_PROFILES, ...custom];
  }
  get(id) {
    const profile = this.list().find((item) => item.id === id);
    if (!profile) throw notFound("AI 配置不存在：" + id);
    return profile;
  }
  save(input) {
    const kind = input.kind;
    if (!["anthropic", "openai"].includes(kind)) throw problem(400, "类型必须是 anthropic 或 openai");
    if (!input.name?.trim()) throw problem(400, "请填写名称");
    if (input.baseUrl && !/^https?:\/\//.test(input.baseUrl)) throw problem(400, "接口地址必须以 http:// 或 https:// 开头");
    const models = (input.models || [])
      .map((model) => String(model).trim())
      .filter(Boolean)
      .slice(0, 50);
    const profile = {
      id: input.id && !BUILTIN_PROFILES.some((item) => item.id === input.id) ? input.id : randomUUID(),
      name: input.name.trim().slice(0, 60),
      agent: kind === "anthropic" ? "claude" : "codex",
      kind,
      baseUrl: (input.baseUrl || "").trim().replace(/\/+$/, ""),
      models,
      defaultModel: models.includes(input.defaultModel) ? input.defaultModel : models[0] || "",
    };
    if (input.apiKey) this.settings.setSecret("ai:" + profile.id, input.apiKey.trim());
    else if (!this.settings.hasSecret("ai:" + profile.id) && !input.id) throw problem(400, "请填写 API Key");
    this.settings.update("ai", (ai) => ({ ...ai, profiles: [...ai.profiles.filter((item) => item.id !== profile.id), profile] }));
    return profile;
  }
  remove(id) {
    if (BUILTIN_PROFILES.some((item) => item.id === id)) throw problem(400, "内置配置不能删除");
    this.settings.setSecret("ai:" + id, "");
    this.settings.update("ai", (ai) => ({ ...ai, profiles: ai.profiles.filter((item) => item.id !== id) }));
  }

  /**
   * Environment for one adapter process of this profile. `model` selects one of a
   * custom provider's models (each model runs in its own process).
   */
  env(profile, model) {
    if (profile.kind === "account") return {};
    const key = this.settings.secret("ai:" + profile.id);
    if (!key) throw problem(400, `「${profile.name}」没有设置 API Key`);
    if (profile.kind === "anthropic") {
      const env = profile.baseUrl ? { ANTHROPIC_BASE_URL: profile.baseUrl, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: "" } : { ANTHROPIC_API_KEY: key };
      const chosen = model || profile.defaultModel;
      if (chosen)
        Object.assign(env, {
          ANTHROPIC_MODEL: chosen,
          ANTHROPIC_DEFAULT_OPUS_MODEL: chosen,
          ANTHROPIC_DEFAULT_SONNET_MODEL: chosen,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: chosen,
          ANTHROPIC_SMALL_FAST_MODEL: chosen,
        });
      if (profile.baseUrl) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
      return env;
    }
    const env = { CODEX_API_KEY: key, OPENAI_API_KEY: key };
    const chosen = model || profile.defaultModel;
    const config = {};
    if (chosen) config.model = chosen;
    if (profile.baseUrl) {
      config.model_provider = "frame_custom";
      config.model_providers = { frame_custom: { name: profile.name, base_url: profile.baseUrl, env_key: "FRAME_PROVIDER_KEY", wire_api: "responses" } };
      env.FRAME_PROVIDER_KEY = key;
    }
    if (Object.keys(config).length) env.CODEX_CONFIG = JSON.stringify(config);
    return env;
  }
}
