import {
  normalizeTtsInput,
  ttsOptionsSchema,
  type TtsOptions,
} from "../../scripts/tts-capabilities.mjs";
import { synthesizeTts, discoverTts } from "../../scripts/tts-adapters.mjs";
const config = {
  provider: "minimax" as const,
  model: "speech-2.8-hd",
  voice: "voice",
  url: "https://speech.test/v1",
};
const options: TtsOptions = ttsOptionsSchema.parse({
  pronunciation: [{ word: "重庆", phonetic: "(chong2)(qing4)" }],
});
normalizeTtsInput(config, { text: "重庆", options });
// This function is a compiler contract only: it is never invoked or sent to a provider.
export async function checkTtsContracts(signal: AbortSignal) {
  const audio = await synthesizeTts(
    config,
    { text: "重庆", options },
    { signal, onProgress: (progress) => progress.receivedBytes.toFixed(0) },
  );
  audio.applied.options.emotion?.toLowerCase();
  const catalog = await discoverTts(config, { cursor: "page" });
  catalog.models[0]?.capabilities?.fields.instructions?.hint;
  // @ts-expect-error secrets and transport headers are never expression controls
  normalizeTtsInput(config, { options: { apiKey: "invalid" } });
  normalizeTtsInput(config, {
    // @ts-expect-error pauses require numeric original-text offsets
    options: { pauses: [{ after: "2", seconds: 0.5 }] },
  });
  // @ts-expect-error undocumented providers cannot use the shared adapter contract
  normalizeTtsInput({ ...config, provider: "invented" }, {});
  return audio.mime;
}
