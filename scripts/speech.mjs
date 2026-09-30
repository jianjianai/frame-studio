import fs from "node:fs";
import { createHash } from "node:crypto";
import { ttsProviderIds, ttsCapabilities } from "./tts-capabilities.mjs";
import {
  readSpeechConfig,
  resolveSpeech,
  speechTemplate,
  speechProviders,
  runSpeechWorker,
  SPEECH_CONFIG,
} from "./speech-providers.mjs";

export function speechStatus(workspace, id) {
  const config = readSpeechConfig(workspace, id, SPEECH_CONFIG, true);
  if (!config)
    return {
      configured: false,
      configPath: SPEECH_CONFIG,
      providers: speechProviders(),
      nextAction: `pnpm film speech ${id} init --provider edge`,
    };
  const providers = Object.entries(config.providers).map(([name, p]) => {
    try {
      const result = resolveSpeech(
        workspace,
        id,
        { provider: name },
        {},
        config,
      );
      return {
        name,
        type: p.type,
        voice: result.voice,
        model: result.runtime.model,
        capabilities: ttsProviderIds.includes(result.type)
          ? ttsCapabilities(
              result.runtime.provider,
              result.runtime.model,
              result.voice,
            )
          : undefined,
        ready: !result.missing.length,
        environment: result.required,
      };
    } catch (error) {
      return {
        name,
        type: p.type,
        ready: false,
        error:
          error.code === "ENOENT"
            ? "Project provider module or dependency is missing"
            : error.message,
      };
    }
  });
  return {
    configured: true,
    configPath: SPEECH_CONFIG,
    defaultProvider: config.defaultProvider,
    providers,
    speakers: config.speakers,
    readiness: "Local configuration only; online synthesis has not been tested",
  };
}
export function initSpeech(workspace, id, { provider = "edge", voice } = {}) {
  workspace.writable();
  workspace.project(id);
  const config = speechTemplate(provider, voice);
  const changes = [
    {
      path: SPEECH_CONFIG,
      content: JSON.stringify(config, null, 2) + "\n",
      expectedSha256: null,
    },
    {
      path: "production/narration.example.json",
      content:
        JSON.stringify(
          {
            mode: "sequential",
            gap: 0.25,
            sentences: [
              {
                id: "intro",
                speaker: "narrator",
                text: "你好，这是本项目的语音试听。",
              },
            ],
          },
          null,
          2,
        ) + "\n",
      expectedSha256: null,
    },
  ];
  if (provider === "custom")
    changes.push({
      path: "scripts/narration-provider.mjs",
      expectedSha256: null,
      content:
        "// Trusted project code. Read credentials from process.env, never hardcode them.\nexport async function synthesize({ text, voice, settings, signal }) {\n  signal?.throwIfAborted();\n  throw new Error('Implement this project provider and return WAV Uint8Array');\n}\n",
    });
  const edited = workspace.edit(id, changes);
  return {
    ...edited,
    configPath: SPEECH_CONFIG,
    provider,
    nextAction: `pnpm film speech ${id} status --json; pnpm film narrate ${id} --input production/narration.example.json`,
  };
}
export async function listSpeechVoices(
  workspace,
  id,
  { provider, locale, limit = 100, offset = 0, signal, cursor, search } = {},
) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    (locale && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,2}$/.test(locale)) ||
    (cursor !== undefined &&
      (typeof cursor !== "string" || cursor.length > 500)) ||
    (search !== undefined &&
      (typeof search !== "string" || search.length > 200))
  )
    throw new Error("Invalid voice filter or pagination");
  const config = readSpeechConfig(workspace, id, SPEECH_CONFIG, true);
  const selected = resolveSpeech(
    workspace,
    id,
    { provider: provider ?? config?.defaultProvider },
    {},
    config,
  );
  let voices, source, catalog;
  if (selected.type === "custom")
    return {
      provider: selected.provider,
      voices: [],
      source: "project-defined",
      nextAction: "Use the voices documented by the project's custom adapter",
    };
  if (selected.type === "openai" && selected.runtime.provider === "openai") {
    voices = ttsCapabilities(
      "openai",
      selected.runtime.model,
      selected.voice,
    ).voices;
    source = "documented; not live provider verification";
  } else {
    if (selected.missing.length)
      throw new Error(
        "Missing speech environment variables: " + selected.missing.join(", "),
      );
    catalog = await runSpeechWorker(
      { action: "voices", runtime: selected.runtime, locale, cursor, search },
      { signal, timeoutMs: 30000 },
    );
    voices = catalog.voices;
    source = catalog.source || "live-provider";
  }
  if (locale && ["edge", "azure"].includes(selected.type))
    voices = voices.filter((v) =>
      v.locale?.toLowerCase().startsWith(locale.toLowerCase()),
    );
  voices.sort((a, b) => a.id.localeCompare(b.id));
  return {
    provider: selected.provider,
    source,
    models: catalog?.models || [],
    nextCursor: catalog?.nextCursor || null,
    ...(catalog?.hint ? { hint: catalog.hint } : {}),
    ...(locale && !["edge", "azure"].includes(selected.type)
      ? { warning: "该目录没有完整音色语言元数据，未按 locale 过滤" }
      : {}),
    total: voices.length,
    voices: voices.slice(offset, offset + limit),
    nextOffset: offset + limit < voices.length ? offset + limit : null,
  };
}
export function speechSamplePlan({
  text,
  provider,
  speaker,
  voice,
  speed,
  instructions,
  emotion,
  language,
  pitch,
  options,
}) {
  if (typeof text !== "string" || !text.trim() || text.length > 4096)
    throw new Error("Use --text with 1..4096 characters");
  return {
    mode: "sequential",
    settings: {
      ...(options
        ? typeof options === "string"
          ? JSON.parse(options)
          : options
        : {}),
      ...(speed !== undefined ? { speed: Number(speed) } : {}),
      ...(instructions ? { instructions } : {}),
      ...(emotion ? { emotion } : {}),
      ...(language ? { language } : {}),
      ...(pitch !== undefined ? { pitch: Number(pitch) } : {}),
    },
    ...(provider ? { provider } : {}),
    sentences: [
      {
        id: "sample",
        text,
        ...(speaker ? { speaker } : {}),
        ...(voice ? { voice } : {}),
      },
    ],
  };
}
export function describeSpeech(workspace, id, version, name = "voice.wav") {
  workspace.project(id);
  if (
    !/^[a-f0-9]{64}$/.test(version) ||
    !["voice.wav", "captions.srt", "timeline.json"].includes(name)
  )
    throw new Error("Invalid speech artifact");
  const relative = `public/narration/${version}/${name}`;
  const file = workspace.file(id, relative);
  const manifest = workspace.file(
    id,
    `public/narration/${version}/timeline.json`,
  );
  if (fs.statSync(manifest).size > 2 * 1024 * 1024)
    throw new Error("Speech manifest is too large");
  const metadata = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (metadata.version !== version) throw new Error("Speech version mismatch");
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 700 * 1024 * 1024)
    throw new Error("Invalid speech artifact size");
  return {
    project: id,
    version,
    name,
    path: file,
    relativePath: relative,
    bytes: stat.size,
    mimeType: name.endsWith(".wav")
      ? "audio/wav"
      : name.endsWith(".json")
        ? "application/json"
        : "text/plain",
    duration: metadata.duration,
  };
}
export function readSpeech(
  workspace,
  id,
  version,
  { name = "voice.wav", inlineAudio = false } = {},
) {
  const description = describeSpeech(workspace, id, version, name);
  if (name === "voice.wav" && !inlineAudio) return { description };
  if (description.bytes > (name === "voice.wav" ? 6 : 2) * 1024 * 1024)
    throw new Error(
      "Speech artifact is too large to inline; use authenticated download or generate a shorter sample",
    );
  const data = fs.readFileSync(description.path);
  return {
    description: {
      ...description,
      sha256: createHash("sha256").update(data).digest("hex"),
    },
    data,
  };
}
