import { Readable } from "node:stream";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { appVersion } from "./config.mjs";
import { readJson } from "./http.mjs";
import { problem } from "./util.mjs";

export const MCP_INSTRUCTIONS = `FRAME Studio 视频作品工具。作品是用 TypeScript 按绝对时间绘制的动画（Canvas/Pixi/Three/Babylon/Lottie/Remotion/图层合成），加多轨音频。
工作顺序：work_context 了解现状 → frame_guide 查接口 → 修改文件 → work_check → preview_frames/storyboard 亲眼确认画面（preview_audio 确认声音）。
用户在播放器里实时看到保存后的修改；work_context 的 userView 是用户正在看的时间点和选区。
作品关联了经验库时，开始前先 experience_read 阅读，照着已有经验做；用户纠正你、确认了某种做法或解决了难题时，用 experience_edit/experience_write 整理进经验库。
图层用 layers_edit、混音用 audio_edit/audio_place、配音加字幕用 speech_synthesize（lines + place + subtitles）、字幕用 subtitles_edit；参数格式不确定时先查 frame_guide 对应主题。`;

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

/** A fresh McpServer exposing the registry, optionally bound to one work. */
export function createMcpServer(registry, scope = {}) {
  const server = new McpServer({ name: "frame", version: appVersion }, { instructions: MCP_INSTRUCTIONS });
  for (const tool of registry.list()) {
    if (scope.readOnly && !tool.readOnly) continue;
    if (scope.work && ["work_create", "works_list"].includes(tool.name)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.publicSchema,
        annotations: { title: tool.title, readOnlyHint: Boolean(tool.readOnly), destructiveHint: Boolean(tool.destructive), openWorldHint: false },
      },
      async (args) => {
        try {
          return toMcpResult(await registry.call(tool.name, args, scope));
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
  const handlerFor = (scope) => {
    const key = JSON.stringify(scope);
    if (!handlers.has(key))
      handlers.set(
        key,
        createMcpHandler(() => createMcpServer(tools, scope), { onerror: (error) => console.warn("MCP:", error.message) }),
      );
    return handlers.get(key);
  };
  const serve = async ({ req, res, principal }) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const body = ["GET", "HEAD", "DELETE"].includes(req.method) ? undefined : Readable.toWeb(req);
    const request = new Request(url, { method: req.method, headers: req.headers, body, duplex: "half" });
    const response = await handlerFor(scopeOf(principal)).fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return res.end();
    for await (const chunk of response.body) res.write(chunk);
    res.end();
  };
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
