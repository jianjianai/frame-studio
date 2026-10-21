import { Readable } from "node:stream";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { appVersion } from "./config.mjs";
import { readJson } from "./http.mjs";
import { problem } from "./util.mjs";
import { CORE_TOOLS } from "./tools/registry.mjs";
import { withLeanJsonSchema, withPortableJsonSchema } from "./mcp-schema.mjs";

export const MCP_INSTRUCTIONS = `FRAME Studio 视频作品工具。作品是用 TypeScript 按绝对时间绘制的动画（Canvas/Pixi/Three/Lottie/gsap/图层合成），加多轨音频；用户在播放器里实时看到保存后的修改。
接口、作品结构和制作方法见 frame_guide（入门看 overview），工具各自带说明；需要什么自己读，不确定时先查，不要猜。work_context 是作品现状和用户正在看的地方，notes 是作品的需求与约定，experiences 是关联的经验库和作品的 经验.md。
只修改当前作品；同一作品库的其他作品只能读。需要用户同意：关联或取消关联经验库、素材库，新建经验库，保存作品版本（version_save），删除作品（work_delete 只做标记，由用户确认）。作品和 GitHub 有冲突或 GitHub 上有更新时先不要改，请用户在工作台里处理。已发布的作品不能修改。
经验：只和这个作品有关的写进作品的 AGENTS.md，可复用的用 experience_write 写进合适的关联经验库（不会自动保存为版本，保存用 experience_commit），没有合适的先写进作品的 经验.md；这些文档由你来保持整洁、精练。`;

/** Built-in agents have all of this, and more, in their session brief (the work-root AGENTS.md). */
const AGENT_INSTRUCTIONS = "FRAME Studio 视频作品工具。用法见作品根目录 AGENTS.md（会话说明）；作品文件用你自己的读写工具。";
/** Built-in agents edit the work's files with their own tools. */
const AGENT_HIDDEN = new Set(["work_create", "work_copy", "files_list", "files_batch"]);

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
  for (const clip of result.audio || []) content.push({ type: "audio", data: Buffer.isBuffer(clip.data) ? clip.data.toString("base64") : clip.data, mimeType: clip.mimeType });
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
  const server = new McpServer({ name: "frame", version: appVersion }, { instructions: scope.agent ? AGENT_INSTRUCTIONS : MCP_INSTRUCTIONS });
  for (const tool of registry.list()) {
    if (scope.readOnly && (!tool.readOnly || tool.signedIn)) continue;
    if (scope.work && ["work_create", "work_copy"].includes(tool.name)) continue;
    // A grant to one work (OAuth) sees that work only.
    if (scope.work && !scope.agent && tool.name === "works_list") continue;
    if (scope.agent && AGENT_HIDDEN.has(tool.name)) continue;
    // A session bound to one work changes only that work: its tools do not name a work (the
    // parameter is hidden, and ignored if a client sends it anyway). The studio's own AI keeps
    // it on reading tools, to look at the other works of the same repository (not on the logged-in
    // browser's: the works of a repository share its browser).
    const shape = tool.publicSchema.shape ?? {};
    const bound = scope.work && (!scope.agent || !tool.readOnly || tool.signedIn);
    const schema = bound && "work" in shape ? z.looseObject(Object.fromEntries(Object.entries(shape).filter(([key]) => key !== "work"))) : tool.publicSchema;
    // Built-in agents (Claude Code, Codex) read full JSON Schema, without what only validation needs; external clients get the portable subset.
    const inputSchema = scope.agent ? withLeanJsonSchema(schema) : withPortableJsonSchema(schema);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema,
        // Built-in agents: FRAME asks the user itself when the session's mode wants it (confirm
        // below), and every change is in the work's versions; a destructive hint would make
        // Codex ask again on each layers_edit / audio_edit / files_batch, even in auto-edit mode.
        // The logged-in browser's tools reach the web as the user: not read-only for other clients.
        annotations: {
          title: tool.title,
          readOnlyHint: Boolean(tool.readOnly) && !tool.signedIn,
          destructiveHint: Boolean(tool.destructive) && !scope.agent,
          openWorldHint: Boolean(tool.signedIn),
        },
        ...(CORE_TOOLS.has(tool.name) ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
      },
      async (args, ctx) => {
        try {
          const session = requestSession.getStore();
          const { work: _named, ...rest } = args ?? {};
          const input = bound ? rest : args;
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
  if (principal?.kind === "internal" && principal.work) return { work: principal.work, repo: principal.repo, agent: true };
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
        audio: (result.audio || []).map((clip) => ({ mimeType: clip.mimeType, data: Buffer.isBuffer(clip.data) ? clip.data.toString("base64") : clip.data })),
      };
    },
    { internal: true },
  );
  if (!tools) throw problem(500, "tool registry missing");
}
