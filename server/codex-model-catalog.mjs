import { spawn } from "node:child_process";
import { processLaunch } from "./local-tools.mjs";
import { StringDecoder } from "node:string_decoder";
import { providerModelSchema } from "../src/contracts/ai-models.mjs";
import { apiModelMetadata, enrichModelMetadata } from "./provider-metadata.mjs";
import { problem as baseProblem } from "./security.mjs";
const problem = (status, message) =>
  Object.assign(baseProblem(status, message), { expose: true });

/** Use the same CLI account store as creative tasks. No inference or credential export. */
export async function discoverCodexModels(
  config,
  { bin, env, cwd, spawnProcess = spawn, timeout = 20000, catalogLoader },
) {
  const launch = processLaunch(bin, ["app-server", "--listen", "stdio://", "-c", 'model_provider="openai"']);
  const child = spawnProcess(
    launch.bin,
    launch.args,
    { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const pending = new Map(),
    decoder = new StringDecoder("utf8");
  let sequence = 0,
    buffer = "",
    bytes = 0,
    failure;
  const fail = (error) => {
    failure ||= error;
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  };
  const timer = setTimeout(
    () => fail(problem(502, "Codex 模型目录读取超时，请稍后重试")),
    timeout,
  );
  child.once("error", () =>
    fail(problem(502, "无法启动 Codex，请检查创作工具是否已安装")),
  );
  child.once("close", () =>
    fail(problem(502, "Codex 模型目录进程已退出，请更新工具或重新登录")),
  );
  child.stderr.on("data", () => {}); // Never forward CLI diagnostics containing account data.
  child.stdin.on("error", () =>
    fail(problem(502, "Codex 模型目录连接已中断，请重试")),
  );
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) {
      fail(problem(502, "Codex 模型目录响应过大"));
      return;
    }
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let packet;
      try {
        packet = JSON.parse(line);
      } catch {
        continue;
      }
      if (!packet || typeof packet !== "object") continue;
      const request = pending.get(packet.id);
      if (!request) continue;
      pending.delete(packet.id);
      if (packet.error)
        request.reject(
          problem(502, "Codex 不支持读取模型目录，请更新创作工具或重新登录"),
        );
      else request.resolve(packet.result);
    }
  });
  const send = (method, params, id) =>
    child.stdin.write(
      JSON.stringify({ method, params, ...(id ? { id } : {}) }) + "\n",
    );
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const id = "catalog-" + ++sequence;
      pending.set(id, { resolve, reject });
      send(method, params, id);
    });
  const models = [],
    seen = new Set(),
    cursors = new Set(),
    warnings = [];
  const fetchedAt = new Date().toISOString();
  let pages = 0,
    skipped = 0,
    truncated = false,
    cursor,
    defaultModel = "";
  try {
    await request("initialize", {
      clientInfo: { name: "frame_model_catalog", version: "1.0.0" },
    });
    send("initialized", {});
    const account = await request("account/read", { refreshToken: true });
    if (account?.account?.type !== "chatgpt")
      throw problem(409, "请先使用 OpenAI 官方账号登录 Codex，再同步模型");
    while (pages < 10 && models.length < 200) {
      const page = await request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page?.data))
        throw problem(502, "Codex 未返回有效模型目录，请更新创作工具");
      pages++;
      for (const entry of page.data) {
        if (!entry || typeof entry !== "object" || entry.hidden === true) {
          skipped++;
          continue;
        }
        const parsed = providerModelSchema.safeParse({
          id: entry.model || entry.id,
          name: String(
            entry.displayName ||
              entry.display_name ||
              entry.model ||
              entry.id ||
              "",
          )
            .trim()
            .slice(0, 100),
          enabled: true,
        });
        if (!parsed.success) {
          skipped++;
          continue;
        }
        if (seen.has(parsed.data.id)) continue;
        if (models.length >= 200) {
          truncated = true;
          break;
        }
        seen.add(parsed.data.id);
        if (entry.isDefault === true) defaultModel ||= parsed.data.id;
        models.push({
          ...parsed.data,
          metadata: apiModelMetadata(entry, fetchedAt),
        });
      }
      if (!page.nextCursor) break;
      if (
        typeof page.nextCursor !== "string" ||
        page.nextCursor.length > 200 ||
        cursors.has(page.nextCursor)
      ) {
        truncated = true;
        warnings.push("Codex 返回重复或无效分页游标，已保留当前目录。");
        break;
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
      if (pages >= 10 || models.length >= 200) truncated = true;
    }
    if (!models.length)
      throw problem(
        502,
        "Codex 模型目录为空，已保留原有模型；请更新工具或重新登录",
      );
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
    kill.unref();
    child.once("close", () => clearTimeout(kill));
  }
  warnings.push(
    ...(await enrichModelMetadata(
      models,
      { ...config, baseUrl: "https://api.openai.com/v1" },
      catalogLoader,
    )),
  );
  return {
    models,
    fetchedAt,
    defaultModel,
    pages,
    skipped,
    truncated,
    warnings,
    message:
      "模型与能力来自当前登录的 Codex 工具目录；缺失规格可由公共目录精确补齐。CLI 可能使用缓存，目录不代表账号推理权限已经验证。",
  };
}
