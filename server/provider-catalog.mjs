import { providerModelSchema } from "../src/contracts/ai-models.mjs";
import { problem } from "./security.mjs";

/** The saved endpoint is explicitly administered by the workspace owner.
 * Never follow redirects carrying credentials, or trust an unbounded catalog.
 */
export async function discoverModels(config, fetcher = fetch) {
  if (config.mode !== "api")
    throw problem(400, "官方登录不提供模型发现，请手动添加可用模型 ID");
  if (!config.apiKey) throw problem(400, "请先保存提供商的 API 密钥");
  const codex = config.tool === "codex";
  const base = (
    config.baseUrl ||
    (codex ? "https://api.openai.com/v1" : "https://api.anthropic.com")
  ).replace(/\/+$/, "");
  try {
    const response = await fetcher(
      base + (codex || base.endsWith("/v1") ? "/models" : "/v1/models"),
      {
        headers: codex
          ? { Authorization: "Bearer " + config.apiKey }
          : { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw problem(
        502,
        `无法发现模型（HTTP ${response.status}），可手动添加模型 ID`,
      );
    }
    if (!response.body) throw problem(502, "提供商返回空模型目录");
    const reader = response.body.getReader(),
      chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024)
          throw problem(502, "模型目录响应过大，请手动添加模型");
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(body.data))
      throw problem(502, "提供商未返回标准模型目录，请手动添加模型");
    const seen = new Set(),
      models = [];
    for (const entry of body.data) {
      const parsed = providerModelSchema.safeParse({
        id: entry?.id,
        name: String(entry?.display_name || entry?.id || "").slice(0, 100),
        enabled: true,
      });
      if (parsed.success && !seen.has(parsed.data.id)) {
        seen.add(parsed.data.id);
        models.push(parsed.data);
      }
      if (models.length >= 200) break;
    }
    return {
      models,
      truncated: body.data.length > models.length || !!body.has_more,
      message: "目录仅供选择，不代表模型已通过工具兼容性验证；请测试后使用。",
    };
  } catch (error) {
    throw problem(
      error.statusCode || 502,
      error.statusCode
        ? error.message
        : "模型目录读取失败或超时，可手动添加模型 ID",
    );
  }
}

/** Re-read and compare-and-swap: a slow test must not overwrite newer secrets/config. */
export async function recordConnectionTest(connections, id, tested, result) {
  const { db, secrets } = connections;
  const latest = await db.one("SELECT config FROM connections WHERE id=$1", [
    id,
  ]);
  if (!latest) return;
  const current = secrets.decrypt(latest.config);
  if (current.apiKey !== tested.apiKey || current.baseUrl !== tested.baseUrl)
    return;
  current.lastTest = result;
  await db.pool.query(
    "UPDATE connections SET config=$2 WHERE id=$1 AND config=$3",
    [id, secrets.encrypt(current), latest.config],
  );
}
