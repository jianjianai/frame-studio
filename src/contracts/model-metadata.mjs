import { z } from "zod";

const tokens = z.number().int().positive().max(1_000_000_000).nullish();
const price = z.number().min(0).max(1_000_000).nullish();
const modalities = z
  .array(
    z.enum(["text", "image", "audio", "video", "pdf", "file", "embedding"]),
  )
  .max(7)
  .nullish();
/** Specifications, not generation settings. Unknown is never treated as false/zero. */
export const modelSpecsSchema = z.strictObject({
  contextWindow: tokens,
  maxInputTokens: tokens,
  maxOutputTokens: tokens,
  inputModalities: modalities,
  outputModalities: modalities,
  vision: z.boolean().nullish(),
  reasoning: z.boolean().nullish(),
  toolCall: z.boolean().nullish(),
  structuredOutput: z.boolean().nullish(),
  inputPrice: price,
  outputPrice: price,
  cacheReadPrice: price,
  cacheWritePrice: price,
});
export const modelSpecKeys = modelSpecsSchema.keyof().options;
export const modelMetadataSchema = modelSpecsSchema.extend({
  name: z.string().min(1).max(100).optional(),
  sources: z.partialRecord(
    z.enum(["name", ...modelSpecKeys]),
    z.enum(["api", "catalog"]),
  ),
  fetchedAt: z.iso.datetime(),
});
/** @typedef {z.infer<typeof modelSpecsSchema>} ModelSpecs */
/** @typedef {z.infer<typeof modelMetadataSchema>} ModelMetadata */
/** @param {{metadata?: ModelMetadata, overrides?: ModelSpecs}} model @returns {ModelSpecs} */
export function effectiveModelSpecs(model) {
  return Object.fromEntries(
    modelSpecKeys.map((key) => [
      key,
      Object.hasOwn(model.overrides || {}, key)
        ? model.overrides?.[key]
        : model.metadata?.[key],
    ]),
  );
}
/** @param {{metadata?: ModelMetadata, overrides?: ModelSpecs}} model @param {keyof ModelSpecs} key */
export function modelSpecSource(model, key) {
  if (Object.hasOwn(model.overrides || {}, key)) return "manual";
  return model.metadata?.sources?.[key] || "unknown";
}
/** @param {number | null | undefined} value */
export function formatModelTokens(value) {
  if (value == null) return "未提供";
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${+(value / 1_000).toFixed(2)}K`;
  return String(value);
}
