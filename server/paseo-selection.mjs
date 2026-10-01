import { freezeExecution } from "./execution-selection.mjs";
import { providerModels, modelIdSchema } from "../src/contracts/ai-models.mjs";
import { problem } from "./security.mjs";

/** Empty FRAME catalogs deliberately delegate model discovery to the native provider. */
export function paseoExecutionConfig(config) {
  if (Array.isArray(config.models) ? config.models.length === 0 : !config.model)
    return { ...config, models: undefined };
  return { ...config, models: providerModels(config) };
}

/** Freeze the already resolved profile once; native ownership/model checks are handled by the caller. */
export async function freezePaseoExecution({ db, connections, secrets, connection, config, model }) {
  config ||= await connections.resolve(connection);
  const selected = modelIdSchema.parse(model ?? config.model ?? "");
  const policy = paseoExecutionConfig(config);
  if (policy.models && !policy.models.some(entry => entry.id === selected && entry.enabled !== false))
    throw problem(400, "所选模型已停用或不属于此提供商，请重新选择");
  return freezeExecution({ db, secrets, connections: { resolve: async id => {
    if (id !== connection) throw problem(409, "Native provider identity changed");
    return config;
  } }, input: { connection, provider: config.tool, model: selected } });
}
