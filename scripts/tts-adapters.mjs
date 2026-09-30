import { randomUUID } from "node:crypto";
import {
  normalizeTtsInput,
  ttsCapabilities,
  ttsProviders,
} from "./tts-capabilities.mjs";

export const MAX_TTS_BYTES = 64 * 1024 * 1024;
export const ttsError = (code, message, statusCode = 502, extra = {}) =>
  Object.assign(new Error(message), { code, statusCode, ...extra });
const endpoint = (config, suffix) => {
  const url = new URL(config.url.replace(/\/$/, "") + suffix);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw ttsError("TTS_CONFIG", "语音服务地址无效", 400);
  return url.href;
};
const bearer = (c) => (c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {});
function markedText(input) {
  let text = input.text;
  for (const p of [...(input.options.pauses || [])].sort(
    (a, b) => b.after - a.after,
  )) {
    const mark =
      input.provider === "minimax"
        ? `<#${p.seconds.toFixed(2)}#>`
        : `<break time="${p.seconds}s" />`;
    text = text.slice(0, p.after) + mark + text.slice(p.after);
  }
  return text;
}
// Returns private transport data; callers must never log or persist this object.
export function buildTtsRequest(config, input) {
  if (
    typeof input.text !== "string" ||
    !input.text.trim() ||
    input.text.length > 4096
  )
    throw ttsError("TTS_TEXT", "语音文本必须为 1–4096 字符", 400);
  const n = normalizeTtsInput(config, input),
    o = n.options;
  const headers = { "Content-Type": "application/json" };
  let url,
    body,
    encoding = "audio";
  if (["compatible", "local", "openai", "qwen3"].includes(n.provider)) {
    url = endpoint(config, "/audio/speech");
    Object.assign(headers, bearer(config));
    body = {
      model: n.model,
      voice: n.voice,
      input: n.text,
      response_format: "wav",
      ...(n.provider !== "qwen3" ? { speed: n.speed } : {}),
    };
    if (o.instructions) body.instructions = o.instructions;
    if (o.language) body.language = o.language; // Our optional Qwen bridge contract.
  } else if (n.provider === "minimax") {
    url = endpoint(config, "/t2a_v2");
    Object.assign(headers, bearer(config));
    encoding = "hex-json";
    body = {
      model: n.model,
      text: markedText(n),
      stream: false,
      output_format: "hex",
      voice_setting: {
        voice_id: n.voice,
        speed: n.speed,
        ...(o.pitch !== undefined ? { pitch: o.pitch } : {}),
        ...(o.emotion ? { emotion: o.emotion } : {}),
      },
      audio_setting: { format: "wav", sample_rate: 32000, channel: 1 },
      ...(o.language ? { language_boost: o.language } : {}),
      ...(o.pronunciation?.length
        ? {
            pronunciation_dict: {
              tone: o.pronunciation.map((p) => `${p.word}/${p.phonetic}`),
            },
          }
        : {}),
    };
  } else if (n.provider === "elevenlabs") {
    url = endpoint(
      config,
      `/text-to-speech/${encodeURIComponent(n.voice)}?output_format=mp3_44100_128`,
    );
    if (config.apiKey) headers["xi-api-key"] = config.apiKey;
    body = {
      model_id: n.model,
      text: markedText(n),
      voice_settings: {
        ...(["eleven_v4", "eleven_v4_turbo"].includes(n.model)
          ? {}
          : { speed: n.speed }),
        ...(o.stability !== undefined ? { stability: o.stability } : {}),
        ...(o.similarity !== undefined
          ? { similarity_boost: o.similarity }
          : {}),
        ...(o.style !== undefined ? { style: o.style } : {}),
      },
      ...(o.dictionaries?.length
        ? {
            pronunciation_dictionary_locators: o.dictionaries.map((p) => ({
              pronunciation_dictionary_id: p.id,
              version_id: p.version,
            })),
          }
        : {}),
      ...(o.previousText ? { previous_text: o.previousText } : {}),
      ...(o.nextText ? { next_text: o.nextText } : {}),
    };
  } else if (n.provider === "doubao") {
    url = endpoint(config, "/api/v3/tts/unidirectional/sse");
    encoding = "sse-base64";
    Object.assign(headers, {
      "X-Api-Key": config.apiKey || "",
      "X-Api-Resource-Id": n.model,
      "X-Api-Request-Id": randomUUID(),
    });
    body = {
      user: { uid: "frame-studio" },
      req_params: {
        text: n.text,
        speaker: n.voice,
        sample_rate: 24000,
        audio_params: {
          format: "mp3",
          bit_rate: 128000,
          speech_rate: Math.round((n.speed - 1) * 100),
        },
        additions: JSON.stringify({
          ...(o.instructions ? { context_texts: [o.instructions] } : {}),
          ...(o.pitch !== undefined
            ? { post_process: { pitch: o.pitch } }
            : {}),
        }),
      },
    };
  } else throw ttsError("TTS_PROVIDER", "未知语音提供商", 400);
  return { url, headers, body, encoding, normalized: n };
}
async function readBounded(response, limit, signal, onProgress) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw ttsError("TTS_LIMIT", "语音结果超过大小限制", 413);
  }
  const chunks = [];
  let bytes = 0;
  if (!response.body) throw ttsError("TTS_EMPTY", "语音服务返回空响应");
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      bytes += chunk.length;
      if (bytes > limit)
        throw ttsError("TTS_LIMIT", "语音结果超过大小限制", 413);
      chunks.push(Buffer.from(chunk));
      onProgress?.({ phase: "receiving", receivedBytes: bytes });
    }
  } catch (error) {
    await response.body.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks);
}
function serviceCode(code, provider) {
  const auth = [1004, 45000010, 45000011].includes(code),
    limited = [1002, 1039, 45000030].includes(code);
  return ttsError(
    auth ? "TTS_AUTH" : limited ? "TTS_RATE_LIMIT" : "TTS_PROVIDER_ERROR",
    `${provider} 服务拒绝请求（代码 ${Number.isFinite(code) ? code : "未知"}），请检查账号权限、模型与音色`,
    auth ? 401 : limited ? 429 : 502,
    { outcome: "rejected" },
  );
}
function audioResult(bytes) {
  const wav =
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WAVE";
  const mp3 =
    bytes.subarray(0, 3).toString() === "ID3" ||
    (bytes[0] === 255 && (bytes[1] & 224) === 224);
  if (!bytes.length || (!wav && !mp3))
    throw ttsError("TTS_INVALID_AUDIO", "引擎没有返回有效的 WAV 或 MP3 音频");
  return {
    bytes,
    ext: wav ? "wav" : "mp3",
    mime: wav ? "audio/wav" : "audio/mpeg",
  };
}
async function readDoubao(response, signal, onProgress, maxBytes) {
  const chunks = [];
  let received = 0,
    wire = 0,
    pending = "",
    done = false;
  const decoder = new TextDecoder();
  const line = (value) => {
    if (!value.startsWith("data:")) return;
    let message;
    try {
      message = JSON.parse(value.slice(5).trim());
    } catch {
      throw ttsError("TTS_PROTOCOL", "豆包返回无效 SSE 数据");
    }
    if (message.code !== 0 && message.code !== 20000000)
      throw serviceCode(message.code, "doubao");
    if (message.code === 20000000) done = true;
    if (message.data) {
      if (
        typeof message.data !== "string" ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)
      )
        throw ttsError("TTS_PROTOCOL", "豆包返回无效音频编码");
      const b = Buffer.from(message.data, "base64");
      received += b.length;
      if (received > maxBytes)
        throw ttsError("TTS_LIMIT", "语音结果超过大小限制", 413);
      chunks.push(b);
      onProgress?.({ phase: "receiving", receivedBytes: received });
    }
  };
  if (!response.body) throw ttsError("TTS_EMPTY", "豆包返回空响应");
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      wire += chunk.length;
      if (wire > maxBytes * 2 + 1024 * 1024)
        throw ttsError("TTS_LIMIT", "语音响应超过大小限制", 413);
      pending += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, nl).replace(/\r$/, ""));
        pending = pending.slice(nl + 1);
      }
      if (pending.length > maxBytes * 2)
        throw ttsError("TTS_LIMIT", "SSE 数据超过大小限制", 413);
    }
    pending += decoder.decode();
    if (pending.trim()) line(pending);
    if (!done)
      throw ttsError(
        "TTS_INCOMPLETE",
        "豆包音频流提前结束，请检查结果后手动重试",
      );
  } catch (error) {
    await response.body.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks);
}
export async function synthesizeTts(
  config,
  input,
  { signal, onProgress, fetchImpl = fetch, maxBytes = MAX_TTS_BYTES } = {},
) {
  const request = buildTtsRequest(config, input);
  const combined = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(config.timeoutMs || 180000),
  ]);
  try {
    combined.throwIfAborted();
    onProgress?.({ phase: "connecting", receivedBytes: 0 });
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: combined,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      const status = [400, 401, 403, 429].includes(response.status)
        ? response.status
        : 502;
      throw ttsError(
        response.status === 429
          ? "TTS_RATE_LIMIT"
          : [401, 403].includes(response.status)
            ? "TTS_AUTH"
            : "TTS_HTTP",
        `语音引擎返回 HTTP ${response.status}，请检查配置后手动重试`,
        status,
        {
          outcome: "rejected",
          retryAfter:
            response.status === 429
              ? Math.min(
                  60,
                  Math.max(1, Number(response.headers.get("retry-after")) || 5),
                )
              : undefined,
        },
      );
    }
    let bytes;
    if (request.encoding === "sse-base64")
      bytes = await readDoubao(response, combined, onProgress, maxBytes);
    else {
      bytes = await readBounded(
        response,
        request.encoding === "hex-json" ? maxBytes * 2 + 1024 * 1024 : maxBytes,
        combined,
        onProgress,
      );
      if (request.encoding === "hex-json") {
        let value;
        try {
          value = JSON.parse(bytes.toString());
        } catch {
          throw ttsError("TTS_PROTOCOL", "MiniMax 返回无效 JSON");
        }
        if (value.base_resp?.status_code !== 0)
          throw serviceCode(value.base_resp?.status_code, "minimax");
        const audio = value.data?.audio;
        if (typeof audio !== "string" || !/^(?:[a-fA-F0-9]{2})+$/.test(audio))
          throw ttsError("TTS_PROTOCOL", "MiniMax 返回无效音频编码");
        if (audio.length / 2 > maxBytes)
          throw ttsError("TTS_LIMIT", "语音结果超过大小限制", 413);
        bytes = Buffer.from(audio, "hex");
      }
    }
    combined.throwIfAborted();
    onProgress?.({ phase: "validating", receivedBytes: bytes.length });
    const audio = audioResult(bytes),
      { provider, model, voice, speed, options, warnings } = request.normalized;
    return {
      ...audio,
      applied: { provider, model, voice, speed, options },
      warnings,
    };
  } catch (error) {
    if (signal?.aborted)
      throw ttsError(
        "TTS_CANCELLED",
        "语音合成已取消；已发出的请求仍可能计费",
        409,
        { outcome: "unknown" },
      );
    if (combined.aborted)
      throw ttsError(
        "TTS_TIMEOUT",
        "语音合成超时，结果未知，请检查后再重试",
        504,
        { outcome: "unknown" },
      );
    if (error.code?.startsWith("TTS_")) throw error;
    throw ttsError(
      "TTS_CONNECTION",
      "语音连接或响应中断，结果未知，请检查服务后再重试",
      502,
      { outcome: "unknown" },
    );
  }
}
export async function discoverTts(
  config,
  { fetchImpl = fetch, signal, cursor, search = "" } = {},
) {
  const provider = config.provider || "compatible",
    capabilities = ttsCapabilities(provider, config.model, config.voice);
  const documented = {
    source: "documented",
    voices: capabilities.voices,
    models: (ttsProviders.find((p) => p.id === provider)?.models || []).map(
      (id) => ({
        id,
        source: "documented",
        capabilities: ttsCapabilities(provider, id, config.voice),
      }),
    ),
    nextCursor: null,
  };
  if (!["minimax", "elevenlabs", "qwen3"].includes(provider))
    return {
      ...documented,
      source: capabilities.voices.length ? "documented" : "manual",
      hint: capabilities.voices.length
        ? "官方模型音色目录；尚未实际合成验证"
        : "服务无已核实目录协议，请填写服务文档中的模型和音色 ID",
    };
  const combined = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(30000),
  ]);
  const headers = {
    "Content-Type": "application/json",
    ...(provider === "elevenlabs"
      ? config.apiKey
        ? { "xi-api-key": config.apiKey }
        : {}
      : bearer(config)),
  };
  const read = async (suffix, body, base = config) => {
    // Only metadata operations are safe to retry, and only after explicit 429/503 rejection.
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await fetchImpl(endpoint(base, suffix), {
          method: body ? "POST" : "GET",
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: combined,
          redirect: "error",
        });
      } catch {
        throw ttsError("TTS_DISCOVERY", "目录连接失败或超时，请检查配置后重试");
      }
      if ([429, 503].includes(response.status) && attempt === 0) {
        await response.body?.cancel();
        const delay = Math.min(
          5000,
          Math.max(
            100,
            (Number(response.headers.get("retry-after")) || 1) * 1000,
          ),
        );
        await new Promise((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(ttsError("TTS_CANCELLED", "目录请求已取消", 409));
          };
          const timer = setTimeout(() => {
            combined.removeEventListener("abort", abort);
            resolve();
          }, delay);
          combined.addEventListener("abort", abort, { once: true });
          if (combined.aborted) abort();
        });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw ttsError(
          "TTS_DISCOVERY",
          `音色目录返回 HTTP ${response.status}`,
          [401, 403, 429].includes(response.status) ? response.status : 502,
        );
      }
      const bytes = await readBounded(response, 2 * 1024 * 1024, combined);
      try {
        return JSON.parse(bytes.toString());
      } catch {
        throw ttsError("TTS_DISCOVERY", "语音目录格式无效");
      }
    }
  };
  if (provider === "minimax") {
    const value = await read("/get_voice", { voice_type: "system" });
    if (value.base_resp?.status_code !== 0)
      throw serviceCode(value.base_resp?.status_code, provider);
    return {
      source: "live",
      models: documented.models,
      voices: (value.system_voice || []).map((v) => ({
        id: v.voice_id,
        name: v.voice_name || v.voice_id,
        description: (v.description || []).join(" "),
      })),
      nextCursor: null,
    };
  }
  if (provider === "elevenlabs") {
    const qs = new URLSearchParams({
      page_size: "100",
      ...(cursor ? { next_page_token: cursor } : {}),
      ...(search ? { search } : {}),
    });
    const voicesBase = {
      ...config,
      url: config.url.replace(/\/v1\/?$/, "/v2"),
    };
    const [value, models] = await Promise.all([
      read("/voices?" + qs, undefined, voicesBase),
      read("/models"),
    ]);
    return {
      source: "live",
      voices: (value.voices || []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        description: v.description,
        labels: v.labels,
      })),
      models: models
        .filter((m) => m.can_do_text_to_speech)
        .map((m) => ({
          id: m.model_id,
          name: m.name,
          languages: m.languages?.map((l) => l.language_id),
          capabilities: ttsCapabilities(provider, m.model_id, config.voice),
        })),
      nextCursor: value.has_more ? value.next_page_token : null,
    };
  }
  const value = await read("/voices");
  if (!Array.isArray(value.voices))
    throw ttsError("TTS_DISCOVERY", "Qwen bridge 音色目录格式无效");
  return {
    source: "live",
    voices: value.voices.map((v) => ({ id: v.id, name: v.name || v.id })),
    models: value.models || [],
    nextCursor: null,
  };
}
