import { Readable } from "node:stream";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { appVersion } from "./config.mjs";
import { readJson } from "./http.mjs";
import { problem } from "./util.mjs";
import { CORE_TOOLS } from "./tools/registry.mjs";

export const MCP_INSTRUCTIONS = `FRAME Studio 视频作品工具。作品是用 TypeScript 按绝对时间绘制的动画（Canvas/Pixi/Three/Babylon/Lottie/Remotion/图层合成），加多轨音频。
工作顺序：work_context 了解现状 → frame_guide 查接口 → 修改文件 → work_check → preview_frames/storyboard 亲眼确认画面（preview_audio 确认声音）。
用户在播放器里实时看到保存后的修改；work_context 的 userView 是用户正在看的时间点和选区。
work_context 的 notes 是作品的需求与约定，experiences 是关联的经验库（可以有多个，各自的首页和文档目录）：动手前对照它们，相关文档用 experience_read 读全文；用户纠正你、确认了某种做法或解决了难题时，用 experience_edit/experience_write 整理进经验库（关联了多个时用 library 参数指定）。
图层用 layers_edit、混音用 audio_edit/audio_place、配音加字幕用 speech_synthesize（lines + place + subtitles）、字幕用 subtitles_edit；参数格式不确定时先查 frame_guide 对应主题。`;

/**
 * The chat session behind an MCP request (from the agent's internal token). Kept out of
 * the handler cache key: handlers are per scope, sessions come and go.
 */
const requestSession = new AsyncLocalStorage();

/** Convert a tool result into MCP content blocks. */
export function toMcpResult(result) {
  const content = [];
  if (result.text) content.push({ type: "text", text: result.text });
  for (const image of result.images || [])
    content.push({ type: "image", data: Buffer.isBuffer(image.data) ? image.data.toString("base64") : image.data, mimeType: image.mimeType });
  if (!content.length) content.push({ type: "text", text: JSON.stringify(result.data ?? null) });
  if (result.meta) content.push({ type: "text", text: JSON.stringify(result.meta) });
  const structured = result.structured && result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data : undefined;
  return { content, ...(structured ? { structuredContent: structured } : {}) };
}

export const toMcpError = (error) => ({
  isError: true,
  content: [{ type: "text", text: `错误：${error.message}${error.details ? "\n" + JSON.stringify(error.details, null, 2).slice(0, 4000) : ""}` }],
});

const DECLINED = "用户没有允许这次修改（当前模式下修改需要用户确认）。不要换别的方式做同样的修改，先问用户想怎么做。";

/**
 * A fresh McpServer exposing the registry, optionally bound to one work. `confirm` asks the
 * user of a chat session before a tool changes anything (it decides when that is needed).
 */
export function createMcpServer(registry, scope = {}, { confirm } = {}) {
  const server = new McpServer({ name: "frame", version: appVersion }, { instructions: MCP_INSTRUCTIONS });
  for (const tool of registry.list()) {
    if (scope.readOnly && !tool.readOnly) continue;
    if (scope.work && ["work_create", "works_list"].includes(tool.name)) continue;
    // A session bound to one work never names a work: the parameter is hidden (fewer tokens,
    // nothing to get wrong) and ignored if a client sends it anyway.
    const shape = tool.publicSchema.shape ?? {};
    const inputSchema = scope.work && "work" in shape ? z.looseObject(Object.fromEntries(Object.entries(shape).filter(([key]) => key !== "work"))) : tool.publicSchema;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema,
        annotations: { title: tool.title, readOnlyHint: Boolean(tool.readOnly), destructiveHint: Boolean(tool.destructive), openWorldHint: false },
        ...(CORE_TOOLS.has(tool.name) ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
      },
      async (args, ctx) => {
        try {
          const session = requestSession.getStore();
          const { work: _named, ...rest } = args ?? {};
          const input = scope.work ? rest : args;
          if (session && confirm && !tool.readOnly && !(await confirm(session, tool, input, ctx?.mcpReq?.signal)))
            return { isError: true, content: [{ type: "text", text: DECLINED }] };
          return toMcpResult(await registry.call(tool.name, input, session ? { ...scope, session } : scope));
        } catch (error) {
          if (!error.status) console.error(`tool ${tool.name} failed`, error);
          return toMcpError(error);
        }
      },
    );
  }
  return server;
}

/** Scope of a request: internal agent tokens are bound to their work; OAuth grants may be bound and/or read-only. */
export function scopeOf(principal) {
  if (principal?.kind === "internal" && principal.work) return { work: principal.work, repo: principal.repo };
  if (principal?.kind === "oauth")
    return { ...(principal.work ? { work: principal.work, repo: principal.repo } : {}), ...(principal.readOnly ? { readOnly: true } : {}) };
  if (principal?.kind === "token" && principal.readOnly) return { readOnly: true };
  return {};
}

export function mcpPlugin(services) {
  const { router, tools } = services;
  const handlers = new Map();
  const confirm = (session, tool, args, signal) => services.ai?.confirmTool(session, tool, args, signal) ?? true;
  const handlerFor = (scope) => {
    const key = JSON.stringify(scope);
    if (!handlers.has(key))
      handlers.set(
        key,
        createMcpHandler(() => createMcpServer(tools, scope, { confirm }), { onerror: (error) => console.warn("MCP:", error.message) }),
      );
    return handlers.get(key);
  };
  const serve = ({ req, res, principal }) =>
    requestSession.run(principal?.kind === "internal" ? principal.session : undefined, async () => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const body = ["GET", "HEAD", "DELETE"].includes(req.method) ? undefined : Readable.toWeb(req);
      const request = new Request(url, { method: req.method, headers: req.headers, body, duplex: "half" });
      const response = await handlerFor(scopeOf(principal)).fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) return res.end();
      for await (const chunk of response.body) res.write(chunk);
      res.end();
    });
  for (const method of ["get", "post", "delete"]) router[method]("/mcp", serve, { internal: true, raw: true });
  services.closers.push(async () => {
    for (const handler of handlers.values()) await handler.close();
  });

  // Plain JSON face of the same tools for the CLI and the studio.
  router.get("/api/tools", () => tools.describe(), { internal: true });
  router.post(
    "/api/tools/:name",
    async ({ req, params, principal }) => {
      const args = await readJson(req);
      const result = await tools.call(params.name, args, scopeOf(principal));
      return {
        text: result.text ?? null,
        data: result.data ?? null,
        meta: result.meta ?? null,
        structured: Boolean(result.structured),
        images: (result.images || []).map((image) => ({
          mimeType: image.mimeType,
          label: image.label,
          data: Buffer.isBuffer(image.data) ? image.data.toString("base64") : image.data,
        })),
      };
    },
    { internal: true },
  );
  if (!tools) throw problem(500, "tool registry missing");
}
