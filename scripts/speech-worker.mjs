import { workerData, parentPort } from "node:worker_threads";
import { pathToFileURL } from "node:url";

export const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
export function azureSsml(text, voice, settings = {}) {
  const attrs = ["rate", "pitch", "volume"]
    .filter((k) => settings[k] !== undefined)
    .map((k) => `${k}="${escapeXml(settings[k])}"`)
    .join(" ");
  let body = `<prosody ${attrs}>${escapeXml(text)}</prosody>`;
  if (settings.style || settings.role) {
    const style = ["style", "role"]
      .filter((k) => settings[k])
      .map((k) => `${k}="${escapeXml(settings[k])}"`)
      .join(" ");
    body = `<mstts:express-as ${style} styledegree="${settings.styleDegree ?? 1}">${body}</mstts:express-as>`;
  }
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${escapeXml(voice.split("-").slice(0, 2).join("-"))}"><voice name="${escapeXml(voice)}">${body}</voice></speak>`;
}
async function collect(stream, max) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > max) {
      stream.destroy?.();
      throw new Error("AUDIO_LIMIT");
    }
    chunks.push(Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}
async function execute({ action, runtime: p, text, maxBytes, locale }) {
  if (p.type === "custom") {
    const provider = await import(pathToFileURL(p.module).href);
    if (typeof provider.synthesize !== "function")
      throw new Error("CUSTOM_INTERFACE");
    return {
      bytes: await provider.synthesize({
        text,
        voice: p.voice,
        settings: p.settings,
        signal: AbortSignal.timeout(p.timeoutMs),
      }),
    };
  }
  if (p.type === "openai") {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({
      apiKey: p.apiKey,
      baseURL: p.baseURL,
      maxRetries: 0,
      timeout: p.timeoutMs,
      fetch: (url, options) => fetch(url, { ...options, redirect: "error" }),
    });
    const response = await client.audio.speech.create({
      model: p.model,
      voice: p.voice,
      input: text,
      response_format: "wav",
      ...p.settings,
    });
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new Error("AUDIO_LIMIT");
    }
    if (!response.body) throw new Error("EMPTY_AUDIO");
    return { bytes: await collect(response.body, maxBytes) };
  }
  if (p.type === "edge") {
    const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
    const tts = new MsEdgeTTS({ enableLogger: false });
    try {
      if (action === "voices")
        return {
          voices: (await tts.getVoices()).map((v) => ({
            id: v.ShortName,
            name: v.FriendlyName,
            locale: v.Locale,
            gender: v.Gender,
          })),
        };
      await tts.setMetadata(
        p.voice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
      );
      const { audioStream } = tts.toStream(escapeXml(text), p.settings);
      return { bytes: await collect(audioStream, maxBytes) };
    } finally {
      tts.close();
    }
  }
  if (p.type === "azure") {
    const sdk = await import("microsoft-cognitiveservices-speech-sdk");
    const config = sdk.SpeechConfig.fromSubscription(p.apiKey, p.region);
    config.speechSynthesisVoiceName = p.voice;
    config.speechSynthesisOutputFormat =
      sdk.SpeechSynthesisOutputFormat.Riff48Khz16BitMonoPcm;
    const synth = new sdk.SpeechSynthesizer(config, null);
    try {
      if (action === "voices") {
        const result = await synth.getVoicesAsync(locale ?? "");
        if (result.reason !== sdk.ResultReason.VoicesListRetrieved)
          throw new Error("AZURE_VOICES");
        return {
          voices: result.voices.map((v) => ({
            id: v.shortName,
            name: v.localName,
            locale: v.locale,
            gender: sdk.SynthesisVoiceGender[v.gender],
            styles: v.styleList,
          })),
        };
      }
      const result = await new Promise((resolve, reject) =>
        synth.speakSsmlAsync(
          azureSsml(text, p.voice, p.settings),
          resolve,
          reject,
        ),
      );
      if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted)
        throw new Error("AZURE_SYNTHESIS");
      return { bytes: new Uint8Array(result.audioData) };
    } finally {
      synth.close();
    }
  }
  throw new Error("UNKNOWN_PROVIDER");
}
if (parentPort && workerData) {
  try {
    const result = await execute(workerData);
    if (
      result.bytes &&
      (!(result.bytes instanceof Uint8Array) ||
        !result.bytes.length ||
        result.bytes.length > workerData.maxBytes)
    )
      throw new Error("AUDIO_LIMIT");
    parentPort.postMessage(result);
  } catch (error) {
    // Never copy upstream response bodies, URLs, SSML or credentials into MCP/job logs.
    const status = Number.isInteger(error?.status)
      ? ` (HTTP ${error.status})`
      : "";
    const hint =
      error?.message === "AUDIO_LIMIT"
        ? "Audio size limit exceeded"
        : "Speech request failed; check connectivity, credentials, voice and provider settings";
    parentPort.postMessage({
      error:
        hint + status + "; no automatic retry or provider fallback was made",
    });
  }
}
