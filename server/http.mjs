import fs from "node:fs";
import path from "node:path";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { mimeType, problem, sha256 } from "./util.mjs";

/** Minimal router: `/api/works/:id` style patterns, JSON in and out. */
export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler, options = {}) {
    const keys = [];
    const regex = new RegExp(
      "^" +
        pattern.replace(/\/:(\w+)(\*)?/g, (_, key, rest) => {
          keys.push(key);
          return rest ? "/(.+)" : "/([^/]+)";
        }) +
        "/?$",
    );
    this.routes.push({ method, regex, keys, handler, options });
  }
  get = (pattern, handler, options) => this.add("GET", pattern, handler, options);
  post = (pattern, handler, options) => this.add("POST", pattern, handler, options);
  put = (pattern, handler, options) => this.add("PUT", pattern, handler, options);
  patch = (pattern, handler, options) => this.add("PATCH", pattern, handler, options);
  delete = (pattern, handler, options) => this.add("DELETE", pattern, handler, options);
  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method && !(method === "HEAD" && route.method === "GET")) continue;
      const found = route.regex.exec(pathname);
      if (found) return { route, params: Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(found[index + 1])])) };
    }
    return null;
  }
}

export async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw problem(413, "请求内容过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw problem(400, "请求不是有效的 JSON");
  }
}

export function sendJson(res, status, value) {
  const body = JSON.stringify(value ?? null);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

export function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  if (res.headersSent) return res.destroy();
  sendJson(res, status, { error: { code: error.code || "INTERNAL", message: error.message, details: error.details } });
}

/** Stream a file with Range support (media seeking needs it). */
export function sendFile(req, res, file, { cache = "no-cache", type } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw problem(404, "文件不存在", "NOT_FOUND");
  }
  if (!stat.isFile()) throw problem(404, "文件不存在", "NOT_FOUND");
  const headers = {
    "Content-Type": type || mimeType(file),
    "Accept-Ranges": "bytes",
    "Cache-Control": cache,
    "Last-Modified": stat.mtime.toUTCString(),
    ETag: `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`,
  };
  if (req.headers["if-none-match"] === headers.ETag) {
    res.writeHead(304, headers);
    return res.end();
  }
  let start = 0,
    end = stat.size - 1,
    status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && stat.size) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), end);
    } else if (range[2]) start = Math.max(0, stat.size - Number(range[2]));
    if (start > end || start >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers["Content-Length"] = stat.size ? end - start + 1 : 0;
  res.writeHead(status, headers);
  if (req.method === "HEAD" || !stat.size) return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

/**
 * Access control:
 *  - loopback without FRAME_PASSWORD: open to local processes, with CSRF/DNS-rebinding guards.
 *  - FRAME_PASSWORD set: browser sessions use a signed cookie; tools use Bearer tokens.
 */
export class Auth {
  constructor({ config, settings }) {
    this.config = config;
    this.settings = settings;
    this.key = Buffer.from(settings.secret("session-key") || "", "base64");
    if (this.key.length < 32) {
      this.key = randomBytes(32);
      settings.setSecret("session-key", this.key.toString("base64"));
    }
    this.internal = new Map();
    /** Extra bearer formats (OAuth access tokens): token → principal or null. */
    this.verifiers = [];
  }
  get required() {
    return Boolean(this.config.password);
  }
  /** Short-lived tokens handed to spawned agents/renderers; scoped to one work when given. */
  issueInternal(scope = {}) {
    const token = "fi_" + randomBytes(24).toString("base64url");
    this.internal.set(token, { ...scope, issuedAt: Date.now() });
    return token;
  }
  revokeInternal(token) {
    this.internal.delete(token);
  }
  sign(value) {
    return createHmac("sha256", this.key).update(value).digest("base64url");
  }
  sessionCookie() {
    const value = `${Date.now() + 30 * 86400000}.${randomBytes(9).toString("base64url")}`;
    return `frame_session=${value}.${this.sign(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`;
  }
  checkPassword(password) {
    const a = Buffer.from(sha256(String(password || ""))),
      b = Buffer.from(sha256(this.config.password));
    return this.required && timingSafeEqual(a, b);
  }
  /** Returns the principal for a request, or null. */
  identify(req) {
    const header = req.headers.authorization || "";
    // `access_token` (not `token`, which Vite's HMR socket uses) lets clients without headers authenticate.
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : new URL(req.url, "http://x").searchParams.get("access_token");
    if (bearer) {
      const internal = this.internal.get(bearer);
      if (internal) return { kind: "internal", ...internal };
      const hash = sha256(bearer);
      const token = this.settings.get("mcp").tokens.find((item) => item.hash === hash);
      if (token) return { kind: "token", id: token.id, name: token.name, readOnly: Boolean(token.readOnly) };
      for (const verify of this.verifiers) {
        const principal = verify(bearer);
        if (principal) return principal;
      }
      return null;
    }
    if (!this.required) return { kind: "local" };
    const cookie = /(?:^|;\s*)frame_session=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    if (cookie) {
      const parts = cookie.split(".");
      const value = parts.slice(0, 2).join(".");
      const signature = parts[2] || "";
      const expected = this.sign(value);
      if (signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) && Number(parts[0]) > Date.now())
        return { kind: "session" };
    }
    return null;
  }
  /**
   * Reject cross-site requests and DNS-rebinding attempts against the local studio.
   * `crossOrigin` allows other origins for endpoints that never rely on cookies (OAuth client endpoints).
   */
  guard(req, { crossOrigin = false } = {}) {
    if (!this.required && !this.config.publicUrl) {
      const host = (req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      if (!["127.0.0.1", "localhost", "::1"].includes(host) && !host.endsWith(".localhost"))
        throw problem(403, "Studio only accepts loopback host names", "FORBIDDEN");
    }
    const origin = req.headers.origin;
    if (origin && !crossOrigin && req.method !== "GET" && req.method !== "HEAD") {
      const expected = new URL(`http://${req.headers.host}`).host;
      if (new URL(origin).host !== expected) throw problem(403, "Cross-origin request rejected", "FORBIDDEN");
    }
  }
}

export function serveStatic(req, res, root, pathname) {
  const file = path.join(root, path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(root)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  sendFile(req, res, file, { cache: pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
  return true;
}
