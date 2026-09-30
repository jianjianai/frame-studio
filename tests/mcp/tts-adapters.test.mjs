import test from "node:test";
import assert from "node:assert/strict";
import {
  ttsCapabilities,
  normalizeTtsInput,
  speechInputShape,
} from "../../scripts/tts-capabilities.mjs";
import {
  buildTtsRequest,
  synthesizeTts,
  discoverTts,
} from "../../scripts/tts-adapters.mjs";
import { z } from "zod";
const config = (provider, model, voice = "voice") => ({
  provider,
  model,
  voice,
  url: "https://speech.test/v1",
  apiKey: "fixture-secret-only",
});
const input = { text: "重庆，新的旅程开始。", speed: 1 };
const wave = () => {
  const b = Buffer.alloc(46);
  b.write("RIFF");
  b.writeUInt32LE(38, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(2, 40);
  return b;
};

test("legacy schema retains text/voice/speed, rejects unknown or secret options", () => {
  const schema = z.strictObject(speechInputShape);
  const v = schema.parse({
    engine: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    text: "中文",
    voice: "v",
    speed: 1.2,
  });
  assert.equal(v.fallback, "error");
  assert.equal(v.options, undefined);
  assert.throws(
    () => schema.parse({ ...v, options: { apiKey: "no" } }),
    /Unrecognized/,
  );
  assert.throws(() => schema.parse({ ...v, text: "  " }));
});
test("compatible mapping keeps the original HTTP contract, no fabricated instructions", () => {
  const c = config("compatible", "private-model");
  const r = buildTtsRequest(c, input);
  assert.deepEqual(r.body, {
    model: "private-model",
    voice: "voice",
    input: input.text,
    speed: 1,
    response_format: "wav",
  });
  assert.throws(
    () =>
      buildTtsRequest(c, { ...input, options: { instructions: "电影旁白" } }),
    /不支持/,
  );
  const n = normalizeTtsInput(c, {
    ...input,
    options: { instructions: "电影旁白" },
    fallback: "omit",
  });
  assert.deepEqual(n.options, {});
  assert.equal(n.warnings[0].field, "instructions");
});
test("OpenAI capability varies by model, mapped instructions stay out of spoken input", () => {
  const c = config("openai", "gpt-4o-mini-tts", "cedar");
  const r = buildTtsRequest(c, {
    ...input,
    options: { instructions: "克制的普通话电影旁白" },
  });
  assert.equal(r.body.instructions, "克制的普通话电影旁白");
  assert.equal(r.body.input, input.text);
  assert(!ttsCapabilities("openai", "tts-1-hd").fields.instructions);
  assert.throws(
    () => buildTtsRequest(config("openai", "tts-1", "cedar"), input),
    /音色/,
  );
  assert.throws(
    () => buildTtsRequest(c, { ...input, options: { emotion: "calm" } }),
    /不支持/,
  );
});
test("MiniMax maps Chinese boost, native emotion, pinyin and original offsets exactly", () => {
  const r = buildTtsRequest(config("minimax", "speech-2.8-hd"), {
    ...input,
    speed: 0.95,
    options: {
      language: "Chinese",
      emotion: "calm",
      pitch: -1,
      pronunciation: [{ word: "重庆", phonetic: "(chong2)(qing4)" }],
      pauses: [{ after: 3, seconds: 0.65 }],
    },
  });
  assert.equal(r.url, "https://speech.test/v1/t2a_v2");
  assert.equal(r.body.text, "重庆，<#0.65#>新的旅程开始。");
  assert.deepEqual(r.body.voice_setting, {
    voice_id: "voice",
    speed: 0.95,
    pitch: -1,
    emotion: "calm",
  });
  assert.equal(r.body.pronunciation_dict.tone[0], "重庆/(chong2)(qing4)");
  assert.equal(r.body.language_boost, "Chinese");
  assert.equal(r.body.output_format, "hex");
  assert.throws(
    () =>
      buildTtsRequest(config("minimax", "speech-2.8-hd"), {
        ...input,
        options: { emotion: "whisper" },
      }),
    /不支持/,
  );
  assert(
    ttsCapabilities("minimax", "speech-2.6-hd").fields.emotion.values.includes(
      "whisper",
    ),
  );
});
test("pause boundaries reject duplicates, end offsets and split surrogate pairs before fetch", () => {
  const c = config("minimax", "speech-2.8-hd");
  for (const pauses of [
    [{ after: 100, seconds: 1 }],
    [
      { after: 1, seconds: 1 },
      { after: 1, seconds: 2 },
    ],
  ])
    assert.throws(
      () => buildTtsRequest(c, { ...input, options: { pauses } }),
      /偏移/,
    );
  assert.throws(
    () =>
      buildTtsRequest(c, {
        text: "😀你好",
        options: { pauses: [{ after: 1, seconds: 1 }] },
      }),
    /偏移/,
  );
});
test("Doubao uses new-key auth and resource id; instructions require verified 2.0 voice", () => {
  const c = config("doubao", "seed-tts-2.0", "zh_female_vv_uranus_bigtts");
  const r = buildTtsRequest(c, {
    ...input,
    speed: 1.15,
    options: { instructions: "自然中文", pitch: -2 },
  });
  assert.equal(r.headers["X-Api-Key"], c.apiKey);
  assert.equal(r.headers["X-Api-Resource-Id"], "seed-tts-2.0");
  assert(!r.headers.Authorization);
  assert.deepEqual(r.body.req_params.audio_params, {
    format: "mp3",
    sample_rate: 24000,
    bit_rate: 64000,
    speech_rate: 15,
  });
  assert(!Object.hasOwn(r.body.req_params, "sample_rate"));
  assert.deepEqual(JSON.parse(r.body.req_params.additions), {
    context_texts: ["自然中文"],
    post_process: { pitch: -2 },
  });
  assert(
    !ttsCapabilities("doubao", "seed-tts-2.0", "S_clone").fields.instructions,
  );
  assert(
    !ttsCapabilities("doubao", "seed-tts-1.0", c.voice).fields.instructions,
  );
});
test("ElevenLabs v2 pause/dictionary/context mapping and v3/v4 restrictions", () => {
  const c = config("elevenlabs", "eleven_multilingual_v2", "voice/a");
  const r = buildTtsRequest(c, {
    ...input,
    speed: 0.95,
    options: {
      stability: 0.6,
      similarity: 0.8,
      style: 0.1,
      pauses: [{ after: 3, seconds: 1 }],
      dictionaries: [{ id: "existing", version: "v1" }],
      previousText: "前文",
    },
  });
  assert(r.url.includes("voice%2Fa?output_format=mp3_44100_128"));
  assert.equal(r.headers["xi-api-key"], c.apiKey);
  assert(r.body.text.includes('<break time="1s" />'));
  assert.equal(r.body.voice_settings.similarity_boost, 0.8);
  assert.deepEqual(r.body.pronunciation_dictionary_locators, [
    { pronunciation_dictionary_id: "existing", version_id: "v1" },
  ]);
  assert.throws(
    () =>
      buildTtsRequest(config("elevenlabs", "eleven_v3"), {
        ...input,
        options: { pauses: [{ after: 2, seconds: 1 }] },
      }),
    /不支持/,
  );
  assert.throws(
    () =>
      buildTtsRequest(config("elevenlabs", "eleven_v3"), {
        ...input,
        options: { stability: 0.3 },
      }),
    /不支持/,
  );
  const v4 = buildTtsRequest(config("elevenlabs", "eleven_v4"), {
    ...input,
    options: { stability: 0.4, similarity: 0.8 },
  });
  assert.equal(v4.body.voice_settings.speed, undefined);
  assert.equal(v4.body.voice_settings.similarity_boost, 0.8);
  assert.throws(
    () =>
      buildTtsRequest(config("elevenlabs", "eleven_v4"), {
        ...input,
        speed: 1.1,
      }),
    /语速/,
  );
});
test("Qwen bridge is optional, 0.6B has no instructions and neither model has speed control", () => {
  const c = config("qwen3", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", "Vivian");
  const r = buildTtsRequest(c, {
    ...input,
    options: { language: "Chinese", instructions: "沉稳中文" },
  });
  assert.equal(r.body.speed, undefined);
  assert.equal(r.body.language, "Chinese");
  assert.throws(() => buildTtsRequest(c, { ...input, speed: 0.9 }), /语速/);
  assert(
    !ttsCapabilities("qwen3", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice").fields
      .instructions,
  );
});
test("MiniMax handles HTTP-200 service failure without leaking the provider message", async () => {
  const c = config("minimax", "speech-2.8-hd");
  let count = 0;
  await assert.rejects(
    synthesizeTts(c, input, {
      fetchImpl: async () => {
        count++;
        return Response.json({
          base_resp: { status_code: 1004, status_msg: "fixture-secret-only" },
        });
      },
    }),
    (e) => e.code === "TTS_AUTH" && !e.message.includes(c.apiKey),
  );
  assert.equal(count, 1);
  const result = await synthesizeTts(c, input, {
    fetchImpl: async () =>
      Response.json({
        base_resp: { status_code: 0 },
        data: { audio: wave().toString("hex") },
      }),
  });
  assert.equal(result.mime, "audio/wav");
  assert.deepEqual(result.bytes, wave());
});
test("synthesis rejects invalid audio and size, never retries 429 or connection failure", async () => {
  const c = config("compatible", "model");
  let count = 0;
  await assert.rejects(
    synthesizeTts(c, input, {
      fetchImpl: async () => {
        count++;
        return new Response("secret error", {
          status: 429,
          headers: { "retry-after": "8" },
        });
      },
    }),
    (e) =>
      e.code === "TTS_RATE_LIMIT" &&
      e.retryAfter === 8 &&
      !e.message.includes("secret error"),
  );
  assert.equal(count, 1);
  await assert.rejects(
    synthesizeTts(c, input, {
      fetchImpl: async () => new Response("not audio"),
    }),
    /有效/,
  );
  await assert.rejects(
    synthesizeTts(c, input, {
      maxBytes: 8,
      fetchImpl: async () => new Response(wave()),
    }),
    (e) => e.code === "TTS_LIMIT",
  );
  await assert.rejects(
    synthesizeTts(c, input, {
      fetchImpl: async () => {
        throw new Error(c.apiKey);
      },
    }),
    (e) => e.outcome === "unknown" && !e.message.includes(c.apiKey),
  );
});
test("cancellation and timeout are distinct, abort provider sockets and sanitize errors", async () => {
  const c = config("compatible", "model"),
    controller = new AbortController();
  const fetchImpl = async (_url, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  const cancelled = synthesizeTts(c, input, {
    signal: controller.signal,
    fetchImpl,
  });
  controller.abort();
  await assert.rejects(
    cancelled,
    (e) => e.code === "TTS_CANCELLED" && e.outcome === "unknown",
  );
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      synthesizeTts({ ...c, timeoutMs: 10 }, input, { fetchImpl }),
      (e) => e.code === "TTS_TIMEOUT",
    );
  } finally {
    clearTimeout(keepAlive);
  }
});
test("Doubao fragmented SSE is reassembled, completed, bounded and rejects truncated streams", async () => {
  const c = config("doubao", "seed-tts-2.0", "zh_female_vv_uranus_bigtts"),
    audio = wave().toString("base64");
  const payload = `data: ${JSON.stringify({ code: 0, data: audio })}\r\n\r\ndata: {"code":20000000}\n\n`;
  const body = () =>
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < payload.length; i += 7)
          controller.enqueue(new TextEncoder().encode(payload.slice(i, i + 7)));
        controller.close();
      },
    });
  const result = await synthesizeTts(c, input, {
    fetchImpl: async () => new Response(body()),
  });
  assert.deepEqual(result.bytes, wave());
  await assert.rejects(
    synthesizeTts(c, input, {
      fetchImpl: async () =>
        new Response(`data: {"code":0,"data":"${audio}"}\n`),
    }),
    (e) => e.code === "TTS_INCOMPLETE",
  );
});
test("discovery retries only rejected metadata requests and strips raw service data", async () => {
  let calls = 0;
  const result = await discoverTts(config("minimax", "speech-2.8-hd"), {
    fetchImpl: async (url, args) => {
      calls++;
      assert(url.endsWith("/get_voice"));
      assert.deepEqual(JSON.parse(args.body), { voice_type: "system" });
      return calls === 1
        ? new Response("busy", {
            status: 429,
            headers: { "retry-after": "0.1" },
          })
        : Response.json({
            base_resp: { status_code: 0 },
            system_voice: [
              {
                voice_id: "v",
                voice_name: "中文",
                description: ["沉稳"],
                apiKey: "no-output",
              },
            ],
          });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.source, "live");
  assert(!JSON.stringify(result).includes("no-output"));
  const manual = await discoverTts(config("compatible", "private"), {
    fetchImpl: async () => {
      throw new Error("must not call");
    },
  });
  assert.equal(manual.source, "manual");
});
test("ElevenLabs discovery exposes only TTS models, capability restrictions and pagination", async () => {
  const seen = [];
  const result = await discoverTts(config("elevenlabs", "eleven_v4"), {
    cursor: "next",
    search: "中文",
    fetchImpl: async (url) => {
      seen.push(url);
      return url.endsWith("/models")
        ? Response.json([
            {
              model_id: "eleven_v4",
              name: "v4",
              can_do_text_to_speech: true,
              languages: [{ language_id: "zh" }],
            },
            { model_id: "stt", can_do_text_to_speech: false },
          ])
        : Response.json({
            voices: [{ voice_id: "v", name: "voice" }],
            has_more: true,
            next_page_token: "another",
          });
    },
  });
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].capabilities.speed.max, 1);
  assert.equal(result.nextCursor, "another");
  assert(
    seen.some(
      (u) =>
        u.includes("/v2/voices?next_page_token=next") ||
        u.includes("/v2/voices?page_size=100&next_page_token=next"),
    ),
  );
});
