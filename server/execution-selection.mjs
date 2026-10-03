import { createHash } from "node:crypto";
import { problem } from "./security.mjs";

const signature = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const endpoint = (value) => String(value || "").replace(/\/+$/, "");

/** Freeze non-secret choices at enqueue, not when a queue slot eventually opens. */
export async function freezeExecution({ connections, input }) {
  if (!input.connection) throw problem(400, "请选择 Paseo 模型连接");
  if (!connections) throw problem(503, "模型连接服务不可用");
  const config = connections.selection
    ? await connections.selection(input.connection, input.model)
    : await connections.resolve(input.connection);
  if (config.tool !== input.provider)
    throw problem(409, "所选连接与会话的执行工具不一致，请新建对应工具的对话");
  if (!config.apiKey && config.mode !== "official")
    throw problem(409, "请先配置这个模型连接的凭据");
  const selection = {
    schema: 1,
    provider: input.provider,
    connection: input.connection,
    connectionName: config.name || input.provider,
    model: String(input.model ?? config.model ?? ""),
    baseUrl: endpoint(config.baseUrl),
    authMode: config.mode || "api",
    authGeneration: String(config.auth_generation || "0"),
  };
  const { connectionName: _label, ...identity } = selection;
  return {
    ...selection,
    sessionKey: signature(identity),
    selectedAt: new Date().toISOString(),
  };
}

/** Credentials remain revocable references. Never store API keys in tasks or send one to a changed endpoint. */
export function resolveExecution(selection, config, provider) {
  if (!selection) throw problem(409, "缺少冻结的模型选择，请重新提交消息");
  if (
    Array.isArray(config.models) &&
    selection.model &&
    !config.models.some(
      (model) => model.id === selection.model && model.enabled !== false,
    )
  )
    throw Object.assign(
      problem(
        409,
        "排队时选中的模型已被停用或移除；本轮没有改用其他模型，请重新选择后提交",
      ),
      {
        code: "EXECUTION_MODEL_DISABLED",
        recovery: "resubmit",
        retryable: false,
      },
    );
  if (
    selection.provider !== provider ||
    (config.tool && config.tool !== provider) ||
    (config.mode || "api") !== selection.authMode ||
    endpoint(config.baseUrl) !== selection.baseUrl ||
    String(config.auth_generation || "0") !== selection.authGeneration
  ) {
    throw Object.assign(
      problem(
        409,
        "排队期间连接端点或登录身份已变化；本轮未执行，请使用当前配置重新提交",
      ),
      {
        code: "EXECUTION_SELECTION_CHANGED",
        recovery: "resubmit",
        retryable: false,
      },
    );
  }
  return {
    ...config,
    model: selection.model,
    baseUrl: selection.baseUrl,
    mode: selection.authMode,
  };
}
