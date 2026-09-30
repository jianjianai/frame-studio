import type { z } from "zod";
export type TtsProvider =
  | "compatible"
  | "local"
  | "openai"
  | "minimax"
  | "doubao"
  | "elevenlabs"
  | "qwen3";
export interface TtsOptions {
  language?: string;
  instructions?: string;
  emotion?: string;
  pitch?: number;
  pronunciation?: { word: string; phonetic: string }[];
  pauses?: { after: number; seconds: number }[];
  stability?: number;
  similarity?: number;
  style?: number;
  dictionaries?: { id: string; version: string }[];
  previousText?: string;
  nextText?: string;
}
export interface TtsConfig {
  provider?: TtsProvider;
  model: string;
  voice: string;
  url?: string;
  apiKey?: string;
  timeoutMs?: number;
}
export interface TtsInput {
  text?: string;
  voice?: string;
  speed?: number;
  options?: TtsOptions;
  fallback?: "error" | "omit";
}
export interface TtsField {
  kind: string;
  values?: (string | number)[];
  min?: number;
  max?: number;
  default?: number;
  maxLength?: number;
  hint?: string;
}
export interface TtsCapabilities {
  schemaVersion: number;
  provider: TtsProvider;
  model: string;
  fields: Partial<Record<keyof TtsOptions, TtsField>>;
  speed: { min: number; max: number; default: number };
  voices: { id: string; name: string }[];
  languages: { mode: string; known: string[]; complete: boolean };
  maxTextLength: number;
  voiceDiscovery: string;
  textHints: string;
  fallback: string[];
}
export interface TtsWarning {
  field: string;
  reason: string;
}
export interface TtsNormalized {
  provider: TtsProvider;
  model: string;
  voice: string;
  speed: number;
  text?: string;
  options: TtsOptions;
  warnings: TtsWarning[];
  capabilities: TtsCapabilities;
}
export const ttsProviderIds: TtsProvider[];
export const ttsProviders: {
  id: Exclude<TtsProvider, "local">;
  name: string;
  url: string;
  model: string;
  voice: string;
  models: string[];
  note: string;
  docs?: string;
}[];
export const ttsOptionsSchema: z.ZodType<TtsOptions>;
export const speechInputShape: {
  engine: z.ZodType<string>;
  text: z.ZodType<string>;
  voice: z.ZodType<string | undefined>;
  speed: z.ZodType<number | undefined>;
  options: z.ZodType<TtsOptions | undefined>;
  fallback: z.ZodType<"error" | "omit">;
  requestId: z.ZodType<string | undefined>;
};
export function ttsCapabilities(
  provider?: TtsProvider,
  model?: string,
  voice?: string,
): TtsCapabilities;
export function normalizeTtsInput(
  config: TtsConfig,
  input: TtsInput,
): TtsNormalized;
