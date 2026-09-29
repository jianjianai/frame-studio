import { z } from "zod";
import { modelMetadataSchema, modelSpecsSchema } from "./model-metadata.mjs";

export const modelIdSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^(?!-)[^\x00-\x1f\x7f]*$/);
export const providerModelSchema = z.strictObject({
  id: modelIdSchema.min(1),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  metadata: modelMetadataSchema.optional(),
  overrides: modelSpecsSchema.optional(),
});
export const providerModelsSchema = z
  .array(providerModelSchema)
  .max(200)
  .refine(
    (models) => new Set(models.map((model) => model.id)).size === models.length,
    "模型 ID 不可重复",
  );
/** @typedef {{id: string, name: string, enabled?: boolean, metadata?: import('./model-metadata.mjs').ModelMetadata, overrides?: import('./model-metadata.mjs').ModelSpecs}} ProviderModel */
/** @typedef {{id?: string, name?: string, tool?: string, mode?: string, model?: string, models?: ProviderModel[], enabled?: boolean, configured?: boolean, state?: string}} ModelProvider */
/** Read legacy single-model connections without a destructive migration.
 * @param {ModelProvider} provider
 * @returns {ProviderModel[]}
 */
export function providerModels(provider) {
  const models = provider.models?.length
    ? provider.models
    : provider.model
      ? [
          {
            id: provider.model,
            name: provider.model.slice(0, 100),
            enabled: true,
          },
        ]
      : [];
  return provider.mode === "official" || (!provider.mode && !models.length)
    ? [{ id: "", name: "工具默认模型", enabled: true }, ...models]
    : models;
}
/** @param {ModelProvider | undefined} provider */
export function providerAvailable(provider) {
  return (
    !!provider?.configured &&
    provider.enabled !== false &&
    (!provider.state || provider.state === "ready")
  );
}
/** @param {string} connection @param {string} model */
export const modelSelectionKey = (connection, model) =>
  JSON.stringify([connection, model]);

/** Refresh only selected entries; never delete absent models or reset user overrides.
 * @param {ProviderModel[]} saved @param {ProviderModel[]} discovered @param {string[]} ids
 * @returns {ProviderModel[]}
 */
export function mergeDiscoveredModels(saved, discovered, ids) {
  const wanted = new Set(ids),
    next = new Map(saved.map((model) => [model.id, model]));
  for (const incoming of discovered) {
    if (!wanted.has(incoming.id)) continue;
    const old = next.get(incoming.id);
    const customName =
      old &&
      old.name !== old.id.slice(0, 100) &&
      old.name !== old.metadata?.name;
    next.set(
      incoming.id,
      old
        ? {
            ...old,
            name: customName ? old.name : incoming.name,
            metadata: incoming.metadata,
          }
        : incoming,
    );
  }
  return providerModelsSchema.parse([...next.values()]);
}
