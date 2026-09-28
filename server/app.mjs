import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { database } from "./db.mjs";
import {
  hash,
  token,
  vault,
  passwordMatches,
  confined,
  problem,
} from "./security.mjs";
import { Repositories } from "./repositories.mjs";
import { Assets } from "./assets.mjs";
import { Tasks } from "./tasks.mjs";
import { operations } from "./operations.mjs";
import { agentTools } from "./agent-tools.mjs";
import { browserPreview } from "./browser-preview.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
export async function createApp({
  db,
  data = process.env.FRAME_DATA || "/data",
  masterKey = process.env.FRAME_MASTER_KEY,
  origin = process.env.FRAME_PUBLIC_URL || "http://localhost:3000",
  scheduler = true,
} = {}) {
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(data, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(data, "tools"), { recursive: true });
  db ||= await database(
    process.env.DATABASE_URL,
    process.env.FRAME_ADMIN_PASSWORD,
  );
  const secrets = vault(masterKey),
    repos = new Repositories(db, data, secrets),
    assets = new Assets(db, data, repos),
    tasks = new Tasks(db, data, repos, secrets);
  const actions = operations({ db, data, repos, assets, tasks, secrets });
  if (!(await db.one("SELECT id FROM engines LIMIT 1")))
    await db.pool.query(
      "INSERT INTO engines(id,name,config) VALUES($1,$2,$3)",
      [
        randomUUID(),
        "Kokoro 中文 · 本地 CPU",
        secrets.encrypt({
          url: (process.env.FRAME_SPEECH_URL || "http://speech:8000") + "/v1",
          model: "builtin",
          voice: "zf_xiaobei",
          apiKey: "",
        }),
      ],
    );
  const app = Fastify({
    logger: {
      level: "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
      ],
    },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 1024 * 1024 * 1024, files: 1, fields: 8 },
  });
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((err, req, res) => {
    const status = err.name === "ZodError" ? 400 : err.statusCode || 500;
    res.code(status).send({
      error: status === 500 ? "Operation failed" : err.message,
      details:
        status === 400 && err.name === "ZodError" ? err.issues : undefined,
    });
    if (status === 500)
      req.log.error({ message: err.message }, "Operation failed");
  });
  const cookieOptions = {
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "strict",
    path: "/",
    maxAge: 7 * 86400,
  };
  app.addHook("onRequest", async (req, res) => {
    res
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store");
    if (req.url.startsWith("/preview/")) return;
    res.header("X-Frame-Options", "DENY");
    if (!req.url.startsWith("/api/") && !req.url.startsWith("/mcp")) return;
    if (req.url === "/api/login") return;
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null;
    let authenticated = false;
    if (req.url === "/api/agent/action") {
      if (bearer)
        req.agentTask = await db.one(
          "SELECT t.* FROM agent_tokens a JOIN tasks t ON t.id=a.task WHERE a.hash=$1 AND t.kind='agent' AND t.state='running'",
          [hash(bearer)],
        );
      if (!req.agentTask) throw problem(401, "Active task credential required");
      return;
    }
    if (bearer)
      authenticated = !!(await db.one("SELECT id FROM tokens WHERE hash=$1", [
        hash(bearer),
      ]));
    else if (req.cookies.frame_session)
      authenticated = !!(await db.one(
        "SELECT hash FROM sessions WHERE hash=$1 AND expires>now()",
        [hash(req.cookies.frame_session)],
      ));
    if (!authenticated) throw problem(401, "Please sign in");
    if (
      !bearer &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== origin
    )
      throw problem(403, "Invalid request origin");
  });
  app.get("/healthz", async () => {
    await db.one("SELECT 1");
    return {
      status: "ok",
      version: "3.0.0",
      revision: process.env.FRAME_REVISION || "development",
    };
  });
  agentTools({ app, db, data, assets, actions });
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (req, res) => {
      if (req.headers.origin !== origin)
        throw problem(403, "Invalid request origin");
      const admin = await db.setting("admin");
      if (!passwordMatches(req.body?.password, admin.password))
        throw problem(401, "Incorrect password");
      const value = token();
      await db.pool.query(
        "INSERT INTO sessions VALUES($1,now()+interval '7 days')",
        [hash(value)],
      );
      res.setCookie("frame_session", value, cookieOptions);
      return { ok: true };
    },
  );
  app.get("/api/me", async () => ({ user: "admin", origin }));
  app.post("/api/logout", async (req, res) => {
    if (req.cookies.frame_session)
      await db.pool.query("DELETE FROM sessions WHERE hash=$1", [
        hash(req.cookies.frame_session),
      ]);
    res.clearCookie("frame_session", { path: "/" });
    return { ok: true };
  });
  app.post("/api/action", async (req) =>
    actions.call(req.body?.name, req.body?.args),
  );
  app.get("/api/works/:id/cover", async (req, res) => {
    const w = await actions.works.get(req.params.id);
    const { dir } = await repos.project(w.repo, w.project);
    const file = actions.works.coverPath(dir);
    if (!file) throw problem(404, "Cover unavailable");
    res.type(
      path.extname(file) === ".svg"
        ? "image/svg+xml"
        : path.extname(file) === ".png"
          ? "image/png"
          : path.extname(file) === ".jpg"
            ? "image/jpeg"
            : "image/webp",
    );
    return fs.createReadStream(file);
  });
  app.get("/api/actions", async () =>
    Object.fromEntries(
      Object.entries(actions.registry).map(([name, op]) => [
        name,
        { description: op.description },
      ]),
    ),
  );
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
      return await assets.register(file, {
        ...metadata,
        license: String(fields.license || ""),
        tags: String(fields.tags || ""),
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
    return fs.createReadStream(path.join(data, "blobs", a.sha));
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
    return fs.createReadStream(file);
  });
  app.post("/api/tasks/:id/preview", async (req) => {
    const t = await tasks.get(req.params.id);
    return browserPreview(db, t);
  });
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
      `sandbox allow-scripts${p.ai ? " allow-downloads" : ""}; default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self'`,
    );
    res.header("Access-Control-Allow-Origin", "*");
    res.type(types[path.extname(file)] || "application/octet-stream");
    return fs.createReadStream(file);
  });
  const mcp = createMcpHandler(
    () => {
      const server = new McpServer({ name: "frame-studio", version: "3.0.0" });
      for (const [name, op] of Object.entries(actions.registry)) {
        if (
          !/^(works_|upload_|assets_(list|update|trash|purge)$|task_(get|cancel)$|artifact_read$|engines_list$)/.test(
            name,
          )
        )
          continue;
        server.registerTool(
          "frame_" + name,
          { description: op.description, inputSchema: op.schema },
          async (args) => {
            try {
              const value = await op.fn(args);
              if (name === "artifact_read" && value.dataBase64)
                return {
                  content: [
                    {
                      type: "image",
                      mimeType: value.mimeType,
                      data: value.dataBase64,
                    },
                  ],
                };
              return {
                content: [{ type: "text", text: JSON.stringify(value) }],
              };
            } catch (e) {
              return {
                isError: true,
                content: [{ type: "text", text: e.message }],
              };
            }
          },
        );
      }
      return server;
    },
    { maxRequestBodySize: 2 * 1024 * 1024 },
  );
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (req, res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
      const request = new Request(origin + "/mcp", {
        method: req.method,
        headers,
        ...(req.method === "POST" ? { body: JSON.stringify(req.body) } : {}),
      });
      const response = await mcp.fetch(request);
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
    });
    app.setNotFoundHandler((req, res) => res.sendFile("index.html"));
  }
  if (scheduler) tasks.startLoop();
  app.addHook("onClose", async () => {
    tasks.close();
    await mcp.close();
    await db.pool.end();
  });
  return { app, db, repos, assets, tasks, actions };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { app } = await createApp();
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT || 3000) });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => app.close().then(() => process.exit(0)));
}
