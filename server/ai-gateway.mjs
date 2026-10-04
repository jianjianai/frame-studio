import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { FrameBootstrapSchema } from "../integrations/t3-code/shared/bridge.mjs";
import { problem } from "./security.mjs";
import { requestExternalOrigin } from "./request-origin.mjs";
import { creatorPrompt } from "./creator-workspace.mjs";

const hop = new Set(["host", "connection", "upgrade", "authorization", "cookie", "content-length", "transfer-encoding", "x-frame-work-id"]);
const bearer = req => req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;

/** Validate native identifiers before forwarding work-scoped HTTP or RPC. */
export async function assertAiScope(manager, workId, value, { draft = false, binding: knownBinding } = {}) {
  const binding = knownBinding || await manager.store.getWork(workId);
  if (!binding?.projectId) throw problem(409, "作品原生项目尚未就绪");
  const walk = async item => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { for (const entry of item) await walk(entry); return; }
    for (const [key, entry] of Object.entries(item)) {
      if (["projectId", "nativeProjectId"].includes(key) && typeof entry === "string" && entry !== binding.projectId)
        throw problem(403, "请求的原生项目不属于当前作品");
      if (key === "threadId" && typeof entry === "string") {
        if (!await manager.thread(workId, entry, { allowDraft: draft })) throw problem(404, "原生聊天不属于当前作品");
      }
      if (key === "prepareWorktree" || key === "worktreePath" && entry != null && entry !== binding.cwd)
        throw problem(403, "当前作品聊天必须使用作品的实际目录");
      if (["cwd", "workspaceRoot", "projectCwd"].includes(key) && entry !== binding.cwd)
        throw problem(403, "请求目录不属于当前作品");
      await walk(entry);
    }
  };
  await walk(value);
}
export function scopedAiPayload(value, projectId, ownsThread = null) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(entry => scopedAiPayload(entry, projectId, ownsThread));
  if (ownsThread && value.terminal?.threadId && !ownsThread(value.terminal.threadId) ||
      ownsThread && value.terminalId && value.threadId && !ownsThread(value.threadId)) return null;
  if (value.kind === "project-upserted" && value.project?.id !== projectId ||
      value.kind === "project-removed" && value.projectId !== projectId ||
      value.kind === "thread-upserted" && value.thread?.projectId !== projectId) return null;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "projects" && Array.isArray(item)) out[key] = item.filter(project => project.id === projectId).map(project => scopedAiPayload(project, projectId, ownsThread));
    else if (key === "threads" && Array.isArray(item)) out[key] = item.filter(thread => thread.projectId === undefined || thread.projectId === projectId).map(thread => scopedAiPayload(thread, projectId, ownsThread));
    else if (key === "terminals" && Array.isArray(item) && ownsThread) out[key] = item.filter(terminal => ownsThread(terminal.threadId));
    else out[key] = scopedAiPayload(item, projectId, ownsThread);
  }
  return out;
}

export async function installAiGateway({ app, manager, workService, store, workspace, authenticate, localMode = false }) {
  const bootstrap = async (req, workId, nonce) => {
    const work = await workService.works.get(workId, { active: true }), ready = await manager.ensure(work);
    const scope = localMode ? "local" : "platform";
    return FrameBootstrapSchema.parse({ version: 1, workId, projectId: ready.projectId, environmentId: ready.environmentId,
      cwd: ready.cwd, label: work.title.slice(0, 160), nonce, parentOrigin: requestExternalOrigin(req, { localMode }),
      userScope: scope, basePath: "/ai/", embedPath: "/ai/works/" + workId + "/" });
  };
  app.get("/api/ai/session", async () => ({ uiUrl: "/ai/", standaloneUrl: "/ai/", nativeSettingsUrl: "/ai/settings/providers", bootstrap: null }));
  app.get("/api/ai/works/:workId/session", async req => {
    const value = await bootstrap(req, z.uuid().parse(req.params.workId), randomBytes(24).toString("base64url"));
    return { uiUrl: value.embedPath + "?frameNonce=" + value.nonce, standaloneUrl: "/ai/", nativeSettingsUrl: "/ai/settings/providers",
      bootstrap: value, status: await workService.status(value.workId) };
  });
  app.get("/api/ai/works/:workId/status", async req => {
    const workId = z.uuid().parse(req.params.workId), status = await workService.status(workId);
    if (!req.query.threadId) return status;
    const thread = await manager.thread(workId, z.string().min(1).max(256).parse(req.query.threadId));
    if (!thread) throw problem(404, "原生聊天不属于当前作品");
    return { ...status, selectedThread: { id: thread.id, projectId: thread.projectId, label: "作品工作区", previewAllowed: true } };
  });
  app.post("/api/ai/works/:workId/messages/freeze", req => workService.freeze(z.uuid().parse(req.params.workId), req.body));
  app.get("/api/ai/works/:workId/messages/:messageId", async req => {
    const workId = z.uuid().parse(req.params.workId), threadId = z.string().min(1).max(256).parse(req.query.threadId);
    if (!await manager.thread(workId, threadId)) throw problem(404, "原生聊天不属于当前作品");
    const message = await store.getMessage({ workId, threadId, messageId: z.uuid().parse(req.params.messageId) });
    if (!message) throw problem(404, "冻结消息不存在");
    return { ...message.envelope, state: "frozen", recovery: "原生 T3 保存提交回执；重试时使用相同消息 ID。" };
  });
  app.post("/api/ai/works/:workId/validations/:validationId/retry", async req => {
    const workId = z.uuid().parse(req.params.workId); await workService.works.get(workId, { active: true });
    return workspace.retry(workId, z.uuid().parse(req.params.validationId));
  });
  app.post("/api/ai/internal/context", async req => {
    if (!await manager.authorizeInternal(bearer(req))) throw problem(401, "原生服务身份验证失败");
    const value = z.strictObject({ version: z.literal(1), threadId: z.string().min(1).max(256),
      nativeProjectId: z.string().min(1).max(256).optional(), cwd: z.string().min(1).max(4096), provider: z.string().max(128).optional() }).parse(req.body);
    return manager.nativeContext(value);
  });
  app.get("/api/ai/internal/:workId/context", async req => {
    const context = await manager.threadContext(bearer(req));
    if (!context || context.aiWork !== z.uuid().parse(req.params.workId)) throw problem(401, "作品聊天身份验证失败");
    return { version: 1, workId: context.aiWork, project: context.project, instructions: creatorPrompt(context.project) };
  });

  const routeIdentity = async (req, path) => {
    const match = /^\/ai\/works\/([0-9a-f-]{36})\/(.*)$/i.exec(path);
    if (!match) return { workId: null, relative: path.slice(4) || "/", basePath: "/ai/" };
    const workId = z.uuid().parse(match[1]); await workService.works.get(workId, { active: true });
    let binding = await store.getWork(workId);
    if (!binding?.projectId || binding.state !== "ready") {
      await manager.ensure(workId);
      binding = await store.getWork(workId);
    }
    if (!binding?.projectId || !binding.cwd) throw problem(409, "作品原生项目尚未就绪");
    // Native project IDs and canonical directories are immutable for an open
    // work connection. Capture them once so streamed tokens need no SQL query.
    const projectBinding = Object.freeze({ projectId: binding.projectId, cwd: binding.cwd });
    return { workId, projectBinding, relative: "/" + match[2], basePath: "/ai/works/" + workId + "/" };
  };
  const proxy = async (req, reply) => {
    await authenticate(req);
    const parsed = new URL(req.raw.url, "http://frame.local"), identity = await routeIdentity(req, parsed.pathname);
    const { workId, relative, basePath, projectBinding } = identity;
    parsed.searchParams.delete("frameNonce");
    const endpoint = new URL(relative + parsed.search, manager.client.url), token = await manager.client.token();
    if (workId) {
      const threadMatch = /^\/api\/orchestration\/threads\/([^/]+)/.exec(relative);
      if (threadMatch && !await manager.thread(workId, decodeURIComponent(threadMatch[1]))) throw problem(404, "原生聊天不属于当前作品");
      await assertAiScope(manager, workId, req.body, { draft: req.body?.type === "thread.turn.start", binding: projectBinding });
      if (req.body?.type?.startsWith("project.")) throw problem(403, "请在完整原生工作台管理项目");
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !hop.has(name.toLowerCase())));
    headers.authorization = "Bearer " + token; headers.host = endpoint.host; headers["accept-encoding"] = "identity";
    const body = req.body === undefined ? null : typeof req.body === "string" || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
    if (body !== null) headers["content-length"] = Buffer.byteLength(body);
    return new Promise((resolve, reject) => {
      const upstream = (endpoint.protocol === "https:" ? https : http).request(endpoint, { method: req.method, headers }, response => {
        const type = String(response.headers["content-type"] || ""), rewrite = type.includes("text/html") || workId && type.includes("application/json");
        const responseHeaders = Object.fromEntries(Object.entries(response.headers).filter(([key]) => !["content-length", "content-encoding", "set-cookie", "transfer-encoding", "connection"].includes(key)));
        if (rewrite) {
          const chunks = []; let bytes = 0;
          response.on("data", chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) { upstream.destroy(); reject(problem(413, "原生响应超出限制")); } else chunks.push(chunk); });
          response.on("end", async () => {
            try {
              let text = Buffer.concat(chunks).toString("utf8");
              if (type.includes("text/html")) {
                const value = workId ? await bootstrap(req, workId, z.string().regex(/^[A-Za-z0-9_-]{24,128}$/).parse(req.query.frameNonce)) : null;
                const config = JSON.stringify({ basePath, ...(value ? { bootstrap: value } : {}) }).replaceAll("<", "\\u003c");
                text = text.replace("<head>", "<head><base href=\"" + basePath + "\"><script>window.__FRAME_AI_GATEWAY__=" + config + ";" + (value ? "window.__FRAME_AI__=" + JSON.stringify(value).replaceAll("<", "\\u003c") + ";" : "") + "</script>")
                  .replaceAll('src="/assets/', 'src="' + basePath + 'assets/').replaceAll('href="/assets/', 'href="' + basePath + 'assets/');
              } else text = JSON.stringify(scopedAiPayload(JSON.parse(text), projectBinding.projectId));
              reply.code(response.statusCode || 502).headers(responseHeaders).send(text); resolve();
            } catch (error) { reject(error); }
          });
        } else { reply.hijack(); reply.raw.writeHead(response.statusCode || 502, responseHeaders); response.pipe(reply.raw); response.once("end", resolve); }
      });
      upstream.once("error", () => reject(problem(502, "T3 原生服务连接失败")));
      upstream.setTimeout(30000, () => upstream.destroy()); req.raw.once("aborted", () => upstream.destroy());
      if (body !== null) upstream.end(body); else upstream.end();
    });
  };
  app.route({ method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], url: "/ai/*", handler: proxy });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  const upgrade = async (req, socket, head) => {
    const parsed = new URL(req.url, "http://frame.local"); if (!parsed.pathname.startsWith("/ai/") || !parsed.pathname.endsWith("/ws")) return;
    try {
      req.cookies = app.parseCookie(req.headers.cookie || ""); await authenticate(req);
      const { workId, projectBinding } = await routeIdentity(req, parsed.pathname);
      if (workId) await manager.client.shell();
      const ownsThread = workId ? id => manager.client.threads.get(id)?.projectId === projectBinding.projectId : null;
      const { ticket } = await manager.client.request("/api/auth/websocket-ticket", { method: "POST" });
      const url = new URL("/ws", manager.client.url); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.searchParams.set("wsTicket", ticket);
      const upstream = new WebSocket(url, { maxPayload: 16 * 1024 * 1024 });
      upstream.once("error", () => socket.destroy());
      upstream.once("open", () => wss.handleUpgrade(req, socket, head, client => {
        let chain = Promise.resolve();
        client.on("message", data => {
          chain = chain.then(async () => {
            const decoded = JSON.parse(data.toString()), messages = Array.isArray(decoded) ? decoded : [decoded];
            for (const message of messages) if (workId && message._tag === "Request") {
              if (message.tag === "orchestration.dispatchCommand" && message.payload?.type?.startsWith("project.")) throw problem(403, "请在完整原生工作台管理项目");
              await assertAiScope(manager, workId, message.payload, { draft: message.payload?.type === "thread.turn.start", binding: projectBinding });
            }
            if (upstream.readyState === 1) upstream.send(data);
          }).catch(() => client.close(1008, "Work scope mismatch"));
        });
        upstream.on("message", data => { if (client.readyState !== 1) return;
          if (!workId) return client.send(data);
          try {
            const decoded = JSON.parse(data.toString()), messages = Array.isArray(decoded) ? decoded : [decoded];
            for (const message of messages) if (message._tag === "Chunk") {
              message.values = message.values.map(value => scopedAiPayload(value, projectBinding.projectId, ownsThread)).filter(Boolean);
              if (!message.values.length) message.values = [{ kind: "synchronized" }];
            } else if (message._tag === "Exit" && message.exit?._tag === "Success") message.exit.value = scopedAiPayload(message.exit.value, projectBinding.projectId, ownsThread);
            if (client.readyState === 1) client.send(JSON.stringify(Array.isArray(decoded) ? messages : messages[0]));
          } catch { client.close(1011, "Native proxy unavailable"); }
        });
        client.once("close", () => upstream.close()); client.on("error", () => upstream.close());
        upstream.once("close", () => client.close(1013, "Native connection closed"));
      }));
    } catch { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); }
  };
  app.server.on("upgrade", upgrade);
  app.addHook("onClose", async () => { app.server.off("upgrade", upgrade); for (const socket of wss.clients) socket.terminate(); wss.close(); });
}
