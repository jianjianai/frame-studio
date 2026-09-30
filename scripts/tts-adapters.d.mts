import type {
  TtsConfig,
  TtsInput,
  TtsNormalized,
  TtsCapabilities,
  TtsWarning,
} from "./tts-capabilities.mjs";
export interface TtsProgress {
  phase: "connecting" | "receiving" | "validating";
  receivedBytes: number;
}
export interface TtsResult {
  bytes: Buffer;
  ext: "wav" | "mp3";
  mime: "audio/wav" | "audio/mpeg";
  applied: Pick<
    TtsNormalized,
    "provider" | "model" | "voice" | "speed" | "options"
  >;
  warnings: TtsWarning[];
}
export interface TtsCatalog {
  source: string;
  voices: {
    id: string;
    name?: string;
    description?: string;
    labels?: Record<string, string>;
  }[];
  models: {
    id: string;
    name?: string;
    languages?: string[];
    capabilities?: TtsCapabilities;
  }[];
  nextCursor: string | null;
  hint?: string;
}
export const MAX_TTS_BYTES: number;
export function ttsError(
  code: string,
  message: string,
  statusCode?: number,
  extra?: Record<string, unknown>,
): Error & { code: string; statusCode: number };
/** Private headers must never be logged or persisted. */
export function buildTtsRequest(
  config: TtsConfig & { url: string },
  input: TtsInput & { text: string },
): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  encoding: string;
  normalized: TtsNormalized;
};
export function synthesizeTts(
  config: TtsConfig & { url: string },
  input: TtsInput & { text: string },
  context?: {
    signal?: AbortSignal;
    onProgress?: (progress: TtsProgress) => void;
    fetchImpl?: typeof fetch;
    maxBytes?: number;
  },
): Promise<TtsResult>;
export function discoverTts(
  config: TtsConfig & { url: string },
  context?: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    cursor?: string;
    search?: string;
  },
): Promise<TtsCatalog>;
