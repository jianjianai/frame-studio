import { Readable } from "node:stream";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { appVersion } from "./config.mjs";
import { readJson } from "./http.mjs";
import { problem } from "./util.mjs";
import { CORE_TOOLS } from "./tools/registry.mjs";

export const MCP_INSTRUCTIONS = `FRAME Studio 视频作品工具。作品是用 TypeScript 按绝对时间绘制的动画（Canvas/Pixi/Three/Babylon/Lottie/图层合成），加多轨音频。
工作顺序：work_context 了解现状（warnings 里的情况先处理）→ frame_guide 查接口（topics 一次查几个）→ 修改 → work_check（frames: true 同时得到分镜图）亲眼确认画面（preview_frames 看指定时刻或整体，preview_audio 确认声音）。
找代码、用法和经验用 search（scope 可含 work、used（作品用到的素材库文件，锁定的版本）、materials、experience、guide、engine，返回 文件:行号 和上下文），不要逐个读文件。
作品文件用 files_batch 读写（read / write / edit / delete / move，一次可以放多个；失败的逐项说明，只重试失败的；check: true 改完直接检查）。asset_import / material_write 一次可以导入多个；你所在电脑上的文件用 upload_link 拿到上传地址再用 curl 上传（不经过对话）；export_video 用 wait 等它完成，完成时返回下载地址。
用户在播放器里实时看到保存后的修改；work_context 的 userView 是用户正在看的时间点和选区。
看用户给的图片、视频素材用 asset_view；配乐要对上节拍时用 preview_audio 的 src + beats: true。
work_context 的 notes 是作品的需求与约定，experiences 是关联的经验库（可以有多个，各自的首页和文档目录）：动手前对照它们，相关文档用 experience_read 读全文；用户纠正你、确认了某种做法或解决了难题时，用 experience_write 整理进经验库（关联了多个时用 library 参数指定），用户认可后用 experience_commit 保存版本；用户要求时用 experience_link / materials_link 关联或取消关联经验库、素材库。用户要删除作品时用 work_delete（只做标记，由用户在作品列表中确认）。
作品发布后的复盘：review_read 看发布记录、按发布天数的数据、留存和复盘文档（平台导出的表格读成文字，截图给你看），review_write 记录（每次自动保存版本），reviews_compare 和其他作品在同一发布天数对比；你电脑上的导出表格、截图用 upload_link 的 review: true 上传。
混音：音效响时不要压低音乐（不加 duck）；只有人声（配音、旁白）才可能压低音乐，而且要用户明确要求。
图层用 layers_edit、混音用 audio_edit（update 只改给出的字段）/ audio_place、配音加字幕用 speech_synthesize（lines + place + subtitles）、字幕用 subtitles_edit；多个作品共用的素材和代码在素材库里（materials_list / materials_use，素材地址 materials/<库>/<文件>，代码用 import … from "@materials/<库>/<路径>" 导入；material_read / material_write 读改素材库）；参数格式不确定时先查 frame_guide 对应主题。
素材库里声明的角色、物品、场景、界面、效果、转场、文字和音效用 resources_search 找、resource_view 看用法和预览图：画一个东西之前先找，有就导入复用（不合适就给素材库代码加参数，不要拷进作品），音效用 audio_place 的 sound 放到音轨。引擎在任何文件里都用 import … from "@frame/engine/<模块>"；配乐节拍写进 project.ts 的 tempo（work_update），代码用 @frame/engine/tempo 的 beatAt / barAt 卡点。`;

/** Built-in agents have all of this, and more, in their session brief (the work-root AGENTS.md). */
const AGENT_INSTRUCTIONS = "FRAME Studio 视频作品工具。用法见作品根目录 AGENTS.md（会话说明）；作品文件用你自己的读写工具。";
/** Built-in agents edit the work's files with their own tools. */
const AGENT_HIDDEN = new Set(["works_list", "work_create", "files_list", "files_batch"]);

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
  const server = new McpServer({ name: "frame", version: appVersion }, { instructions: scope.agent ? AGENT_INSTRUCTIONS : MCP_INSTRUCTIONS });
  for (const tool of registry.list()) {
    if (scope.readOnly && !tool.readOnly) continue;
    if (scope.work && ["work_create", "works_list"].includes(tool.name)) continue;
    if (scope.agent && AGENT_HIDDEN.has(tool.name)) continue;
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
        // Built-in agents: FRAME asks the user itself when the session's mode wants it (confirm
        // below), and every change is in the work's versions; a destructive hint would make
        // Codex ask again on each layers_edit / audio_edit / files_batch, even in auto-edit mode.
        annotations: { title: tool.title, readOnlyHint: Boolean(tool.readOnly), destructiveHint: Boolean(tool.destructive) && !scope.agent, openWorldHint: false },
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
      };
    },
    { internal: true },
  );
  if (!tools) throw problem(500, "tool registry missing");
}
