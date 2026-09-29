import fs from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { PlatformClient, cliError } from "./platform/client.mjs";

export const help = `FRAME · 平台 CLI（远程作品使用 UUID；本地目录工程使用 pnpm film）
环境：FRAME_URL=https://frame.example FRAME_TOKEN=...（或 --token-file 私有文件）
  pnpm --silent platform actions [搜索词]                查找操作
  pnpm --silent platform describe <operation>            查看参数 JSON Schema
  pnpm --silent platform doctor                          服务、认证与工具可用性
  pnpm --silent platform <operation> [JSON | @file | -]   调用操作，兼容 frame_ 前缀
  pnpm --silent platform <operation> @input.json --wait   等到任务完成，输出最终结果
  pnpm --silent platform wait <task-UUID>                恢复等待，绝不重复提交任务
  pnpm --silent platform download <task-UUID> <artifact-path> --out film.mp4 [--force]
  pnpm --silent platform upload audio.wav --repo <UUID> --license "原创" [--resume <upload-UUID>]
  pnpm --silent platform read <work-UUID> <path> [--line 1 --lines 200]
  pnpm --silent platform write <work-UUID> <path> --file scene.ts --expected <SHA256>
  pnpm --silent platform write <work-UUID> <new-path> --file scene.ts --new
全局：--timeout <秒，默认600> --poll <秒，默认1> --json --allow-http（仅可信测试网络）
写入必须提供完整文件哈希或明确 --new；上传许可证必填；下载默认不覆盖。
stdout 始终是单个 JSON（help 除外）；进度及结构化错误写 stderr；失败退出码非零。
Ctrl-C/超时只停止客户端等待，不取消服务端任务；用 wait 恢复或显式调用 task_cancel。
示例：
  pnpm --silent platform works_context '{"id":"作品UUID","sections":["metadata","readme"]}'
  pnpm --silent platform works_task '{"id":"作品UUID","kind":"render","input":{"width":1280}}' --wait
  pnpm --silent platform works_browser '{"id":"作品UUID"}' --wait
  pnpm --silent platform works_patch @patch.json
也可通过 pnpm --silent film platform ... 使用相同入口。\n`;

function numberOption(value, fallback, name, min, max) {
  if (value === undefined) return fallback;
  const valueMs = Number(value) * 1000;
  if (
    !Number.isFinite(valueMs) ||
    !Number.isInteger(valueMs) ||
    valueMs < min ||
    valueMs > max
  )
    throw cliError("INVALID_ARGUMENT", `Invalid ${name}`);
  return valueMs;
}
function readText(file) {
  if (file !== 0 && fs.statSync(file).size > 2 * 1024 * 1024)
    throw cliError(
      "INPUT_TOO_LARGE",
      "Input exceeds 2 MiB; split into bounded edits.",
    );
  // Bound stdin too, without consuming an unbounded pipe in memory.
  const fd = file === 0 ? 0 : fs.openSync(file, "r"),
    chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024),
        n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      bytes += n;
      if (bytes > 2 * 1024 * 1024)
        throw cliError("INPUT_TOO_LARGE", "Input exceeds 2 MiB");
      chunks.push(buffer.subarray(0, n));
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    if (fd !== 0) fs.closeSync(fd);
  }
}
function inputObject(input = "{}") {
  let parsed;
  try {
    const text =
      input === "-"
        ? readText(0)
        : input.startsWith("@")
          ? readText(input.slice(1))
          : input;
    // Windows editors may prefix JSON with a UTF-8 BOM; source-file writes
    // intentionally preserve it because their hashes cover the original bytes.
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "INPUT_TOO_LARGE") throw error;
    throw cliError(
      "INVALID_JSON",
      "Input must be a JSON object, @UTF-8-file or - for stdin.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw cliError(
      "INVALID_JSON",
      "Operation arguments must be a JSON object.",
    );
  return parsed;
}
const options = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  wait: { type: "boolean" },
  force: { type: "boolean" },
  new: { type: "boolean" },
  timeout: { type: "string" },
  poll: { type: "string" },
  "token-file": { type: "string" },
  "allow-http": { type: "boolean" },
  out: { type: "string" },
  repo: { type: "string" },
  license: { type: "string" },
  mime: { type: "string" },
  resume: { type: "string" },
  file: { type: "string" },
  expected: { type: "string" },
  line: { type: "string" },
  lines: { type: "string" },
};
export async function runPlatformCli(
  argv,
  {
    env = process.env,
    signal,
    progress = (value) => console.error(JSON.stringify(value)),
  } = {},
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch {
    throw cliError(
      "INVALID_ARGUMENT",
      "Unknown or incomplete option. Run pnpm platform help.",
    );
  }
  const { values, positionals } = parsed,
    [name = "help", ...rest] = positionals;
  if (name === "help" || values.help)
    return { help, asJson: values.json === true };
  const specific = {
    doctor: [],
    actions: [],
    describe: [],
    wait: [],
    upload: ["repo", "license", "mime", "resume"],
    download: ["out", "force"],
    read: ["line", "lines"],
    write: ["file", "expected", "new"],
  };
  const allowed = new Set([
    "json",
    "timeout",
    "poll",
    "token-file",
    "allow-http",
    ...(specific[name] ?? ["wait"]),
  ]);
  for (const key of Object.keys(values))
    if (!allowed.has(key))
      throw cliError("INVALID_ARGUMENT", `--${key} is not valid for ${name}`);
  const arity = {
    doctor: [0, 0],
    actions: [0, 1],
    describe: [1, 1],
    wait: [1, 1],
    upload: [1, 1],
    download: [2, 2],
    read: [2, 2],
    write: [2, 2],
  }[name] ?? [0, 1];
  if (rest.length < arity[0] || rest.length > arity[1])
    throw cliError(
      "INVALID_ARGUMENT",
      "Unexpected arguments. Run pnpm platform help.",
    );
  const client = new PlatformClient({
    base: env.FRAME_URL,
    token: values["token-file"]
      ? readText(values["token-file"]).trim()
      : env.FRAME_TOKEN,
    timeoutMs: numberOption(
      values.timeout,
      600000,
      "--timeout (0.001..86400 seconds)",
      1,
      86400000,
    ),
    pollMs: numberOption(
      values.poll,
      1000,
      "--poll (0.01..60 seconds)",
      10,
      60000,
    ),
    allowHttp: values["allow-http"] === true,
    signal,
    progress,
  });
  if (name === "actions")
    return client.request(
      "/api/actions" +
        (rest[0] ? "?search=" + encodeURIComponent(rest[0]) : ""),
    );
  if (name === "describe") {
    const result = await client.request(
      "/api/actions?schema=1&name=" +
        encodeURIComponent(rest[0].replace(/^frame_/, "")),
    );
    if (!result[rest[0].replace(/^frame_/, "")]?.inputSchema)
      throw cliError(
        "SCHEMA_UNAVAILABLE",
        "This server does not expose parameter schemas yet. Upgrade the server or consult its MCP tool schema.",
      );
    return result;
  }
  if (name === "doctor") {
    const health = await client.request("/healthz"),
      me = await client.request("/api/me"),
      actions = await client.request("/api/actions");
    return {
      health,
      authenticated: Boolean(me.user),
      operations: Object.keys(actions).length,
      sourceEditing: Boolean(actions.works_patch),
      resumableUpload: Boolean(actions.upload_status),
    };
  }
  if (name === "wait") return client.wait(rest[0]);
  if (name === "download") {
    if (!values.out)
      throw cliError(
        "INVALID_ARGUMENT",
        "download requires --out; files are never saved to an implicit location.",
      );
    return client.download(rest[0], rest[1], values.out, {
      force: values.force,
    });
  }
  if (name === "upload")
    return client.upload(rest[0], {
      repo: values.repo ?? env.FRAME_REPOSITORY,
      license: values.license ?? env.FRAME_ASSET_LICENSE,
      mime: values.mime,
      resume: values.resume,
    });
  if (name === "read") {
    if (values.line === undefined && values.lines === undefined)
      return client.action("works_read", { id: rest[0], path: rest[1] });
    const startLine = Number(values.line ?? 1),
      lineCount = Number(values.lines ?? 200);
    if (
      !Number.isSafeInteger(startLine) ||
      startLine < 1 ||
      !Number.isInteger(lineCount) ||
      lineCount < 1 ||
      lineCount > 1000
    )
      throw cliError("INVALID_ARGUMENT", "Use --line >=1 and --lines 1..1000.");
    return client.action("works_read_lines", {
      id: rest[0],
      path: rest[1],
      startLine,
      lineCount,
    });
  }
  if (name === "write") {
    if (
      !values.file ||
      Boolean(values.new) === Boolean(values.expected) ||
      (values.expected && !/^[a-f0-9]{64}$/.test(values.expected))
    )
      throw cliError(
        "INVALID_ARGUMENT",
        "write requires --file and exactly one of --new or --expected <full-file-SHA256>.",
      );
    return client.action("works_write", {
      id: rest[0],
      path: rest[1],
      expectedSha256: values.new ? null : values.expected,
      content: readText(values.file),
    });
  }
  return client.run(name, inputObject(rest[0]), values.wait === true);
}

export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runPlatformCli(argv, { signal: controller.signal });
    console.log(
      result?.help && !result.asJson ? result.help : JSON.stringify(result),
    );
  } catch (error) {
    // Never print stacks, request headers or tokens, including upstream echoes.
    const redact = (text) =>
      process.env.FRAME_TOKEN
        ? String(text).replaceAll(process.env.FRAME_TOKEN, "[redacted]")
        : String(text);
    const code =
      typeof error.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)
        ? error.code
        : "CLI_ERROR";
    console.error(
      JSON.stringify({
        error: redact(error.message ?? "Operation failed"),
        code,
        status: error.status,
        task: error.task,
        upload: error.upload,
        offset: error.offset,
        state: error.state,
        recovery: error.recovery,
      }),
    );
    process.exitCode =
      code === "INTERRUPTED" ? 130 : code === "TIMEOUT" ? 124 : 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
