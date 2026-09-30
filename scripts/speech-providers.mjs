import fs from "node:fs";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { parseEnv } from "node:util";
import { z } from "zod";
import { safePath } from "./mcp/workspace.mjs";
import {
  ttsProviders,
  ttsProviderIds,
  ttsOptionsSchema,
  normalizeTtsInput,
} from "./tts-capabilities.mjs";

export const SPEECH_CONFIG = "production/speech.json";
export const MAX_SPEECH_BYTES = 32 * 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const key = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const envName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
  .refine((v) => !/^(FRAME_MCP|FRAME_OAUTH|CLOUDFLARE)/.test(v));
const voice = z.string().min(1).max(200);
const settings = z.record(z.string(), z.unknown());
const profile = z.strictObject({
  type: z.enum([
    "edge",
    "azure",
    "custom",
    ...ttsProviderIds.filter((id) => id !== "local"),
  ]),
  voice: voice.optional(),
  model: z.string().min(1).max(200).optional(),
  apiKeyEnv: envName.optional(),
  baseUrlEnv: envName.optional(),
  regionEnv: envName.optional(),
  module: z.string().min(1).max(512).optional(),
  dependencies: z.array(z.string()).max(32).optional(),
  settings: settings.optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  cacheRevision: z.string().max(200).optional(),
});
const configSchema = z.strictObject({
  version: z.literal(1),
  defaultProvider: key,
  providers: z.record(key, profile),
  speakers: z
    .record(
      key,
      z.strictObject({
        provider: key.optional(),
        voice: voice.optional(),
        settings: settings.optional(),
      }),
    )
    .default({}),
});
const packageInfo = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const packageNames = {
  edge: "msedge-tts",
  openai: "openai",
  azure: "microsoft-cognitiveservices-speech-sdk",
};
const implementation = digest(
  fs.readFileSync(import.meta.filename) +
    fs.readFileSync(new URL("speech-worker.mjs", import.meta.url)) +
    fs.readFileSync(new URL("tts-adapters.mjs", import.meta.url)) +
    fs.readFileSync(new URL("tts-capabilities.mjs", import.meta.url)),
);
export const speechProviders = () => [
  {
    type: "edge",
    package: "msedge-tts",
    version: packageInfo.dependencies["msedge-tts"],
    needsKey: false,
    online: true,
    note: "Community Edge Read Aloud client; availability is not guaranteed by Azure.",
  },
  {
    type: "openai",
    package: "openai",
    version: packageInfo.dependencies.openai,
    needsKey: true,
    online: true,
    note: "Official HTTP adapter; baseUrlEnv defaults to conservative compatible capabilities.",
  },
  {
    type: "azure",
    package: "microsoft-cognitiveservices-speech-sdk",
    version: packageInfo.dependencies["microsoft-cognitiveservices-speech-sdk"],
    needsKey: true,
    online: true,
  },
  {
    type: "custom",
    needsKey: false,
    note: "Trusted project-local .mjs implementing synthesize; not an OS sandbox.",
  },
  ...ttsProviders
    .filter((p) => p.id !== "openai")
    .map((p) => ({
      type: p.id,
      note: p.note,
      models: p.models,
      needsKey: !["qwen3", "compatible"].includes(p.id),
      online: p.id !== "qwen3",
    })),
];
export function speechTemplate(type = "edge", selectedVoice) {
  if (
    selectedVoice !== undefined &&
    (!voice.safeParse(selectedVoice).success ||
      (["edge", "azure"].includes(type) &&
        !/^[a-zA-Z0-9-]{1,150}$/.test(selectedVoice)))
  )
    throw new Error("Invalid speech voice");
  const presets = {
    edge: {
      type,
      voice: "zh-CN-XiaoxiaoNeural",
      settings: { rate: "+0%", pitch: "+0Hz", volume: "+0%" },
    },
    openai: {
      type,
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      apiKeyEnv: "OPENAI_API_KEY",
      settings: { speed: 1 },
    },
    azure: {
      type,
      voice: "zh-CN-XiaoxiaoNeural",
      apiKeyEnv: "AZURE_SPEECH_KEY",
      regionEnv: "AZURE_SPEECH_REGION",
    },
    custom: {
      type,
      module: "scripts/narration-provider.mjs",
      voice: "default",
    },
  };
  const preset = ttsProviders.find((p) => p.id === type);
  const keyEnvs = {
    minimax: "MINIMAX_API_KEY",
    doubao: "DOUBAO_API_KEY",
    elevenlabs: "ELEVENLABS_API_KEY",
  };
  if (!presets[type] && preset)
    presets[type] = {
      type,
      model: preset.model || "model-id",
      voice: preset.voice || "voice-id",
      ...(keyEnvs[type] ? { apiKeyEnv: keyEnvs[type] } : {}),
      ...(["qwen3", "compatible"].includes(type)
        ? { baseUrlEnv: "TTS_BASE_URL" }
        : {}),
    };
  if (!presets[type]) throw new Error("Unknown speech provider type");
  return {
    version: 1,
    defaultProvider: type,
    providers: {
      [type]: {
        ...presets[type],
        ...(selectedVoice ? { voice: selectedVoice } : {}),
      },
    },
    speakers: { narrator: { provider: type } },
  };
}
function rejectSecrets(value, depth = 0) {
  if (depth > 20) throw new Error("Speech settings are too deeply nested");
  if (!value || typeof value !== "object") return;
  for (const [name, child] of Object.entries(value)) {
    if (
      /^(api[-_]?key|token|password|authorization|secret|headers|baseurl|endpoint|__proto__|constructor|prototype)$/i.test(
        name,
      )
    )
      throw new Error(
        "Speech configuration cannot contain credentials, headers or literal endpoints; use environment references",
      );
    rejectSecrets(child, depth + 1);
  }
}
export function readSpeechConfig(
  workspace,
  id,
  file = SPEECH_CONFIG,
  optional = false,
) {
  workspace.project(id);
  const target = workspace.file(id, file);
  if (optional && !fs.existsSync(target)) return null;
  if (fs.statSync(target).size > 128 * 1024)
    throw new Error("Speech config exceeds 128 KiB");
  const raw = JSON.parse(fs.readFileSync(target, "utf8"));
  rejectSecrets(raw);
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "Invalid speech configuration fields: " +
        parsed.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  const config = parsed.data;
  if (
    Object.keys(config.providers).length > 16 ||
    Object.keys(config.speakers).length > 32 ||
    !Object.hasOwn(config.providers, config.defaultProvider)
  )
    throw new Error(
      "Use 1..16 providers, at most 32 speakers and an existing defaultProvider",
    );
  for (const speaker of Object.values(config.speakers))
    if (speaker.provider && !Object.hasOwn(config.providers, speaker.provider))
      throw new Error("Speaker refers to an unknown speech provider");
  return config;
}
function environment(workspace, id) {
  const read = (base) => {
    const file = safePath(base, ".env", { internal: true });
    if (!fs.existsSync(file)) return {};
    if (fs.statSync(file).size > 128 * 1024)
      throw new Error("Speech environment file exceeds 128 KiB");
    return parseEnv(fs.readFileSync(file, "utf8"));
  };
  return {
    ...read(workspace.root),
    ...read(workspace.project(id)),
    ...process.env,
  };
}
function endpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid speech endpoint in environment");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "Speech endpoint requires HTTPS or loopback HTTP, without credentials or query parameters",
    );
  return url.href.replace(/\/$/, "");
}
function checkedSettings(type, value = {}) {
  rejectSecrets(value);
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    JSON.stringify(value).length > 16000
  )
    throw new Error("Invalid or oversized speech settings");
  if (type === "custom") return value;
  if (ttsProviderIds.includes(type)) {
    const { speed, ...options } = value;
    if (
      speed !== undefined &&
      (!Number.isFinite(speed) || speed < 0.25 || speed > 4)
    )
      throw new Error("Invalid speech speed");
    return {
      ...ttsOptionsSchema.parse(options),
      ...(speed !== undefined ? { speed } : {}),
    };
  }
  const schemas = {
    edge: z.strictObject({
      rate: z
        .string()
        .regex(/^[+-]\d{1,3}%$/)
        .optional(),
      pitch: z
        .string()
        .regex(/^[+-]\d{1,3}Hz$/)
        .optional(),
      volume: z
        .string()
        .regex(/^[+-]\d{1,3}%$/)
        .optional(),
    }),
    azure: z.strictObject({
      rate: z
        .string()
        .regex(/^[+-]\d{1,3}%$/)
        .optional(),
      pitch: z
        .string()
        .regex(/^[+-]\d{1,3}(Hz|%)$/)
        .optional(),
      volume: z
        .string()
        .regex(/^[+-]\d{1,3}%$/)
        .optional(),
      style: z
        .string()
        .regex(/^[a-zA-Z-]{1,60}$/)
        .optional(),
      styleDegree: z.number().min(0.01).max(2).optional(),
      role: z
        .string()
        .regex(/^[a-zA-Z]{1,60}$/)
        .optional(),
    }),
  };
  const result = schemas[type].safeParse(value);
  if (!result.success)
    throw new Error(
      "Unsupported " +
        type +
        " speech settings: " +
        result.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  return result.data;
}
/** Resolve every sentence before any network call. Returned runtime is never serialized to disk. */
export function resolveSpeech(workspace, id, plan, sentence, config) {
  const speaker = sentence.speaker
    ? config?.speakers?.[sentence.speaker]
    : undefined;
  if (sentence.speaker && !speaker)
    throw new Error("Unknown speech speaker: " + sentence.speaker);
  const selected =
    sentence.provider ??
    speaker?.provider ??
    plan.provider ??
    config?.defaultProvider;
  let p;
  if (typeof selected === "string" && selected.endsWith(".mjs")) {
    p = {
      type: "custom",
      module: selected,
      dependencies: plan.providerDependencies ?? [],
    };
  } else if (selected && config && Object.hasOwn(config.providers, selected))
    p = config.providers[selected];
  else if (
    [
      "edge",
      "azure",
      ...ttsProviderIds.filter((id) => id !== "local"),
    ].includes(selected)
  )
    p = speechTemplate(selected).providers[selected];
  else
    throw new Error(
      "Configure production/speech.json or explicitly select a speech provider",
    );
  const usedVoice = sentence.voice ?? speaker?.voice ?? plan.voice ?? p.voice;
  if (usedVoice !== undefined && !voice.safeParse(usedVoice).success)
    throw new Error("Invalid speech voice");
  if (p.type !== "custom" && !usedVoice)
    throw new Error("Speech provider needs a voice");
  if (
    ["edge", "azure"].includes(p.type) &&
    !/^[a-zA-Z0-9-]{1,150}$/.test(usedVoice)
  )
    throw new Error("Invalid Microsoft voice name");
  const usedSettings = checkedSettings(p.type, {
    ...p.settings,
    ...plan.settings,
    ...speaker?.settings,
    ...sentence.settings,
  });
  const env = environment(workspace, id);
  const runtime = {
    type: p.type,
    voice: usedVoice,
    settings: usedSettings,
    timeoutMs: p.timeoutMs ?? 120000,
  };
  const required = [],
    fileHashes = [];
  const useEnv = (name) => {
    required.push({ name, configured: Boolean(env[name]) });
    return env[name];
  };
  if (ttsProviderIds.includes(p.type)) {
    const preset = ttsProviders.find((item) => item.id === p.type);
    const keyEnv = {
      openai: "OPENAI_API_KEY",
      minimax: "MINIMAX_API_KEY",
      doubao: "DOUBAO_API_KEY",
      elevenlabs: "ELEVENLABS_API_KEY",
    }[p.type];
    if (p.apiKeyEnv || keyEnv) runtime.apiKey = useEnv(p.apiKeyEnv || keyEnv);
    runtime.model = p.model || preset.model;
    const address = p.baseUrlEnv ? useEnv(p.baseUrlEnv) : preset.url;
    if (!address && !p.baseUrlEnv)
      throw new Error("This speech adapter requires baseUrlEnv");
    runtime.baseURL = address ? endpoint(address) : undefined;
    runtime.provider =
      p.type === "openai" && p.baseUrlEnv ? "compatible" : p.type;
    const { speed, ...options } = usedSettings;
    normalizeTtsInput(
      { provider: runtime.provider, model: runtime.model, voice: usedVoice },
      { text: sentence.text, voice: usedVoice, speed, options },
    );
  } else if (p.type === "azure") {
    runtime.apiKey = useEnv(p.apiKeyEnv ?? "AZURE_SPEECH_KEY");
    runtime.region = useEnv(p.regionEnv ?? "AZURE_SPEECH_REGION");
    if (runtime.region && !/^[a-z][a-z0-9-]{1,63}$/.test(runtime.region))
      throw new Error("Invalid Azure region in environment");
  } else if (p.type === "custom") {
    if (!p.module?.endsWith(".mjs"))
      throw new Error(
        "Custom speech provider needs a project-local .mjs module",
      );
    runtime.module = workspace.file(id, p.module);
    for (const file of [p.module, ...(p.dependencies ?? [])])
      fileHashes.push([
        file,
        digest(fs.readFileSync(workspace.file(id, file))),
      ]);
    // A separate environment per worker avoids leaking one project's settings into another.
    runtime.env = env;
  }
  const fingerprint = digest(
    JSON.stringify({
      implementation,
      type: p.type,
      cacheRevision: p.cacheRevision,
      packageVersion: packageInfo.dependencies[packageNames[p.type]],
      model: runtime.model,
      endpoint: runtime.baseURL,
      region: runtime.region,
      voice: usedVoice,
      settings: usedSettings,
      fileHashes,
    }),
  );
  return {
    runtime,
    fingerprint,
    provider: selected,
    type: p.type,
    voice: usedVoice,
    required,
    missing: required.filter((v) => !v.configured).map((v) => v.name),
  };
}

/** Killable worker bounds SDK sockets and custom providers, including ones ignoring AbortSignal. */
export async function runSpeechWorker(
  request,
  { signal, timeoutMs = 120000 } = {},
) {
  signal?.throwIfAborted();
  const worker = new Worker(new URL("speech-worker.mjs", import.meta.url), {
    workerData: { ...request, maxBytes: MAX_SPEECH_BYTES },
    env: request.runtime?.env ?? process.env,
    execArgv: [],
    stdout: true,
    stderr: true,
  });
  // Provider/SDK logs may contain credentials. Only our structured errors cross this boundary.
  worker.stdout.resume();
  worker.stderr.resume();
  let timer, abort;
  try {
    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        error ? reject(error) : resolve(result);
      };
      abort = () => finish(new Error("Speech synthesis cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(
        () =>
          finish(
            new Error("Speech provider timed out; no automatic retry was made"),
          ),
        timeoutMs,
      );
      worker.on("message", (value) => {
        if (value.error)
          finish(
            Object.assign(new Error(value.error), {
              code: value.code,
              statusCode: value.statusCode,
              outcome: value.outcome,
            }),
          );
        else if (
          request.action === "synthesize" &&
          (!(value.bytes instanceof Uint8Array) ||
            !value.bytes.length ||
            value.bytes.length > MAX_SPEECH_BYTES)
        )
          finish(
            new Error("Speech provider returned invalid or oversized audio"),
          );
        else finish(null, value);
      });
      worker.on("error", () =>
        finish(
          new Error(
            "Speech provider worker failed; check provider configuration",
          ),
        ),
      );
      worker.on("exit", () =>
        finish(new Error("Speech provider exited without a result")),
      );
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
export async function synthesizeSpeech(resolved, text, { signal } = {}) {
  if (typeof text !== "string" || !text.trim() || text.length > 4096)
    throw new Error(
      "Each synthesized sentence must contain 1..4096 characters",
    );
  if (resolved.missing.length)
    throw new Error(
      "Missing speech environment variables: " + resolved.missing.join(", "),
    );
  const result = await runSpeechWorker(
    { action: "synthesize", runtime: resolved.runtime, text },
    { signal, timeoutMs: resolved.runtime.timeoutMs },
  );
  return result.bytes;
}
