import fs from "node:fs";
import { parseArgs } from "node:util";
import { PlatformClient, cliError } from "./platform/client.mjs";

const help = `FRAME · 远程 MCP / HTTP 命令行
  pnpm --silent platform --help                离线帮助，无需凭据
  pnpm --silent platform actions               查询操作列表
  pnpm --silent platform describe <operation>  查询准确 JSON 参数与副作用
  pnpm --silent platform workspace_context     工作区与创作流程导航
  pnpm --silent platform <operation> [JSON | @file | -]
  pnpm --silent platform works_task @task.json --wait [--timeout-ms 120000] [--events]
  pnpm --silent platform works_browser '{"id":"作品UUID"}' --wait
  pnpm --silent platform wait <task-UUID> [--after 0] [--timeout-ms 120000] [--events]
  pnpm --silent platform download <task-UUID> <artifact-path-or-name> --out <file> [--force]
  pnpm --silent platform upload <file> --repo <UUID> --license "来源许可" [--mime image/png]
  pnpm --silent platform upload <file> --resume <upload-UUID>

FRAME_URL=https://frame.example FRAME_TOKEN=...；可用 FRAME_REPOSITORY、FRAME_ASSET_LICENSE。
--request-timeout-ms 30000 控制单次 HTTP 请求；--timeout-ms 控制等待的总时长。
操作参数可传 JSON、@文件或 - 从 stdin 读取。frame_ 前缀可省略。UUID 不是本地 project slug。
结果仅写 stdout（JSON），进度／错误写 stderr；pnpm 使用 --silent 可直接交给 JSON 解析器。
退出码：0 成功，1 操作失败，2 等待超时，130 本地中断。超时／中断不取消远程任务。
请求不会自动重试或跟随重定向；失败后检查状态。文件上传失败保留 uploadId，可 --resume。
本地工程制作另用 pnpm film help。`;
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let client;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      wait: { type: "boolean" },
      events: { type: "boolean" },
      "timeout-ms": { type: "string" },
      "request-timeout-ms": { type: "string" },
      after: { type: "string" },
      out: { type: "string" },
      force: { type: "boolean" },
      repo: { type: "string" },
      license: { type: "string" },
      mime: { type: "string" },
      resume: { type: "string" },
    },
  });
  const [name, input, ...extra] = positionals;
  if (values.help || !name || name === "help") {
    console.log(values.json ? JSON.stringify({ help }) : help);
  } else {
    const number = (key, fallback, max) => {
      if (values[key] === undefined) return fallback;
      if (
        !/^\d+$/.test(values[key]) ||
        !Number.isSafeInteger(Number(values[key])) ||
        Number(values[key]) < 1 ||
        Number(values[key]) > max
      )
        throw cliError(
          "INVALID_ARGUMENT",
          `--${key} must be an integer between 1 and ${max}.`,
        );
      return Number(values[key]);
    };
    const common = ["json", "request-timeout-ms"];
    const specific =
      name === "upload"
        ? ["repo", "license", "mime", "resume"]
        : name === "download"
          ? ["out", "force"]
          : name === "wait"
            ? ["timeout-ms", "after", "events"]
            : ["actions", "describe"].includes(name)
              ? []
              : ["wait", "timeout-ms", "events"];
    for (const key of Object.keys(values))
      if (![...common, ...specific].includes(key))
        throw cliError(
          "INVALID_ARGUMENT",
          `--${key} is not valid for ${name}.`,
        );
    if (extra.length && !(name === "download" && extra.length === 1))
      throw cliError(
        "INVALID_ARGUMENT",
        "Too many arguments. Quote JSON or use @file / stdin (-).",
      );
    if (name === "actions" && input !== undefined)
      throw cliError(
        "INVALID_ARGUMENT",
        "actions takes no argument; use describe <operation>.",
      );
    if (["describe", "wait", "upload", "download"].includes(name) && !input)
      throw cliError(
        "INVALID_ARGUMENT",
        `${name} requires an argument; run --help.`,
      );
    if (name === "download" && (!extra[0] || !values.out))
      throw cliError(
        "INVALID_ARGUMENT",
        "download requires a task UUID, artifact path/name and --out.",
      );
    if (
      values.wait &&
      ![
        "works_task",
        "task_create",
        "works_browser",
        "works_version_preview",
        "works_chat_send",
        "chat_send",
        "task_retry_publish",
      ].includes(name.replace(/^frame_/, ""))
    )
      throw cliError(
        "INVALID_ARGUMENT",
        "--wait is only valid for task-producing operations; no request was sent.",
      );
    if (values.after && !/^\d{1,19}$/.test(values.after))
      throw cliError(
        "INVALID_ARGUMENT",
        "--after must be a decimal event cursor.",
      );
    const waitTimeout = number("timeout-ms", 120000, 24 * 3600000);
    const emit = (value) => console.log(JSON.stringify(value));
    let lastState;
    const waitOptions = {
      timeoutMs: waitTimeout,
      after: values.after ?? "0",
      onStatus: (status) => {
        if (lastState !== status.task.state) {
          process.stderr.write(
            `Task ${status.task.id}: ${status.task.state}\n`,
          );
          lastState = status.task.state;
        }
      },
      onEvents: (events) => {
        if (values.events)
          for (const event of events)
            process.stderr.write(JSON.stringify({ event }) + "\n");
      },
    };
    // Parse caller input before making any request, so malformed JSON cannot mutate the server.
    let args = {};
    if (!["actions", "describe", "wait", "upload", "download"].includes(name)) {
      const text =
        input === "-"
          ? fs.readFileSync(0, "utf8")
          : input?.startsWith("@")
            ? fs.readFileSync(input.slice(1), "utf8")
            : (input ?? "{}");
      if (Buffer.byteLength(text) > 2 * 1024 * 1024)
        throw cliError(
          "INPUT_TOO_LARGE",
          "JSON input exceeds 2 MiB; use upload for media.",
        );
      try {
        args = JSON.parse(text);
      } catch {
        throw cliError(
          "INVALID_JSON",
          "Invalid JSON. Quote the argument, use @file, or pipe JSON with -.",
        );
      }
      if (args === null || Array.isArray(args) || typeof args !== "object")
        throw cliError(
          "INVALID_JSON",
          "Operation arguments must be a JSON object.",
        );
      if ((values.events || values["timeout-ms"]) && !values.wait)
        throw cliError(
          "INVALID_ARGUMENT",
          "--events and --timeout-ms require --wait for an operation.",
        );
    }
    client = new PlatformClient({
      url: process.env.FRAME_URL,
      token: process.env.FRAME_TOKEN,
      timeoutMs: number("request-timeout-ms", 30000, 3600000),
      signal: controller.signal,
    });
    let result;
    if (name === "actions") result = await client.request("api/actions");
    else if (name === "describe") result = await client.describe(input);
    else if (name === "wait") result = await client.wait(input, waitOptions);
    else if (name === "upload")
      result = await client.upload(input, {
        repo: values.repo ?? process.env.FRAME_REPOSITORY,
        license: values.license ?? process.env.FRAME_ASSET_LICENSE,
        mime: values.mime,
        resume: values.resume,
        onProgress: (progress) =>
          process.stderr.write(JSON.stringify(progress) + "\n"),
      });
    else if (name === "download")
      result = await client.download(input, extra[0], values.out, {
        force: values.force,
      });
    else {
      result = await client.call(name, args);
      if (values.wait && name.replace(/^frame_/, "") === "works_browser") {
        result = await client.waitForBrowser(args.id, result, waitOptions);
      } else if (values.wait) {
        const task = result.task ?? result;
        if (!task.id || !task.state || !task.kind)
          throw cliError(
            "NOT_A_TASK",
            "Operation completed but did not return a task; --wait is only for task-producing operations.",
          );
        result = await client.wait(task.id, waitOptions);
      }
    }
    emit(result);
    if (
      (name === "wait" || values.wait) &&
      result.state !== "ready" &&
      result.task.state !== "succeeded"
    )
      process.exitCode = 1;
  }
} catch (error) {
  const interrupted = controller.signal.aborted;
  const message = interrupted
    ? "Interrupted locally; remote tasks/uploads were not cancelled."
    : client
      ? client.redact(error.message)
      : String(error.message)
          .split(process.env.FRAME_TOKEN || "\0")
          .join("[redacted]");
  process.stderr.write(
    JSON.stringify({
      error: message,
      code: interrupted ? "INTERRUPTED" : (error.code ?? "CLI_ERROR"),
      ...Object.fromEntries(
        ["status", "recovery", "requestId", "taskId", "uploadId"]
          .filter((k) => error[k] !== undefined)
          .map((k) => [k, error[k]]),
      ),
    }) + "\n",
  );
  process.exitCode = interrupted ? 130 : (error.exitCode ?? 1);
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
