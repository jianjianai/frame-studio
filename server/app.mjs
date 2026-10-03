import { operationDescription } from "./tool-catalog.mjs";
import {
  describeTool,
  isMcpOperation,
  textToolResult,
  structuredValue,
} from "./platform-toolkit.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import { publicStaticHeaders } from "./static-cache.mjs";
import { createPreparedMcpHandler } from "./mcp-catalog.mjs";
import { withTaskStatusSignal } from "./task-status-wait.mjs";
import { requestAbortSignal } from "./request-abort.mjs";
import {
  hash,
  token,
  passwordMatches,
  confined,
  problem,
} from "./security.mjs";
import { workTools } from "./work-tools.mjs";
import { browserPreview } from "./browser-preview.mjs";
import { installLivePreview } from "./live-preview-routes.mjs";
import { sendMedia } from "./media.mjs";
import { createServices } from "./services.mjs";
import { rasterCover } from "./covers.mjs";
import { installRealtime } from "./realtime.mjs";
import { installOAuth } from "./oauth.mjs";
import { installPaseoGateway } from "./paseo-gateway.mjs";
import { operationError } from "../src/contracts/errors.mjs";
import { PLATFORM_VERSION } from "../src/contracts/version.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
export async function createApp({
  db,
  data = process.env.FRAME_DATA || "/data",
  masterKey = process.env.FRAME_MASTER_KEY,
  origin = process.env.FRAME_PUBLIC_URL || "http://localhost:3000",
  scheduler = process.env.FRAME_ROLE !== "api",
  localMode = process.env.FRAME_LOCAL_MODE === "1",
} = {}) {
  if (process.env.FRAME_ROLE === "controller")
    throw new Error("The controller role must not expose the HTTP application");
  if (process.env.FRAME_ROLE === "api" && scheduler)
    throw new Error("The public API role cannot start a controller");
  const services = await createServices({ db, data, masterKey });
  ({ db } = services);
  const { repos, assets, tasks, retention, actions, livePreview } = services;
  const app = Fastify({
    logger: {
      level: "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "req.url",
      ],
    },
    bodyLimit: 2 * 1024 * 1024,
    // The reverse proxy owns ingress policy and reports the client protocol.
    trustProxy: true,
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 1024 * 1024 * 1024, files: 1, fields: 8 },
  });
  await installRealtime(app, db, actions, { localMode });
  const oauth = localMode ? { verify: async () => false, challenge: "" }
    : await installOAuth(app, db, actions, origin);
  app.setErrorHandler((err, req, res) => {
    const failure = operationError(err, req.id),
      status = failure.status;
    res.code(status).send({
      ...failure,
      details:
        status === 400 && err.name === "ZodError" ? err.issues : undefined,
    });
    if (status === 500)
      req.log.error({ message: err.message }, "Operation failed");
  });
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 86400,
  };
  const requirePlatformSession = async req => {
    if (localMode) return;
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    const cookies = req.cookies || app.parseCookie(req.headers.cookie || "");
    const authenticated = bearer
      ? !!(await db.one("SELECT id FROM tokens WHERE hash=$1", [hash(bearer)]))
      : !!cookies.frame_session && !!(await db.one("SELECT hash FROM sessions WHERE hash=$1 AND expires>now()", [hash(cookies.frame_session)]));
    if (!authenticated) throw problem(401, "Please sign in");
  };
  app.addHook("onRequest", async (req, res) => {
    // Host, Origin, TLS, rate limiting and browser access policy belong to the proxy.
    res.header("Cache-Control", "no-store");
    if (req.url.startsWith("/preview/") || req.url.startsWith("/preview-live/")) return;
    if (req.url.startsWith("/api/paseo/internal/")) return; // The gateway verifies the work-scoped daemon capability.
    if (req.url.startsWith("/paseo/")) { await requirePlatformSession(req); return; }
    if (!req.url.startsWith("/api/") && !req.url.startsWith("/mcp")) return;
    if (req.url === "/api/login") return;
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null;
    let authenticated = false;
    if (req.url === "/api/agent/action") {
      if (bearer) req.agentTask = await services.paseoManager.agentContext(bearer);
      if (!req.agentTask) throw problem(401, "Work-scoped Paseo credential required");
      return;
    }
    if (localMode) return;
    if (bearer)
      authenticated = !!(await db.one("SELECT id FROM tokens WHERE hash=$1", [
        hash(bearer),
      ]));
    else if (req.cookies.frame_session)
      authenticated = !!(await db.one(
        "SELECT hash FROM sessions WHERE hash=$1 AND expires>now()",
        [hash(req.cookies.frame_session)],
      ));
    if (!authenticated && bearer && req.url.split("?")[0] === "/mcp")
      authenticated = await oauth.verify(bearer);
    if (!authenticated) {
      if (req.url.startsWith("/mcp"))
        res.header("WWW-Authenticate", oauth.challenge);
      throw problem(401, "Please sign in");
    }
  });
  app.get("/healthz", async () => {
    await db.one("SELECT 1");
    return {
      status: "ok",
      version: PLATFORM_VERSION,
      revision: process.env.FRAME_REVISION || "development",
    };
  });
  app.get("/readyz", async (_req, res) => {
    const state = await actions.call("system_status", {});
    return res
      .code(state.ready ? 200 : 503)
      .send({ status: state.ready ? "ready" : "degraded" });
  });
  await installPaseoGateway({ app, manager: services.paseoManager, workService: services.paseoWork,
    store: services.paseoStore, workspace: services.paseoWorkspace, authenticate: requirePlatformSession,
    connections: services.connections, db, data, secrets: services.secrets, localMode });
  workTools({ app, db, data, assets, actions, localMode });
  app.post(
    "/api/login",
    async (req, res) => {
      if (localMode) throw problem(404, "Password login is unavailable in local mode");
      const admin = await db.setting("admin");
      if (!passwordMatches(req.body?.password, admin.password))
        throw problem(401, "Incorrect password");
      const value = token();
      await db.pool.query(
        "INSERT INTO sessions VALUES($1,now()+interval '7 days')",
        [hash(value)],
      );
      res.setCookie("frame_session", value, { ...cookieOptions, secure: req.protocol === "https" });
      return { ok: true };
    },
  );
  app.get("/api/me", async () => ({ user: "admin", origin, localMode }));
  app.post("/api/logout", async (req, res) => {
    if (localMode) return { ok: true };
    if (req.cookies.frame_session)
      await db.pool.query("DELETE FROM sessions WHERE hash=$1", [
        hash(req.cookies.frame_session),
      ]);
    res.clearCookie("frame_session", { path: "/" });
    return { ok: true };
  });
  app.post("/api/action", async (req, res) =>
    withTaskStatusSignal(requestAbortSignal(req, res), () =>
      actions.call(req.body?.name, req.body?.args),
    ),
  );
  app.get("/api/works/:id/cover", async (req, res) => {
    const w = await actions.works.get(req.params.id);
    const { dir } = await repos.project(w.repo, w.project);
    const file = actions.works.coverPath(dir);
    if (!file) throw problem(404, "Cover unavailable");
    const cover = await rasterCover(file);
    res
      .type("image/webp")
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .header("Cache-Control", "private, max-age=300, must-revalidate")
      .header("ETag", cover.etag);
    if (req.headers["if-none-match"] === cover.etag)
      return res.code(304).send();
    return res.send(cover.buffer);
  });
  app.get("/api/actions", async (req) => {
    const search =
      typeof req.query.search === "string"
        ? req.query.search.toLowerCase()
        : "";
    const exact =
      typeof req.query.name === "string"
        ? req.query.name.replace(/^frame_/, "")
        : null;
    return Object.fromEntries(
      Object.entries(actions.registry)
        .filter(
          ([name, op]) =>
            (!exact || name === exact) &&
            (!search ||
              (name + " " + op.description).toLowerCase().includes(search)),
        )
        .map(([name, op]) => [
          name,
          operationDescription(name, op, {
            schema: req.query.schema === "1" || Boolean(exact),
          }),
        ]),
    );
  });
  app.get("/api/actions/:name", async (req) => {
    const name = req.params.name.replace(/^frame_/, "");
    if (!Object.hasOwn(actions.registry, name))
      throw problem(404, "Unknown operation; list /api/actions first.");
    return describeTool(name, actions.registry[name]);
  });
  app.post("/api/upload", async (req) => {
    const file = path.join(data, "uploads", randomUUID());
    let metadata = {},
      fields = {};
    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          await pipeline(
            part.file,
            fs.createWriteStream(file, { flags: "wx" }),
          );
          if (part.file.truncated) throw problem(413, "File too large");
          metadata = { name: part.filename, mime: part.mimetype };
        } else fields[part.fieldname] = part.value;
      }
      if (!metadata.name) throw problem(400, "File required");
      if (!fields.repo || !/^[0-9a-f-]{36}$/.test(String(fields.repo)))
        throw problem(400, "请选择素材所属仓库");
      return await assets.register(file, {
        ...metadata,
        license: String(fields.license || ""),
        tags: String(fields.tags || ""),
        repo: fields.repo ? String(fields.repo) : null,
      });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
  app.get("/api/assets/:id/file", async (req, res) => {
    const a = await assets.get(req.params.id);
    if (a.deleted) throw problem(404, "Asset is in recycle bin");
    res
      .type(a.mime)
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      );
    return sendMedia(req, res, path.join(data, "blobs", a.sha));
  });
  app.post("/api/models/:id/upload", async (req) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(req.params.id))
      throw problem(400, "Invalid model");
    const part = await req.file();
    if (!part) throw problem(400, "File required");
    const target = String(part.fields.path?.value || part.filename);
    const temporary = path.join(data, "uploads", randomUUID());
    try {
      await pipeline(
        part.file,
        fs.createWriteStream(temporary, { flags: "wx" }),
      );
      if (part.file.truncated) throw problem(413, "Model file too large");
      const response = await fetch(
        (process.env.FRAME_SPEECH_URL || "http://speech:8000") +
          "/models/" +
          req.params.id +
          "/file?path=" +
          encodeURIComponent(target),
        {
          method: "PUT",
          body: fs.createReadStream(temporary),
          duplex: "half",
          headers: { "Content-Type": "application/octet-stream" },
          signal: AbortSignal.timeout(180000),
        },
      );
      if (!response.ok) throw problem(502, await response.text());
      return response.json();
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  });
  const types = {
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".wav": "audio/wav",
    ".json": "application/json",
    ".srt": "text/plain",
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".woff2": "font/woff2",
    ".bin": "application/octet-stream",
    ".glb": "model/gltf-binary",
  };
  app.get("/api/tasks/:id/file/*", async (req, res) => {
    const task = await tasks.get(req.params.id);
    if (task.state !== "succeeded") throw problem(409, "Task not complete");
    const rel = req.params["*"];
    if (!rel.startsWith("projects/" + task.project + "/exports/"))
      throw problem(403, "Not an artifact");
    const file = confined(path.join(data, "runs", task.id), rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      throw problem(404, "Artifact not found");
    res
      .type(types[path.extname(file)] || "application/octet-stream")
      .header("Content-Disposition", "attachment");
    const release = await retention.lease(task.id, {
      onLost: (error) => res.raw.destroy(error),
    });
    const done = () =>
      void release().catch((error) =>
        req.log.error(
          { message: error.message },
          "Artifact lease release failed",
        ),
      );
    res.raw.once("close", done);
    res.raw.once("finish", done);
    if (res.raw.destroyed) {
      done();
      return res;
    }
    try {
      return sendMedia(req, res, file, { cache: 0 });
    } catch (error) {
      done();
      throw error;
    }
  });
  app.post("/api/tasks/:id/preview", async (req) => {
    const t = await tasks.get(req.params.id);
    return browserPreview(db, t);
  });
  installLivePreview(app, livePreview);
  app.get("/preview/:token/*", async (req, res) => {
    const p = await db.setting("preview:" + hash(req.params.token));
    if (!p || p.expires < Date.now()) throw problem(401, "Preview expired");
    const file = confined(
      path.join(data, "runs", p.task),
      p.base + "/" + (req.params["*"] || "index.html"),
    );
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      throw problem(404, "Not found");
    res.header(
      "Content-Security-Policy",
      `sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self'`,
    );
    res.header("Access-Control-Allow-Origin", "*");
    res.type(types[path.extname(file)] || "application/octet-stream");
    return sendMedia(req, res, file, {
      cache: Math.max(
        0,
        Math.min(3600, Math.floor((p.expires - Date.now()) / 1000)),
      ),
      compress: /\.(js|css|json|svg|sf2)$/.test(file),
    });
  });
  const mcp = createPreparedMcpHandler({
    serverInfo: { name: "frame-studio", version: PLATFORM_VERSION },
    registry: actions.registry,
    options: { maxRequestBodySize: 2 * 1024 * 1024 },
    execute: (name, args, ctx) =>
      withTaskStatusSignal(ctx.mcpReq.signal, async () => {
        try {
          const value = await actions.call(name, args);
          if (name === "speech_test" && value.bytes <= 8 * 1024 * 1024) {
            const audio = confined(
              path.join(data, "runs", value.task),
              value.path,
            );
            return {
              structuredContent: structuredValue(value),
              content: [
                { type: "text", text: JSON.stringify(value) },
                {
                  type: "audio",
                  mimeType: value.mime,
                  data: fs.readFileSync(audio).toString("base64"),
                },
              ],
            };
          }
          if (name === "artifact_read" && value.dataBase64)
            return {
              structuredContent: {
                id: args.id,
                path: args.path,
                mimeType: value.mimeType,
                bytes: value.bytes,
                downloadPath: value.downloadPath,
              },
              content: [
                {
                  type: "image",
                  mimeType: value.mimeType,
                  data: value.dataBase64,
                },
              ],
            };
          return textToolResult(value);
        } catch (e) {
          return {
            isError: true,
            ...textToolResult(operationError(e)),
          };
        }
      }),
  });
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (req, res) => {
      const signal = requestAbortSignal(req, res);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
      const request = new Request(origin + "/mcp", {
        method: req.method,
        headers,
        signal,
        ...(req.method === "POST" ? { body: JSON.stringify(req.body) } : {}),
      });
      const response = await mcp.fetch(request, { parsedBody: req.body });
      res.code(response.status);
      for (const [k, v] of response.headers) res.header(k, v);
      return response.body
        ? res.send(Readable.fromWeb(response.body))
        : res.send();
    },
  });
  const web = path.resolve(here, "../studio-dist");
  if (fs.existsSync(web)) {
    await app.register(staticPlugin, {
      root: web,
      prefix: "/",
      index: "index.html",
      setHeaders: (response, file) => publicStaticHeaders(response, file, web),
    });
    app.setNotFoundHandler((req, res) => res.sendFile("index.html"));
  }
  if (scheduler) {
    services.startPaseoLoop();
    tasks.startLoop({
      onLeadership: (leader) => (leader ? retention.start() : retention.stop()),
    });
  }
  app.addHook("onClose", async () => {
    await mcp.close();
    await services.close();
  });
  return { app, db, repos, assets, tasks, actions, paseo: { manager: services.paseoManager, work: services.paseoWork, store: services.paseoStore, workspace: services.paseoWorkspace } };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { app } = await createApp();
  await app.listen({ host: process.env.FRAME_LOCAL_MODE === "1" ? "127.0.0.1" : "0.0.0.0", port: Number(process.env.PORT || 3000) });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => app.close().then(() => process.exit(0)));
}
