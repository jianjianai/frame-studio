#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const HELP = `FRAME Studio 命令行

用法：frame <命令> [选项]

  serve                       启动 FRAME Studio（默认 http://127.0.0.1:4310）
      --port <端口> --host <地址> --home <数据目录> --dev（界面热更新，开发用）
  mcp                         以 stdio 提供 MCP 服务（给 Claude Desktop / Codex / Cursor 等使用）
      --work <作品 id>        只允许操作这个作品
      --read-only             只提供只读工具
  tools                       列出全部工具
  call <工具> [JSON 参数]     调用工具，例如 frame call work_context '{"work":"ab12cd34"}'
      --out <目录>            保存工具返回的图片
  new "<标题>"                新建作品
  import <文件夹>             把含 project.ts 的文件夹导入为新作品
  check <作品 id>             检查作品
  export <作品 id>            导出 MP4，--width --fps --start --end

连接已运行的 Studio：FRAME_URL（默认 http://127.0.0.1:4310）、FRAME_TOKEN（设置了密码时需要，在 设置 → MCP 中创建）。
`;

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "serve";
const { values, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    port: { type: "string" },
    host: { type: "string" },
    home: { type: "string" },
    work: { type: "string" },
    "read-only": { type: "boolean" },
    out: { type: "string" },
    width: { type: "string" },
    fps: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    repo: { type: "string" },
    dev: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || command === "help") {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.port) process.env.FRAME_PORT = values.port;
if (values.host) process.env.FRAME_HOST = values.host;
if (values.home) process.env.FRAME_HOME = path.resolve(values.home);
if (values.dev) process.env.FRAME_DEV = "1";

const base = (process.env.FRAME_URL || `http://127.0.0.1:${process.env.FRAME_PORT || 4310}`).replace(/\/+$/, "");
const headers = { "Content-Type": "application/json", ...(process.env.FRAME_TOKEN ? { Authorization: "Bearer " + process.env.FRAME_TOKEN } : {}) };

async function request(route, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data;
}
const reachable = () =>
  fetch(base + "/api/state", { headers, signal: AbortSignal.timeout(1500) }).then(
    (response) => response.ok,
    () => false,
  );

async function callTool(name, args) {
  const result = await request(`/api/tools/${name}`, args);
  if (result.text) console.log(result.text);
  else console.log(JSON.stringify(result.data, null, 2));
  if (result.meta) console.log(JSON.stringify(result.meta));
  if (result.images?.length) {
    const dir = path.resolve(values.out || ".");
    fs.mkdirSync(dir, { recursive: true });
    result.images.forEach((image, index) => {
      const file = path.join(dir, `${name}-${Date.now()}-${index}.${image.mimeType === "image/png" ? "png" : "jpg"}`);
      fs.writeFileSync(file, Buffer.from(image.data, "base64"));
      console.log("图片已保存：" + file);
    });
  }
  return result;
}

try {
  switch (command) {
    case "serve": {
      await import("../server/main.mjs");
      break;
    }
    case "mcp": {
      const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
      const scope = {
        ...(values.work ? (([repo, id]) => (id ? { repo, work: id } : { work: repo }))(values.work.split("/")) : {}),
        readOnly: Boolean(values["read-only"]),
      };
      if (await reachable()) {
        // Proxy to the running studio so there is one writer for works and settings.
        const { McpServer } = await import("@modelcontextprotocol/server");
        const { MCP_INSTRUCTIONS } = await import("../server/mcp.mjs");
        const tools = await request("/api/tools");
        serveStdio(() => {
          const server = new McpServer({ name: "frame", version: "proxy" }, { instructions: MCP_INSTRUCTIONS });
          for (const tool of tools) {
            if (scope.readOnly && !tool.readOnly) continue;
            if (scope.work && ["work_create", "works_list"].includes(tool.name)) continue;
            const passthrough = {
              "~standard": {
                version: 1,
                vendor: "frame",
                validate: (value) => ({ value }),
                jsonSchema: { input: () => tool.inputSchema, output: () => tool.inputSchema },
              },
            };
            server.registerTool(
              tool.name,
              {
                title: tool.title,
                description: tool.description,
                inputSchema: passthrough,
                annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, openWorldHint: false },
              },
              async (args) => {
                try {
                  // Same binding as an in-process scoped server: only the --work work is reachable.
                  if (scope.work && args.work && ![values.work, scope.work].includes(args.work)) throw new Error("这个 MCP 服务只能操作作品 " + values.work);
                  const result = await request(`/api/tools/${tool.name}`, scope.work && tool.inputSchema.properties?.work ? { ...args, work: values.work } : args);
                  const content = [];
                  if (result.text) content.push({ type: "text", text: result.text });
                  for (const image of result.images || []) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
                  if (!content.length) content.push({ type: "text", text: JSON.stringify(result.data) });
                  if (result.meta) content.push({ type: "text", text: JSON.stringify(result.meta) });
                  return {
                    content,
                    ...(result.structured && result.data && typeof result.data === "object" && !Array.isArray(result.data)
                      ? { structuredContent: result.data }
                      : {}),
                  };
                } catch (error) {
                  return { isError: true, content: [{ type: "text", text: "错误：" + error.message }] };
                }
              },
            );
          }
          return server;
        });
      } else {
        // No studio running: host one in this process (quietly; stdout belongs to MCP).
        process.env.FRAME_PORT = "0";
        console.log = console.info = (...items) => process.stderr.write(items.join(" ") + "\n");
        const { createApp } = await import("../server/app.mjs");
        const { plugins } = await import("../server/plugins.mjs");
        const { createMcpServer } = await import("../server/mcp.mjs");
        const app = await createApp({ plugins });
        await app.listen();
        serveStdio(() => createMcpServer(app.services.tools, scope));
      }
      break;
    }
    case "tools": {
      for (const tool of await request("/api/tools"))
        console.log(`${tool.name.padEnd(20)} ${tool.readOnly ? "只读" : "写入"}  ${tool.title}：${tool.description.split("。")[0]}`);
      break;
    }
    case "call": {
      const [name, json = "{}"] = positionals;
      if (!name) throw new Error("用法：frame call <工具> [JSON 参数]");
      await callTool(name, JSON.parse(json));
      break;
    }
    case "new": {
      await callTool("work_create", { title: positionals[0] || "未命名作品", ...(values.repo ? { repo: values.repo } : {}) });
      break;
    }
    case "import": {
      if (!positionals[0]) throw new Error("用法：frame import <文件夹>");
      const work = await request("/api/works/import", { source: path.resolve(positionals[0]), repo: values.repo || "local" });
      console.log(`已导入为作品 ${work.id}：${work.meta?.title ?? ""}`);
      break;
    }
    case "check": {
      const result = await callTool("work_check", { work: positionals[0] });
      process.exitCode = result.data?.ok ? 0 : 1;
      break;
    }
    case "export": {
      const options = Object.fromEntries(["width", "fps", "start", "end"].filter((key) => values[key]).map((key) => [key, Number(values[key])]));
      const started = await request("/api/tools/export_video", { work: positionals[0], ...options });
      const task = started.data.task;
      process.stderr.write(`导出任务 ${task}\n`);
      for (;;) {
        const status = (await request("/api/tools/task_status", { id: task, wait: 5 })).data;
        process.stderr.write(`\r${status.message || status.status} ${status.progress != null ? Math.round(status.progress * 100) + "%" : ""}      `);
        if (status.status !== "running") {
          process.stderr.write("\n");
          if (status.status !== "done") throw new Error(status.error || status.status);
          console.log(JSON.stringify(status.result, null, 2));
          break;
        }
      }
      break;
    }
    default:
      process.stdout.write(HELP);
      process.exitCode = 1;
  }
} catch (error) {
  if (error.cause?.code === "ECONNREFUSED" || /fetch failed/.test(error.message)) console.error(`无法连接 ${base}。先运行 frame serve，或设置 FRAME_URL。`);
  else console.error("错误：" + error.message);
  process.exitCode = 1;
}
