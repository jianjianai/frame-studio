import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { FrameBootstrapSchema } from "../integrations/paseo/frame-plugin/shared/bridge.mjs";
import { paseoSessionEnvironment } from "./paseo-credentials.mjs";
import { confinedAsync } from "./project-files.mjs";
import { hash, problem } from "./security.mjs";
import { creatorPrompt } from "./creator-workspace.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const eventSchema = z.strictObject({ version: z.literal(1),
  type: z.enum(["agent.created", "agent.turn_started", "agent.turn_ended", "agent.permission_requested",
    "agent.permission_resolved", "workspace.created", "workspace.archived", "agent.archived"]),
  agentId: z.string().min(1).max(256).optional(), workspaceId: z.string().min(1).max(4096).optional(),
});
const htmlJson = value => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
const mime = file => ({ ".js": "application/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".wasm": "application/wasm", ".html": "text/html" }[path.extname(file)] || "application/octet-stream");
const nonceSchema = z.string().regex(/^[a-zA-Z0-9_-]{24,128}$/);
const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "cookie", "authorization", "host"]);

/** Transparent transport to the complete upstream daemon; FRAME does not parse native conversations. */
export async function installPaseoGateway({ app, manager, workService, store, drafts, authenticate, origin,
  connections, db, data, secrets, localMode = false, uiRoot = process.env.FRAME_PASEO_UI || path.join(root, ".cache/paseo-runtime/web") }) {
  origin = new URL(origin).origin;
  const scope = hash("frame-admin:" + origin).slice(0, 32);
  const bootstrap = async (workId, nonce) => {
    const work = await workService.works.get(workId, { active: true });
    const runtime = await manager.ensure(work);
    return FrameBootstrapSchema.parse({ version: 1, workId, userScope: scope,
      nonce: nonceSchema.parse(nonce), basePath: "/paseo/" + workId + "/",
      parentOrigin: origin, serverId: runtime.serverId, workspaceId: runtime.workspaceId, label: work.title.slice(0, 160) });
  };
  app.get("/api/paseo/works/:workId/session", async req => {
    const nonce = randomBytes(24).toString("base64url");
    const value = await bootstrap(z.uuid().parse(req.params.workId), nonce);
    return { uiUrl: value.basePath + "?frameNonce=" + nonce, bootstrap: value,
      status: await workService.status(value.workId) };
  });
  app.get("/api/paseo/works/:workId/status", async req => {
    const workId = z.uuid().parse(req.params.workId);
    const status = await workService.status(workId);
    if (!req.query.agentId) return status;
    const agentId = z.string().min(1).max(256).parse(req.query.agentId);
    const agent = await manager.agent(workId, agentId);
    if (!agent) throw problem(404, "Native agent does not belong to this work");
    const workspace = await manager.resolveAgentWorkspace(workId, agent.cwd);
    const worktree = workspace.checkoutRoot !== workspace.prepared.draft.draftRoot;
    return { ...status, selectedAgent: { id: agent.id, workspaceId: agent.workspaceId || null,
      kind: worktree ? "worktree" : "main", label: worktree ? "独立工作树" : "主工作区", previewAllowed: true } };
  });
  app.get("/api/paseo/works/:workId/history", req => workService.legacyChats(z.uuid().parse(req.params.workId)));
  app.get("/api/paseo/works/:workId/history/:chatId", req =>
    workService.legacyHistory(z.uuid().parse(req.params.workId), z.uuid().parse(req.params.chatId)));

  app.post("/api/paseo/works/:workId/messages/freeze", req => workService.freeze(z.uuid().parse(req.params.workId), req.body));
  app.get("/api/paseo/works/:workId/messages/:messageId", async req => {
    const workId = z.uuid().parse(req.params.workId);
    await workService.works.get(workId, { active: true });
    const agentId = z.string().min(1).max(256).parse(req.query.agentId);
    const message = await store.getMessage({ workId, agentId, messageId: z.uuid().parse(req.params.messageId) });
    if (!message) throw problem(404, "Frozen native submission not found");
    return { ...message.envelope, state: "frozen", recovery: "Inspect the native Paseo receipt before retrying this same message ID" };
  });
  for (const operation of ["retry", "apply"]) app.post("/api/paseo/works/:workId/candidates/:candidateId/" + operation, async req => {
    const workId = z.uuid().parse(req.params.workId), candidateId = z.uuid().parse(req.params.candidateId);
    await workService.works.get(workId, { active: true });
    if (!drafts) throw problem(503, "Draft verification is unavailable");
    return drafts[operation](workId, candidateId);
  });

  const internal = async req => {
    const workId = z.uuid().parse(req.params.workId);
    const credential = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    if (!(await manager.authorize(workId, credential))) throw problem(401, "Work-scoped Paseo credential required");
    await workService.works.get(workId, { active: true });
    return workId;
  };
  app.get("/api/paseo/internal/:workId/context", async req => {
    const workId = await internal(req);
    const work = await workService.works.get(workId, { active: true });
    return { version: 1, workId, project: work.project, instructions: creatorPrompt(work.project) };
  });
  app.get("/api/paseo/internal/:workId/messages/:messageId/selection", async req => {
    const workId = await internal(req);
    const agentId = z.string().min(1).max(256).parse(req.query.agentId);
    const message = await store.getMessage({ workId, agentId, messageId: z.uuid().parse(req.params.messageId) });
    if (!message) return { version: 1, frozen: false };
    const selection = z.strictObject({ provider: z.string().min(1), model: z.string().nullable() })
      .parse(message.execution?.nativeSelection);
    return { version: 1, frozen: true, selection };
  });
  app.post("/api/paseo/internal/:workId/session-open", async req => {
    const workId = await internal(req);
    return paseoSessionEnvironment({ workId, request: req.body, manager, workService, connections, db, secrets, data, localMode });
  });
  app.post("/api/paseo/internal/:workId/events", async req => {
    const workId = await internal(req), event = eventSchema.parse(req.body);
    await manager.notify(workId, event);
    return { version: 1, accepted: true };
  });

  const proxy = async (req, reply, workId, relative) => {
    await manager.ensure(workId);
    const binding = await store.getWork(workId), { capability } = await manager.control(workId);
    const endpoint = new URL(relative, binding.endpoint + "/");
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !hopHeaders.has(name.toLowerCase())));
    headers.authorization = "Bearer " + capability;
    headers.host = endpoint.host;
    reply.hijack();
    const client = endpoint.protocol === "https:" ? https : http;
    const upstream = client.request(endpoint, { method: req.method, headers }, response => {
      const responseHeaders = Object.fromEntries(Object.entries(response.headers).filter(([name]) =>
        !hopHeaders.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie" && name.toLowerCase() !== "location"));
      if (response.headers.location) {
        const target = new URL(response.headers.location, endpoint);
        if (target.origin === endpoint.origin) responseHeaders.location = "/paseo/" + workId + target.pathname + target.search + target.hash;
      }
      responseHeaders["cache-control"] = "no-store";
      reply.raw.writeHead(response.statusCode || 502, responseHeaders);
      void pipeline(response, reply.raw).catch(() => {});
    });
    upstream.on("error", () => { if (!reply.raw.headersSent) reply.raw.writeHead(502); reply.raw.end("Paseo connection interrupted"); });
    req.raw.once("aborted", () => upstream.destroy());
    reply.raw.once("close", () => { if (!reply.raw.writableFinished) upstream.destroy(); });
    req.raw.pipe(upstream);
  };
  // Common immutable UI files are served once, shared by all works; no per-work build.
  for (const prefix of ["_expo", "assets"]) app.get("/paseo/" + prefix + "/*", async (req, reply) => {
    const relative = prefix + "/" + req.params["*"];
    const file = await confinedAsync(uiRoot, relative);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) throw problem(404, "Paseo UI resource not found");
    const accepted = (req.headers["accept-encoding"] || "").toLowerCase();
    let selected = file, encoding = null;
    for (const [suffix, name] of [[".br", "br"], [".gz", "gzip"]]) {
      if (!accepted.split(",").some(item => item.trim().split(";")[0] === name && !/;\s*q=0(?:\.0*)?(?:\s*;|$)/.test(item))) continue;
      const compressed = await fsp.stat(file + suffix).catch(error => {
        if (error.code !== "ENOENT") throw error; return null;
      });
      if (compressed?.isFile()) { selected = file + suffix; encoding = name; break; }
    }
    reply.type(mime(file)).header("Cache-Control", prefix === "_expo" ? "private, max-age=31536000, immutable" : "private, max-age=3600")
      .header("Vary", "Accept-Encoding").header("Content-Length", (await fsp.stat(selected)).size);
    if (encoding) reply.header("Content-Encoding", encoding);
    return reply.send(fs.createReadStream(selected));
  });
  app.get("/paseo/:workId", async (req, reply) => reply.redirect("/paseo/" + z.uuid().parse(req.params.workId) + "/"));
  app.all("/paseo/:workId/*", { onRequest: async (req, reply) => {
    const workId = z.uuid().parse(req.params.workId), suffix = req.params["*"];
    if (suffix === "ws" || suffix.startsWith("api/") || suffix.startsWith("mcp/")) {
      const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      await proxy(req, reply, workId, "/" + suffix + query);
    }
  } }, async (req, reply) => {
    if (reply.sent) return;
    const workId = z.uuid().parse(req.params.workId);
    const value = await bootstrap(workId, req.query.frameNonce || randomBytes(24).toString("base64url"));
    const html = await fsp.readFile(path.join(uiRoot, "index.html"), "utf8");
    if (!html.includes("<head>")) throw problem(503, "Paseo WebUI build is invalid");
    const injected = html.replace("<head>", "<head><script>globalThis.__PASEO_FRAME_EMBED__=" + htmlJson(value) + ";</script>");
    return reply.type("text/html").header("Cache-Control", "no-store").send(injected);
  });

  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const upgrade = async (req, socket, head) => {
    let parsed;
    try { parsed = new URL(req.url, "http://frame.invalid"); }
    catch { socket.destroy(); return; }
    if (!parsed.pathname.startsWith("/paseo/")) return;
    const match = /^\/paseo\/([0-9a-f-]{36})\/ws$/.exec(parsed.pathname);
    try {
      if (!match) throw problem(404, "Unknown native socket");
      await authenticate(req);
      const workId = z.uuid().parse(match[1]);
      await manager.ensure(workId);
      const binding = await store.getWork(workId), { capability } = await manager.control(workId);
      wss.handleUpgrade(req, socket, head, local => {
        const remote = new WebSocket(binding.endpoint.replace(/^http/, "ws") + "/ws" + parsed.search, {
          headers: { Authorization: "Bearer " + capability }, perMessageDeflate: false,
        });
        sockets.add(local); sockets.add(remote);
        local.pause();
        const forward = (from, to) => from.on("message", (bytes, binary) => {
          if (to.readyState !== WebSocket.OPEN) return;
          from.pause();
          to.send(bytes, { binary }, error => { if (error) from.close(1011, "Native transport interrupted"); else from.resume(); });
        });
        forward(local, remote); forward(remote, local);
        const close = () => { sockets.delete(local); sockets.delete(remote); local.close(1012, "Native transport reconnecting"); remote.close(); };
        remote.once("open", () => local.resume());
        local.once("close", close); remote.once("close", close);
        local.once("error", close); remote.once("error", close);
      });
    } catch (error) {
      socket.write("HTTP/1.1 " + (error.statusCode || 503) + " Reconnect required\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  };
  app.server.on("upgrade", upgrade);
  let closing;
  const closeTransport = () => closing ||= (async () => {
    app.server.off("upgrade", upgrade);
    for (const socket of sockets) socket.close(1001, "FRAME is restarting");
    const timer = setTimeout(() => {
      for (const socket of sockets) socket.terminate();
      for (const socket of wss.clients) socket.terminate();
    }, 2000);
    timer.unref();
    try { await new Promise(resolve => wss.close(resolve)); }
    finally { clearTimeout(timer); }
  })();
  app.addHook("preClose", async () => {
    manager.beginClose?.();
    await closeTransport();
  });
  app.addHook("onClose", closeTransport);
}
