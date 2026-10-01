import { acquireDatabaseClient } from "./scoped-pool.mjs";
import fs from "node:fs";
import path from "node:path";
import { hash, problem } from "./security.mjs";

export async function providerUsage(db, id) {
  const row = await db.one("SELECT state FROM connections WHERE id=$1", [id]);
  if (!row || row.state === "deleted")
    throw problem(404, "提供商已删除或不存在");
  return db.one(
    `SELECT
    (SELECT count(*)::int FROM chats WHERE connection=$1) AS chats,
    (SELECT count(*)::int FROM tasks t WHERE
      (t.input->>'connection'=$1::text OR t.chat IN (SELECT id FROM chats WHERE connection=$1))
      AND t.state IN ('queued','running','cancelling','publishing','publish_failed')) AS "activeTasks",
    (SELECT count(*)::int FROM auth_flows WHERE target=$1 AND state='pending') AS "pendingLogins"`,
    [id],
  );
}

/** A secret-free tombstone preserves chat/task identity; it can never resolve or be re-enabled. */
export async function deleteProvider(
  connections,
  { id, expectedRevision, confirmName },
) {
  const { db, secrets, data } = connections;
  return db.lock(`connection:${id}`, async () => {
    const row = await db.one("SELECT * FROM connections WHERE id=$1", [id]);
    if (!row || row.state === "deleted")
      throw problem(404, "提供商已删除或不存在");
    if (confirmName !== row.name)
      throw problem(400, "请输入完整提供商名称以确认删除");
    if (expectedRevision !== hash(row.name + "\n" + row.config))
      throw problem(409, "提供商配置已更新，请关闭确认框并重新删除");
    const usage = await providerUsage(db, id);
    if (await connections.nativeActivity?.(id))
      throw problem(409, "Paseo 还有创作使用此提供商，请先完成或停止后删除。");
    if (usage.activeTasks)
      throw problem(
        409,
        `还有 ${usage.activeTasks} 个任务使用此提供商，请先完成或停止任务后删除`,
      );
    if (usage.pendingLogins)
      throw problem(409, "此提供商正在授权，请先完成或等待授权结束后删除");
    const client = await acquireDatabaseClient(db);
    let broken = false;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "UPDATE connections SET config=$2,state='deleted',error=NULL WHERE id=$1 AND config=$3 AND name=$4 AND state<>'deleted'",
        [
          id,
          secrets.encrypt({
            enabled: false,
            models: [],
            deletedAt: new Date().toISOString(),
          }),
          row.config,
          row.name,
        ],
      );
      if (!result.rowCount)
        throw problem(409, "提供商配置刚刚发生变化，请刷新后重试");
      await client.query("UPDATE auth_flows SET info='{}' WHERE target=$1", [
        id,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      throw error;
    } finally {
      client.release(broken);
    }
    let warning;
    try {
      fs.rmSync(path.join(data, "auth", id), { recursive: true, force: true });
    } catch {
      warning =
        "提供商已删除，数据库密钥已清除；本地登录目录清理失败，需要管理员处理。";
    }
    return {
      id,
      deleted: true,
      preservedChats: usage.chats,
      ...(warning ? { warning } : {}),
    };
  });
}

export function normalizeProviderUrl(value, tool) {
  const raw = value.trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw problem(400, "API 地址格式无效，请填写完整的 http(s) 地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw problem(
      400,
      "Invalid provider URL：地址不能包含凭据、查询参数或片段",
    );
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/(?:responses|messages|models|chat\/completions)$/, "");
  // Claude's SDK appends /v1/messages itself; Codex expects /v1 in its base URL.
  if (tool === "claude") url.pathname = url.pathname.replace(/\/v1$/, "");
  return url.href.replace(/\/+$/, "");
}
