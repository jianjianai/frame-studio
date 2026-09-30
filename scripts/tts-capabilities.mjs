import { z } from "zod";

// Shared by browser, project workers and platform transports. No credentials here.
export const ttsProviderIds = [
  "compatible",
  "local",
  "openai",
  "minimax",
  "doubao",
  "elevenlabs",
  "qwen3",
];
export const ttsOptionsSchema = z.strictObject({
  language: z.string().min(1).max(60).optional(),
  instructions: z.string().trim().min(1).max(2000).optional(),
  emotion: z.string().min(1).max(40).optional(),
  pitch: z.number().int().min(-12).max(12).optional(),
  pronunciation: z
    .array(
      z.strictObject({
        word: z.string().min(1).max(100),
        phonetic: z.string().min(1).max(200),
      }),
    )
    .max(100)
    .optional(),
  pauses: z
    .array(
      z.strictObject({
        after: z.number().int().positive(),
        seconds: z.number().min(0.01).max(99.99),
      }),
    )
    .max(100)
    .optional(),
  stability: z.number().min(0).max(1).optional(),
  similarity: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  dictionaries: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        version: z.string().min(1).max(200),
      }),
    )
    .max(3)
    .optional(),
  previousText: z.string().max(4000).optional(),
  nextText: z.string().max(4000).optional(),
});
export const speechInputShape = {
  engine: z.string().uuid(),
  text: z
    .string()
    .min(1)
    .max(4000)
    .refine((v) => !!v.trim(), "Speech text is empty"),
  voice: z.string().min(1).max(150).optional(),
  speed: z.number().min(0.25).max(4).optional(),
  options: ttsOptionsSchema.optional(),
  fallback: z.enum(["error", "omit"]).default("error"),
  requestId: z.string().uuid().optional(),
};
const currentVoices = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
];
const oldVoices = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
];
export const ttsProviders = [
  {
    id: "compatible",
    name: "OpenAI-compatible",
    url: "",
    model: "",
    voice: "",
    models: [],
    note: "仅基础 Speech 协议；扩展表达能力未经确认。",
  },
  {
    id: "openai",
    name: "OpenAI",
    url: "https://api.openai.com/v1",
    model: "gpt-4o-mini-tts",
    voice: "cedar",
    models: [
      "gpt-4o-mini-tts",
      "gpt-4o-mini-tts-2025-12-15",
      "gpt-4o-mini-tts-2025-03-20",
      "tts-1-hd",
      "tts-1",
    ],
    docs: "https://developers.openai.com/api/docs/guides/text-to-speech",
    note: "指令仅适用于 mini-tts；中文可用，音色主要针对英语优化。",
  },
  {
    id: "minimax",
    name: "MiniMax",
    url: "https://api.minimax.cn/v1",
    model: "speech-2.8-hd",
    voice: "male-qn-qingse",
    models: [
      "speech-2.8-hd",
      "speech-2.8-turbo",
      "speech-2.6-hd",
      "speech-2.6-turbo",
      "speech-02-hd",
      "speech-02-turbo",
      "speech-01-hd",
      "speech-01-turbo",
    ],
    docs: "https://platform.minimax.cn/docs/api-reference/speech-t2a-http",
    note: "中文、情感、拼音字典及显式停顿。音色权限和计费以账号为准。",
  },
  {
    id: "doubao",
    name: "豆包语音",
    url: "https://openspeech.bytedance.com",
    model: "seed-tts-2.0",
    voice: "zh_female_vv_uranus_bigtts",
    models: ["seed-tts-2.0", "seed-tts-1.0"],
    docs: "https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh",
    note: "model 是资源 ID；2.0 语音指令只用于获授权的 2.0 系统音色，不支持复刻音色。",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    url: "https://api.elevenlabs.io/v1",
    model: "eleven_multilingual_v2",
    voice: "",
    models: [
      "eleven_multilingual_v2",
      "eleven_v3",
      "eleven_v4",
      "eleven_v4_turbo",
      "eleven_flash_v2_5",
      "eleven_turbo_v2_5",
    ],
    docs: "https://elevenlabs.io/docs/api-reference/text-to-speech/convert",
    note: "从账号发现音色。v3/v4 用正文音频标签表达；不接受 OpenAI 指令或 SSML 停顿。",
  },
  {
    id: "qwen3",
    name: "Qwen3-TTS 自托管（Frame bridge）",
    url: "",
    model: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    voice: "Vivian",
    models: [
      "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
      "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    ],
    docs: "https://github.com/QwenLM/Qwen3-TTS",
    note: "可选独立 bridge，无平台模型依赖；仅 1.7B CustomVoice 开启指令。",
  },
];
const minimaxLanguages = [
  "auto",
  "Chinese",
  "Chinese,Yue",
  "English",
  "Arabic",
  "Russian",
  "Spanish",
  "French",
  "Portuguese",
  "German",
  "Turkish",
  "Dutch",
  "Ukrainian",
  "Vietnamese",
  "Indonesian",
  "Japanese",
  "Italian",
  "Korean",
  "Thai",
  "Polish",
  "Romanian",
  "Greek",
  "Czech",
  "Finnish",
  "Hindi",
  "Bulgarian",
  "Danish",
  "Hebrew",
  "Malay",
  "Persian",
  "Slovak",
  "Swedish",
  "Croatian",
  "Filipino",
  "Hungarian",
  "Norwegian",
  "Slovenian",
  "Catalan",
  "Nynorsk",
  "Tamil",
  "Afrikaans",
];
const field = (kind, extra = {}) => ({ kind, ...extra });
export function ttsCapabilities(
  provider = "compatible",
  model = "",
  voice = "",
) {
  const fields = {},
    speed = { min: 1, max: 1, default: 1 };
  let voices = [],
    textHints = "使用自然标点和换行；不承诺精确停顿或情感。";
  if (["compatible", "local"].includes(provider)) {
    speed.min = 0.5;
    speed.max = 2;
  }
  if (provider === "openai") {
    if (ttsProviders.find((p) => p.id === "openai").models.includes(model)) {
      speed.min = 0.25;
      speed.max = 4;
    }
    const modern = [
      "gpt-4o-mini-tts",
      "gpt-4o-mini-tts-2025-12-15",
      "gpt-4o-mini-tts-2025-03-20",
    ].includes(model);
    voices = (
      modern
        ? currentVoices
        : ["tts-1", "tts-1-hd"].includes(model)
          ? oldVoices
          : []
    ).map((id) => ({ id, name: id }));
    if (modern)
      fields.instructions = field("text", {
        maxLength: 2000,
        hint: "描述普通话、节奏、重音、情感；模型尽力执行，非精确声学控制。",
      });
  } else if (
    provider === "minimax" &&
    ttsProviders.find((p) => p.id === provider).models.includes(model)
  ) {
    speed.min = 0.5;
    speed.max = 2;
    fields.language = field("enum", {
      values: minimaxLanguages.filter(
        (l) =>
          !/speech-0[12]-/.test(model) ||
          !["Persian", "Filipino", "Tamil"].includes(l),
      ),
    });
    fields.emotion = field("enum", {
      values: [
        "happy",
        "sad",
        "angry",
        "fearful",
        "disgusted",
        "surprised",
        "calm",
        ...(/^speech-2\.6-/.test(model) ? ["fluent", "whisper"] : []),
      ],
    });
    fields.pitch = field("number", { min: -12, max: 12, default: 0 });
    fields.pronunciation = field("word-phonetic", {
      hint: "中文带调拼音，例如：重庆/(chong2)(qing4)。",
    });
    fields.pauses = field("offset-seconds", {
      min: 0.01,
      max: 99.99,
      hint: "after 为原文 UTF-16 偏移；只能放在两段可发音文本之间。",
    });
    textHints = /speech-2\.8-/.test(model)
      ? "支持 (breath)、(sighs) 等原生语气词；仅在需要时写入正文。"
      : "支持拼音发音替换与显式停顿。";
  } else if (
    provider === "doubao" &&
    ["seed-tts-2.0", "seed-tts-1.0"].includes(model)
  ) {
    speed.min = 0.5;
    speed.max = 2;
    fields.pitch = field("number", { min: -12, max: 12, default: 0 });
    if (model === "seed-tts-2.0" && voice === "zh_female_vv_uranus_bigtts")
      fields.instructions = field("text", {
        hint: "已核实的 2.0 系统音色指令；其他音色暂不暴露指令，避免误报支持。",
      });
    textHints =
      "普通话旁白可用获授权的 2.0 音色。显式发音和精确停顿本适配器暂不暴露。";
  } else if (
    provider === "elevenlabs" &&
    ttsProviders.find((p) => p.id === provider).models.includes(model)
  ) {
    speed.min = 0.7;
    speed.max = 1.2;
    const v4 = ["eleven_v4", "eleven_v4_turbo"].includes(model);
    const expressive = v4 || model === "eleven_v3";
    if (v4) {
      speed.min = 1;
      speed.max = 1;
      fields.similarity = field("number", { min: 0, max: 1 });
    }
    fields.stability =
      model === "eleven_v3"
        ? field("enum-number", { values: [0, 0.5, 1] })
        : field("number", { min: 0, max: 1 });
    if (!expressive) {
      fields.similarity = field("number", { min: 0, max: 1 });
      fields.style = field("number", { min: 0, max: 1 });
      fields.pauses = field("offset-seconds", { min: 0.01, max: 3 });
      fields.previousText = field("text");
      fields.nextText = field("text");
      fields.dictionaries = field("dictionary-locators", {
        hint: "只引用已有字典 id/version，最多 3 个；中文使用 alias 规则。",
      });
    }
    textHints = expressive
      ? "正文可用 [whispers]、[sighs] 等音频标签；效果取决于音色，不支持 SSML break。"
      : "中文长旁白优先试听 multilingual_v2；可带前后文避免分段语气突变。";
  } else if (provider === "qwen3") {
    speed.min = 1;
    speed.max = 1;
    if (ttsProviders.find((p) => p.id === "qwen3").models.includes(model)) {
      fields.language = field("enum", {
        values: [
          "Auto",
          "Chinese",
          "English",
          "Japanese",
          "Korean",
          "German",
          "French",
          "Russian",
          "Portuguese",
          "Spanish",
          "Italian",
        ],
      });
      if (model.includes("1.7B")) fields.instructions = field("text");
    }
  }
  return {
    schemaVersion: 1,
    provider,
    model,
    fields,
    speed,
    voices,
    languages: {
      mode: fields.language ? "hint" : "automatic",
      known: ttsProviders.find((p) => p.id === provider)?.models.includes(model)
        ? ["zh", "en"]
        : [],
      complete: false,
    },
    maxTextLength: 4096,
    voiceDiscovery: ["minimax", "elevenlabs", "qwen3"].includes(provider)
      ? "live"
      : voices.length
        ? "documented"
        : "manual",
    textHints,
    fallback: ["error", "omit"],
  };
}
export function normalizeTtsInput(config, input) {
  const provider = config.provider || "compatible",
    voice = input.voice || config.voice;
  const capabilities = ttsCapabilities(provider, config.model, voice);
  const options = ttsOptionsSchema.parse(input.options || {}),
    warnings = [];
  const omit = (name, reason) => {
    if (input.fallback !== "omit")
      throw Object.assign(new Error(`语音能力不支持 ${name}：${reason}`), {
        code: "TTS_CAPABILITY",
        statusCode: 400,
      });
    warnings.push({ field: name, reason });
    delete options[name];
  };
  for (const [name, value] of Object.entries(options)) {
    const f = capabilities.fields[name];
    if (!f) omit(name, `${provider}/${config.model}`);
    else if (f.values && !f.values.includes(value))
      omit(name, "值不在模型允许范围内");
    else if (typeof value === "number" && (value < f.min || value > f.max))
      omit(name, "超出能力范围");
    else if (name === "pauses" && value.some((p) => p.seconds > f.max))
      omit(name, "停顿超过模型上限");
  }
  let speed = input.speed ?? 1;
  if (speed < capabilities.speed.min || speed > capabilities.speed.max) {
    if (input.fallback !== "omit")
      throw Object.assign(
        new Error(
          `语速范围 ${capabilities.speed.min}–${capabilities.speed.max}`,
        ),
        { code: "TTS_CAPABILITY", statusCode: 400 },
      );
    warnings.push({ field: "speed", reason: "不支持所选语速，回到 1×" });
    speed = 1;
  }
  if (
    !voice ||
    (capabilities.voices.length &&
      !capabilities.voices.some((v) => v.id === voice))
  )
    throw Object.assign(new Error("该模型不支持所选音色"), {
      statusCode: 400,
      code: "TTS_VOICE",
    });
  if (options.pauses && input.text !== undefined) {
    const offsets = new Set();
    for (const p of options.pauses) {
      const surrogate =
        /[\uD800-\uDBFF]/.test(input.text[p.after - 1] || "") &&
        /[\uDC00-\uDFFF]/.test(input.text[p.after] || "");
      if (
        offsets.has(p.after) ||
        p.after >= input.text.length ||
        surrogate ||
        !input.text.slice(0, p.after).trim() ||
        !input.text.slice(p.after).trim()
      )
        throw Object.assign(new Error("停顿偏移重复、越界或拆分了字符"), {
          code: "TTS_PAUSE",
          statusCode: 400,
        });
      offsets.add(p.after);
    }
  }
  return {
    provider,
    model: config.model,
    voice,
    speed,
    text: input.text,
    options,
    warnings,
    capabilities,
  };
}
