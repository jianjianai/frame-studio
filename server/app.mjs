import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { loadConfig, ensureDirs, appRoot, appVersion } from "./config.mjs";
import { Settings } from "./settings.mjs";
import { Events, problem, inside } from "./util.mjs";
import { Router, Auth, sendJson, sendError, sendFile, serveStatic, readJson } from "./http.mjs";
import { isOAuthClientEndpoint, oauthCors, resourceMetadataUrl } from "./oauth.mjs";
import { GitHub } from "./github.mjs";
import { Repos } from "./repos.mjs";
import { Works } from "./works.mjs";
import { createPreview } from "./preview.mjs";
import { WorkWatcher } from "./files.mjs";
import { workRoutes } from "./routes/works.mjs";
import { repoRoutes } from "./routes/repos.mjs";

/**
 * FRAME Studio: one process serving the studio UI, the work preview (Vite),
 * the JSON API + WebSocket events, the MCP endpoint and the AI agents.
 * Optional subsystems register themselves through `plugins`.
 */
export async function createApp({ env = process.env, plugins = [] } = {}) {
  const config = loadConfig(env);
  ensureDirs(config);
  const events = new Events();
  const settings = new Settings(config.home, events);
  const auth = new Auth({ config, settings });
  const github = new GitHub(settings);
  const repos = new Repos({ config, settings, github, events });
  await repos.ensureLocal();
  const works = new Works({ config, settings, repos, events });
  const router = new Router();
  const server = http.createServer();
  const preview = await createPreview({ config, httpServer: server, events });
  const watcher = new WorkWatcher({ events, preview });
  const services = { config, events, settings, auth, github, repos, works, preview, watcher, router, closers: [] };

  /** Open a work for editing and start watching it. Used by every route/tool that touches a work. */
  services.openWork = async (id, repo) => {
    const work = await works.open(id, repo);
    watcher.watch(work);
    return work;
  };

  router.get(
    "/api/state",
    ({ principal }) => ({
      version: appVersion,
      authRequired: auth.required,
      authenticated: Boolean(principal),
      home: principal ? config.home : undefined,
    }),
    { public: true },
  );
  router.post(
    "/api/login",
    async ({ req, res }) => {
      const { password } = await readJson(req);
      if (!auth.checkPassword(password)) throw problem(401, "密码错误", "UNAUTHORIZED");
      res.setHeader("Set-Cookie", auth.sessionCookie());
      return { ok: true };
    },
    { public: true },
  );
  router.post("/api/logout", ({ res }) => {
    res.setHeader("Set-Cookie", "frame_session=; Path=/; Max-Age=0");
    return { ok: true };
  });

  repoRoutes(services);
  workRoutes(services);
  for (const plugin of plugins) await plugin(services);

  // `pnpm build` writes the studio UI to web/dist (entry web/dist/web/index.html); dev mode serves sources.
  const webDist = path.join(appRoot, "web", "dist");
  const builtHtml = path.join(webDist, "web", "index.html");
  const studioHtml = async (url) => (config.dev || !fs.existsSync(builtHtml) ? preview.html(url, "web/index.html") : fs.promises.readFile(builtHtml, "utf8"));

  server.on("request", async (req, res) => {
    const url = new URL(req.url, "http://local");
    const { pathname } = url;
    try {
      if (oauthCors(req, res, pathname)) return;
      auth.guard(req, { crossOrigin: isOAuthClientEndpoint(pathname) });
      const principal = auth.identify(req);
      const routed = pathname.startsWith("/api/") || pathname === "/mcp" || pathname.startsWith("/oauth/") || pathname.startsWith("/.well-known/");
      const matched = routed ? router.match(req.method, pathname) : null;
      if (matched) {
        if (!principal && !matched.route.options.public) {
          // Tells MCP clients where to start OAuth (RFC 9728 / MCP authorization).
          if (pathname === "/mcp") res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl(req, config)}"`);
          throw problem(401, "需要登录", "UNAUTHORIZED");
        }
        if (["internal", "oauth"].includes(principal?.kind) && !matched.route.options.internal && !matched.route.options.public)
          throw problem(403, "This token can only call FRAME tools", "FORBIDDEN");
        if (
          !["GET", "HEAD"].includes(req.method) &&
          !matched.route.options.raw &&
          !String(req.headers["content-type"] || "").includes("application/json") &&
          Number(req.headers["content-length"] || 0) > 0
        )
          throw problem(415, "API 请求需要 application/json");
        const result = await matched.route.handler({ req, res, url, params: matched.params, query: Object.fromEntries(url.searchParams), principal, services });
        if (!res.headersSent && !res.writableEnded) sendJson(res, 200, result === undefined ? { ok: true } : result);
        return;
      }
      if (routed) throw problem(404, "接口不存在", "NOT_FOUND");
      // OAuth access tokens are for MCP only, not for browsing work files or the studio.
      if (principal?.kind === "oauth") throw problem(403, "This token can only call FRAME tools", "FORBIDDEN");
      // Everything below serves the browser: login required when a password is set.
      if (!principal && !pathname.startsWith("/assets/") && pathname !== "/favicon.svg") {
        if (req.method === "GET" && !pathname.includes(".")) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(await studioHtml(req.url));
        }
        throw problem(401, "需要登录", "UNAUTHORIZED");
      }
      if (pathname.startsWith("/files/")) return await serveWorkFile(req, res, pathname);
      if (pathname.startsWith("/films/")) return await serveFilmFallback(req, res, pathname);
      if (pathname === "/preview/stage.html" || pathname === "/preview/render.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(await preview.html(req.url, pathname.slice(1).replace("preview/", "src/preview/")));
      }
      if (!config.dev && fs.existsSync(webDist) && serveStatic(req, res, webDist, pathname)) return;
      if (serveStatic(req, res, path.join(appRoot, "public"), pathname)) return;
      preview.middleware(req, res, async () => {
        try {
          if (req.method !== "GET" || pathname.includes(".")) throw problem(404, "Not found", "NOT_FOUND");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          res.end(await studioHtml(req.url));
        } catch (error) {
          sendError(res, error);
        }
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  /** /files/<repo>/<work>/films/<slug>/x → work public file; other paths → engine public/. */
  async function serveWorkFile(req, res, pathname) {
    const [, , repo, id, ...rest] = pathname.split("/");
    const relative = decodeURIComponent(rest.join("/"));
    if (repo === "snapshot") {
      const base = path.join(config.dirs.tmp, "snapshots", id);
      const match = /^films\/([^/]+)\/(.+)$/.exec(relative);
      const file = match ? path.join(base, "projects", match[1], "public", match[2]) : path.join(appRoot, "public", relative);
      if (!inside(match ? base : path.join(appRoot, "public"), file)) throw problem(400, "Invalid path");
      return sendFile(req, res, file);
    }
    const root = works.root(repo, id);
    const match = /^films\/([^/]+)\/(.+)$/.exec(relative);
    if (match) {
      const base = path.join(root, "projects", match[1], "public");
      const file = path.resolve(base, match[2]);
      if (!inside(base, file)) throw problem(400, "Invalid path");
      return sendFile(req, res, file);
    }
    const base = path.join(appRoot, "public");
    const file = path.resolve(base, relative);
    if (!inside(base, file)) throw problem(400, "Invalid path");
    return sendFile(req, res, file, { cache: "public, max-age=86400" });
  }

  /** Workers cannot see the page's asset base and request /films/<slug>/...; slugs are unique per work. */
  async function serveFilmFallback(req, res, pathname) {
    const [, , slug, ...rest] = pathname.split("/");
    for (const repo of fs.readdirSync(config.dirs.works)) {
      for (const id of fs.readdirSync(path.join(config.dirs.works, repo))) {
        const base = path.join(config.dirs.works, repo, id, "projects", slug, "public");
        if (!fs.existsSync(base)) continue;
        const file = path.resolve(base, decodeURIComponent(rest.join("/")));
        if (!inside(base, file)) throw problem(400, "Invalid path");
        return sendFile(req, res, file);
      }
    }
    throw problem(404, "素材不存在", "NOT_FOUND");
  }

  // Runs before Vite's own upgrade handler, so the HMR socket is protected too.
  server.prependListener("upgrade", (req, socket) => {
    try {
      auth.guard(req);
      const principal = auth.identify(req);
      if (!principal || principal.kind === "oauth") throw new Error("unauthorized");
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://local");
    if (pathname !== "/api/ws" || socket.destroyed) return; // Vite HMR handles its own upgrades.
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req));
  });
  sockets.on("connection", (ws) => {
    const unsubscribe = events.subscribe((event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });
    const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25000);
    ws.on("close", () => {
      unsubscribe();
      clearInterval(ping);
    });
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw);
        if (message.type === "preview-state") events.emit({ ...message, type: "preview-state" });
      } catch {}
    });
  });

  return {
    services,
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, resolve);
      });
      const { port } = server.address();
      config.port = port;
      // Internal callers (headless renderer) use loopback: a wildcard address such as 0.0.0.0
      // is not a secure context in Chromium, which would hide WebCodecs from the render page.
      const host = { "0.0.0.0": "127.0.0.1", "::": "::1", "": "127.0.0.1" }[config.host] ?? config.host;
      services.baseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
      return services.baseUrl;
    },
    async close() {
      for (const close of services.closers.reverse()) await close();
      watcher.close();
      for (const client of sockets.clients) client.terminate();
      await preview.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
