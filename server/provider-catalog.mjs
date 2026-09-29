import { providerModelSchema } from "../src/contracts/ai-models.mjs";
import {
  apiModelMetadata,
  enrichModelMetadata,
  readCatalogJson,
} from "./provider-metadata.mjs";
import { problem } from "./security.mjs";

/** Only contact the configured endpoint, with bounded pagination and no credential redirects. */
export async function discoverModels(config, fetcher = fetch, catalogLoader) {
  if (config.mode !== "api")
    throw problem(400, "官方账号未提供模型目录 API，请手动添加可用模型 ID");
  if (!config.apiKey) throw problem(400, "请先保存提供商的 API 密钥");
  const codex = config.tool === "codex";
  const base = (
    config.baseUrl ||
    (codex ? "https://api.openai.com/v1" : "https://api.anthropic.com")
  ).replace(/\/+$/, "");
  const endpoint =
    base + (codex || base.endsWith("/v1") ? "/models" : "/v1/models");
  const models = [],
    seen = new Set(),
    cursors = new Set(),
    warnings = [];
  const fetchedAt = new Date().toISOString(),
    signal = AbortSignal.timeout(20000);
  let cursor,
    truncated = false,
    pages = 0,
    skipped = 0;
  try {
    while (pages < 10 && models.length < 1000) {
      const url = new URL(endpoint);
      if (cursor) url.searchParams.set(codex ? "after" : "after_id", cursor);
      let body;
      try {
        const response = await fetcher(url.href, {
          headers: codex
            ? { Authorization: "Bearer " + config.apiKey }
            : { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
          redirect: "error",
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          const hint = [401, 403].includes(response.status)
            ? "请检查密钥及模型目录权限"
            : response.status === 404
              ? "此接口可能不支持模型列表，可手动添加"
              : response.status === 429
                ? "请求受限，请稍后重试"
                : "请检查接口地址或稍后重试";
          throw problem(
            502,
            `无法获取模型（HTTP ${response.status}），${hint}`,
          );
        }
        body = await readCatalogJson(response, 2 * 1024 * 1024);
        if (!Array.isArray(body?.data))
          throw problem(502, "提供商未返回标准模型目录，可手动添加模型");
      } catch (error) {
        if (!pages) throw error;
        warnings.push(
          "后续分页读取失败，当前为部分模型；可重试补齐，不会移除已有模型。",
        );
        truncated = true;
        break;
      }
      pages++;
      for (const entry of body.data) {
        if (!entry || typeof entry !== "object") {
          skipped++;
          continue;
        }
        const parsed = providerModelSchema.safeParse({
          id: entry.id,
          name: String(entry.display_name || entry.name || entry.id || "")
            .trim()
            .slice(0, 100),
          enabled: true,
        });
        if (!parsed.success || parsed.data.id.includes(config.apiKey)) {
          skipped++;
          continue;
        }
        if (seen.has(parsed.data.id)) continue;
        if (models.length >= 1000) {
          truncated = true;
          break;
        }
        seen.add(parsed.data.id);
        const metadata = apiModelMetadata(entry, fetchedAt);
        if (metadata.name)
          metadata.name = metadata.name.replaceAll(config.apiKey, "[redacted]");
        models.push({
          ...parsed.data,
          name: metadata.name || parsed.data.id.slice(0, 100),
          metadata,
        });
      }
      if (!body.has_more) break;
      const next = body.last_id || body.data.at(-1)?.id;
      if (
        typeof next !== "string" ||
        !next ||
        next.length > 200 ||
        cursors.has(next)
      ) {
        truncated = true;
        warnings.push("提供商分页游标无效或重复，已停止继续读取。");
        break;
      }
      cursors.add(next);
      cursor = next;
      truncated = true;
      if (pages < 10 && models.length < 1000) truncated = false;
    }
    warnings.push(
      ...(await enrichModelMetadata(models, config, catalogLoader)),
    );
    return {
      models,
      truncated,
      pages,
      skipped,
      fetchedAt,
      warnings,
      message:
        "优先采用 API 规格，缺失项可由公共目录精确补齐；未提供不等于不支持。目录不代表已通过创作工具兼容性测试。",
    };
  } catch (error) {
    const failure = problem(
      error.statusCode || 502,
      error.statusCode
        ? error.message
        : "模型目录读取失败或超时，请重试或手动添加模型 ID",
    );
    // All text above is authored locally; no upstream body or fetch exception is exposed.
    failure.expose = true;
    throw failure;
  }
}

/** Re-read and compare-and-swap: a slow test must not overwrite newer secrets/config. */
export async function recordConnectionTest(connections, id, tested, result) {
  const { db, secrets } = connections;
  const latest = await db.one(
    "SELECT config,state FROM connections WHERE id=$1",
    [id],
  );
  if (!latest || latest.state === "deleted") return;
  const current = secrets.decrypt(latest.config);
  if (current.apiKey !== tested.apiKey || current.baseUrl !== tested.baseUrl)
    return;
  current.lastTest = result;
  await db.pool.query(
    "UPDATE connections SET config=$2 WHERE id=$1 AND config=$3",
    [id, secrets.encrypt(current), latest.config],
  );
}
