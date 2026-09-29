import { createHash } from "node:crypto";
import { problem } from "./security.mjs";

const signature = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const endpoint = value => String(value || "").replace(/\/+$/, "");

/** Freeze non-secret choices at enqueue, not when a queue slot eventually opens. */
export async function freezeExecution({ db, connections, secrets, input }) {
  let config;
  if (input.connection) {
    if (!connections) throw problem(503, "模型连接服务不可用");
    config = await connections.resolve(input.connection, input.model);
  } else {
    const legacy = await db.setting(input.provider);
    config = { ...(legacy?.encrypted ? secrets.decrypt(legacy.encrypted) : {}), tool: input.provider, mode: "api" };
  }
  if (config.tool !== input.provider) throw problem(409, "所选连接与会话的执行工具不一致，请新建对应工具的对话");
  if (!config.apiKey && config.mode !== "official") throw problem(409, "请先配置这个模型连接的凭据");
  const selection = {
    schema: 1,
    provider: input.provider,
    connection: input.connection || null,
    connectionName: config.name || input.provider,
    model: String(input.model || config.model || ""),
    baseUrl: endpoint(config.baseUrl),
    authMode: config.mode || "api",
    authGeneration: String(config.auth_generation || "0"),
  };
  const { connectionName: _label, ...identity } = selection;
  return { ...selection, sessionKey: signature(identity), selectedAt: new Date().toISOString() };
}

/** Credentials remain revocable references. Never store API keys in tasks or send one to a changed endpoint. */
export function resolveExecution(selection, config, provider) {
  if (!selection) return config; // Explicit compatibility path for pre-V5 queued tasks.
  if (selection.provider !== provider ||
      (config.tool && config.tool !== provider) ||
      (config.mode || "api") !== selection.authMode ||
      endpoint(config.baseUrl) !== selection.baseUrl ||
      (selection.authMode === "official" && String(config.auth_generation || "0") !== selection.authGeneration)) {
    throw Object.assign(problem(409, "排队期间连接端点或登录身份已变化；本轮未执行，请使用当前配置重新提交"), {
      code: "EXECUTION_SELECTION_CHANGED", recovery: "resubmit", retryable: false,
    });
  }
  return { ...config, model: selection.model, baseUrl: selection.baseUrl, mode: selection.authMode };
}

export function resumableSession(chat, execution) {
  if (!execution) return chat?.upstream || null;
  return chat?.upstream_execution === execution.sessionKey ? chat.upstream : null;
}

/** A new upstream session still receives bounded, persisted conversation context instead of silently forgetting it. */
export async function continuationContext(db, task, chat, execution) {
  const upstream = resumableSession(chat, execution);
  if (upstream || !task.chat) return { upstream, turns: [], strategy: upstream ? "resume" : "new" };
  const rows = await db.all(
    "SELECT id,input FROM tasks WHERE chat=$1 AND (created,id)<(SELECT created,id FROM tasks WHERE id=$2) ORDER BY created DESC,id DESC LIMIT 12",
    [task.chat, task.id],
  );
  let remaining = 24000;
  const turns = [];
  for (const row of rows) {
    if (remaining <= 0) break;
    const events = await db.all("SELECT kind,data FROM events WHERE task=$1 AND kind IN ('message','summary') ORDER BY id DESC LIMIT 8", [row.id]);
    const messages = new Map();
    for (const event of events) {
      const id = event.data?.id || event.kind;
      if (!messages.has(id) && typeof event.data?.text === "string") messages.set(id, event.data.text);
    }
    const prompt = String(row.input?.prompt || "").slice(0, Math.min(4000, remaining));
    remaining -= prompt.length;
    const answer = [...messages.values()].reverse().join("\n").slice(0, Math.min(4000, remaining));
    remaining -= answer.length;
    turns.unshift({ task: row.id, prompt, answer, context: row.input?.context || null });
  }
  return { upstream: null, turns, strategy: turns.length ? "new-with-context" : "new" };
}
