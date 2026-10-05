import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appVersion } from "./config.mjs";
import { readBody, sendJson } from "./http.mjs";
import { problem, notFound, sha256 } from "./util.mjs";

/**
 * OAuth 2.1 for external MCP clients, following the MCP authorization spec:
 * protected resource metadata (RFC 9728) → authorization server metadata (RFC 8414)
 * → dynamic client registration (RFC 7591) → authorization code + PKCE (S256)
 * → short-lived signed access tokens and rotating refresh tokens.
 *
 * The studio is its own authorization server. The consent page lets the user grant
 * read-only access and/or bind the client to one work. Clients and grants live in
 * settings.json under `mcp` (refresh tokens only as hashes); revoking a grant
 * invalidates its access tokens at once because every token names its grant.
 */
export const OAUTH_SCOPES = ["frame:read", "frame:write"];
const ACCESS_TTL = 3600;
const CODE_TTL = 10 * 60 * 1000;
const IDLE_LIMIT = 90 * 86400 * 1000;
const MAX_CLIENTS = 200;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Endpoints called by OAuth clients themselves (possibly from a browser on another origin). */
export const isOAuthClientEndpoint = (pathname) =>
  pathname.startsWith("/.well-known/") || ["/oauth/token", "/oauth/register", "/oauth/revoke"].includes(pathname);

/** CORS for the client endpoints; answers preflights. Returns true when the request is done. */
export function oauthCors(req, res, pathname) {
  if (!isOAuthClientEndpoint(pathname)) return false;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method !== "OPTIONS") return false;
  res.writeHead(204);
  res.end();
  return true;
}

/** The URL clients see: FRAME_PUBLIC_URL behind a proxy, else the request's own origin. */
export function publicBase(req, config) {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (req.socket?.encrypted ? "https" : "http");
  return `${proto}://${req.headers.host}`;
}

export const resourceMetadataUrl = (req, config) => `${publicBase(req, config)}/.well-known/oauth-protected-resource/mcp`;

export class OAuth {
  constructor({ settings, auth }) {
    this.settings = settings;
    this.auth = auth;
    this.codes = new Map();
  }

  // ---- storage ----------------------------------------------------------------
  clients() {
    return this.settings.get("mcp").clients;
  }
  grants() {
    return this.settings.get("mcp").grants;
  }
  client(id) {
    return this.clients().find((client) => client.id === id) ?? null;
  }
  updateMcp(change) {
    this.settings.update("mcp", (mcp) => ({ ...mcp, ...change(mcp) }));
  }

  /** Bearer → principal for `fo_` access tokens (null when not ours, expired or revoked). */
  verify(token) {
    if (!token.startsWith("fo_")) return null;
    const [payload, signature = ""] = token.slice(3).split(".");
    const expected = this.auth.sign("oauth." + payload);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const [grantId, expires] = Buffer.from(payload, "base64url").toString("utf8").split("|");
    if (!(Number(expires) > Date.now() / 1000)) return null;
    const grant = this.grants().find((item) => item.id === grantId);
    if (!grant) return null;
    return { kind: "oauth", grant: grant.id, name: grant.clientName, readOnly: grant.readOnly, work: grant.work || undefined, repo: grant.repo || undefined };
  }

  // ---- registration (RFC 7591) ----------------------------------------------------
  register(body) {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 10) throw oauthError(400, "invalid_redirect_uri", "redirect_uris 必须是 1–10 个地址");
    for (const uri of uris) if (!validRedirect(uri)) throw oauthError(400, "invalid_redirect_uri", `不接受的回调地址：${uri}`);
    const method = body.token_endpoint_auth_method || "none";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method))
      throw oauthError(400, "invalid_client_metadata", "不支持的 token_endpoint_auth_method：" + method);
    const secret = method === "none" ? null : "fs_" + randomBytes(32).toString("base64url");
    const client = {
      id: "fc_" + randomBytes(12).toString("base64url"),
      name: String(body.client_name || "未命名应用").slice(0, 80),
      uri: typeof body.client_uri === "string" ? body.client_uri.slice(0, 200) : "",
      redirectUris: uris,
      authMethod: method,
      secretHash: secret ? sha256(secret) : null,
      createdAt: new Date().toISOString(),
    };
    this.updateMcp((mcp) => {
      // Registration is open to anyone who can reach the studio; keep the list bounded
      // by dropping the oldest clients that were never authorized.
      let clients = [...mcp.clients, client];
      const used = new Set(mcp.grants.map((grant) => grant.clientId));
      while (clients.length > MAX_CLIENTS) {
        const index = clients.findIndex((item) => !used.has(item.id));
        if (index < 0) break;
        clients.splice(index, 1);
      }
      return { clients };
    });
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: client.name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
    };
  }

  // ---- authorization ---------------------------------------------------------------
  /** Validate an authorization request. Errors before the redirect URI is trusted are shown, not redirected. */
  checkRequest(query) {
    const client = this.client(query.client_id || "");
    if (!client) throw problem(400, "未知的应用（client_id 无效），请在应用中重新连接。");
    const redirectUri = query.redirect_uri || (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
    if (!client.redirectUris.some((registered) => sameRedirect(registered, redirectUri))) throw problem(400, "回调地址与应用注册的不一致。");
    const fail = (error, description) => ({ redirect: withParams(redirectUri, { error, error_description: description, state: query.state }) });
    if (query.response_type !== "code") return fail("unsupported_response_type", "only code is supported");
    if (!query.code_challenge || query.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with S256 is required");
    const scopes = String(query.scope || "")
      .split(/\s+/)
      .filter(Boolean);
    if (scopes.some((scope) => !OAUTH_SCOPES.includes(scope))) return fail("invalid_scope", "supported scopes: " + OAUTH_SCOPES.join(" "));
    return {
      client,
      request: {
        clientId: client.id,
        redirectUri,
        state: query.state ?? null,
        codeChallenge: query.code_challenge,
        resource: query.resource || null,
        readOnly: scopes.length > 0 && !scopes.includes("frame:write"),
      },
    };
  }
  /** The validated request travels through the consent form signed, so it cannot be altered. */
  seal(request) {
    const payload = Buffer.from(JSON.stringify({ ...request, exp: Date.now() + CODE_TTL })).toString("base64url");
    return payload + "." + this.auth.sign("consent." + payload);
  }
  unseal(value) {
    const [payload, signature = ""] = String(value || "").split(".");
    const expected = this.auth.sign("consent." + payload);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
      throw problem(400, "授权请求无效，请回到应用重新连接。");
    const request = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (request.exp < Date.now()) throw problem(400, "授权请求已过期，请回到应用重新连接。");
    return request;
  }
  /** Approved: issue a one-time code and build the redirect back to the client. */
  approve(request, { readOnly, work, repo, workTitle }, issuer) {
    for (const [code, item] of this.codes) if (item.expires < Date.now()) this.codes.delete(code);
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { ...request, readOnly, work, repo, workTitle, expires: Date.now() + CODE_TTL });
    return withParams(request.redirectUri, { code, state: request.state, iss: issuer });
  }
  deny(request, issuer) {
    return withParams(request.redirectUri, { error: "access_denied", error_description: "the user declined", state: request.state, iss: issuer });
  }

  // ---- token endpoint --------------------------------------------------------------
  token(params, authorization) {
    const client = this.authenticateClient(params, authorization);
    if (params.grant_type === "authorization_code") {
      const pending = this.codes.get(params.code || "");
      this.codes.delete(params.code || "");
      if (!pending || pending.expires < Date.now() || pending.clientId !== client.id) throw oauthError(400, "invalid_grant", "code is invalid or expired");
      if (params.redirect_uri && !sameRedirect(pending.redirectUri, params.redirect_uri)) throw oauthError(400, "invalid_grant", "redirect_uri mismatch");
      const challenge = createHash("sha256")
        .update(String(params.code_verifier || ""))
        .digest("base64url");
      if (challenge !== pending.codeChallenge) throw oauthError(400, "invalid_grant", "PKCE verification failed");
      const grant = {
        id: randomUUID(),
        clientId: client.id,
        clientName: client.name,
        readOnly: pending.readOnly,
        work: pending.work || null,
        repo: pending.repo || null,
        workTitle: pending.workTitle || null,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        refreshHash: null,
      };
      return this.issue(grant, true);
    }
    if (params.grant_type === "refresh_token") {
      const hash = sha256(String(params.refresh_token || ""));
      const grant = this.grants().find((item) => item.refreshHash === hash);
      if (!grant || grant.clientId !== client.id) throw oauthError(400, "invalid_grant", "refresh token is invalid");
      if (Date.now() - Date.parse(grant.lastUsedAt) > IDLE_LIMIT) {
        this.revokeGrant(grant.id);
        throw oauthError(400, "invalid_grant", "authorization expired after 90 days without use");
      }
      return this.issue(grant, false);
    }
    throw oauthError(400, "unsupported_grant_type", "use authorization_code or refresh_token");
  }
  /** New access token plus a rotated refresh token (the old one stops working). */
  issue(grant, created) {
    const refresh = "fr_" + randomBytes(32).toString("base64url");
    const next = { ...grant, refreshHash: sha256(refresh), lastUsedAt: new Date().toISOString() };
    this.updateMcp((mcp) => ({ grants: created ? [...mcp.grants, next] : mcp.grants.map((item) => (item.id === grant.id ? next : item)) }));
    const payload = Buffer.from(`${grant.id}|${Math.floor(Date.now() / 1000) + ACCESS_TTL}`).toString("base64url");
    return {
      access_token: `fo_${payload}.${this.auth.sign("oauth." + payload)}`,
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: refresh,
      scope: grant.readOnly ? "frame:read" : "frame:read frame:write",
    };
  }
  authenticateClient(params, authorization = "") {
    let id = params.client_id,
      secret = params.client_secret;
    if (authorization.startsWith("Basic ")) {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      id = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    }
    const client = this.client(id || "");
    if (!client) throw oauthError(401, "invalid_client", "unknown client");
    if (client.secretHash && sha256(String(secret || "")) !== client.secretHash) throw oauthError(401, "invalid_client", "client authentication failed");
    return client;
  }
  revokeToken(token) {
    const value = String(token || "");
    const byRefresh = this.grants().find((grant) => grant.refreshHash === sha256(value));
    const grant = byRefresh?.id ?? this.verify(value)?.grant;
    if (grant) this.revokeGrant(grant);
  }
  revokeGrant(id) {
    this.updateMcp((mcp) => ({ grants: mcp.grants.filter((grant) => grant.id !== id) }));
  }

  metadata(issuer) {
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: OAUTH_SCOPES,
      authorization_response_iss_parameter_supported: true,
    };
  }
}

/** Routes: discovery, registration, consent page, token, revocation, and management for the studio UI. */
export function oauthPlugin(services) {
  const { router, settings, auth, config, works } = services;
  const oauth = (services.oauth = new OAuth({ settings, auth }));
  auth.verifiers.push((token) => oauth.verify(token));
  const options = { public: true, raw: true };

  const resource = ({ req, res }) => {
    const base = publicBase(req, config);
    sendJson(res, 200, {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "FRAME Studio",
      resource_documentation: `${base}/`,
    });
  };
  router.get("/.well-known/oauth-protected-resource", resource, options);
  router.get("/.well-known/oauth-protected-resource/mcp", resource, options);
  const server = ({ req, res }) => sendJson(res, 200, oauth.metadata(publicBase(req, config)));
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp", "/.well-known/openid-configuration"])
    router.get(path, server, options);

  router.post(
    "/oauth/register",
    async ({ req, res }) => {
      try {
        sendJson(res, 201, oauth.register(await readParams(req)));
      } catch (error) {
        sendOAuthError(res, error);
      }
    },
    options,
  );

  router.post(
    "/oauth/token",
    async ({ req, res }) => {
      try {
        sendJson(res, 200, oauth.token(await readParams(req), req.headers.authorization));
      } catch (error) {
        sendOAuthError(res, error);
      }
    },
    options,
  );

  router.post(
    "/oauth/revoke",
    async ({ req, res }) => {
      oauth.revokeToken((await readParams(req)).token);
      sendJson(res, 200, {});
    },
    options,
  );

  const workChoices = async () => (await works.list()).map(({ id, repo, title }) => ({ value: `${repo}/${id}`, label: `${title || id}（${repo}/${id}）`, title }));
  const signedIn = (principal) => ["local", "session"].includes(principal?.kind);

  router.get(
    "/oauth/authorize",
    async ({ req, res, query, principal }) => {
      let checked;
      try {
        checked = oauth.checkRequest(query);
      } catch (error) {
        return sendPage(res, 400, errorPage(error.message));
      }
      if (checked.redirect) return redirect(res, checked.redirect);
      sendPage(
        res,
        200,
        consentPage({
          client: checked.client,
          request: checked.request,
          sealed: oauth.seal(checked.request),
          needPassword: auth.required && !signedIn(principal),
          works: await workChoices(),
        }),
      );
    },
    options,
  );

  router.post(
    "/oauth/authorize",
    async ({ req, res, principal }) => {
      const form = await readParams(req);
      let request;
      try {
        request = oauth.unseal(form.request);
      } catch (error) {
        return sendPage(res, 400, errorPage(error.message));
      }
      const issuer = publicBase(req, config);
      if (form.decision !== "allow") return redirect(res, oauth.deny(request, issuer));
      const client = oauth.client(request.clientId);
      if (!client) return sendPage(res, 400, errorPage("应用已被移除，请回到应用重新连接。"));
      const choices = await workChoices();
      if (auth.required && !signedIn(principal)) {
        if (!auth.checkPassword(form.password))
          return sendPage(
            res,
            401,
            consentPage({ client, request, sealed: form.request, needPassword: true, works: choices, error: "密码错误", form }),
          );
        res.setHeader("Set-Cookie", auth.sessionCookie());
      }
      const chosen = form.work ? choices.find((item) => item.value === form.work) : null;
      if (form.work && !chosen) return sendPage(res, 400, errorPage("所选作品不存在。"));
      const [repo, work] = chosen ? chosen.value.split("/") : [null, null];
      redirect(res, oauth.approve(request, { readOnly: form.access === "read", work, repo, workTitle: chosen?.title ?? null }, issuer));
    },
    options,
  );

  // Management for the settings page (people signed in to the studio only).
  const owner = (principal) => {
    if (!signedIn(principal)) throw problem(403, "只有登录 Studio 的用户可以管理授权", "FORBIDDEN");
  };
  router.get("/api/mcp/oauth", ({ principal }) => {
    owner(principal);
    return oauth
      .grants()
      .map(({ refreshHash, ...grant }) => grant)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  });
  router.delete("/api/mcp/oauth/:id", ({ params, principal }) => {
    owner(principal);
    if (!oauth.grants().some((grant) => grant.id === params.id)) throw notFound("授权不存在");
    oauth.revokeGrant(params.id);
  });
}

// ---- helpers ------------------------------------------------------------------------

/** Token/registration requests are form-encoded by the spec; some clients send JSON. */
async function readParams(req) {
  const raw = (await readBody(req, 64 * 1024)).toString("utf8");
  if (!raw) return {};
  if (String(req.headers["content-type"] || "").includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      throw oauthError(400, "invalid_request", "body is not valid JSON");
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function oauthError(status, error, description) {
  return Object.assign(new Error(description), { status, oauth: error });
}

function sendOAuthError(res, error) {
  if (!error.oauth) throw error;
  if (error.status === 401) res.setHeader("WWW-Authenticate", 'Basic realm="FRAME Studio"');
  sendJson(res, error.status, { error: error.oauth, error_description: error.message });
}

/** https anywhere, http only on loopback (native apps), or a private-use scheme such as cursor://. */
export function validRedirect(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname) || url.hostname === "::1";
  return !["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ws:", "wss:", "ftp:"].includes(url.protocol);
}

/** Exact match, except that loopback redirects may use any port (RFC 8252 §7.3). */
export function sameRedirect(registered, requested) {
  if (registered === requested) return true;
  try {
    const a = new URL(registered),
      b = new URL(requested);
    return a.protocol === "http:" && b.protocol === "http:" && LOOPBACK.has(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

function withParams(uri, params) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, value);
  return url.toString();
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function sendPage(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
  });
  res.end(html);
}

const escape = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function redirectLabel(uri) {
  try {
    const url = new URL(uri);
    return url.protocol.startsWith("http") ? url.host : url.protocol + "//" + url.host;
  } catch {
    return uri;
  }
}

function page(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { --bg: #f4f5f7; --card: #ffffff; --text: #1c2127; --muted: #5f6b7a; --line: #d9dee5; --accent: #2f6fde; --accent-text: #ffffff; --danger: #c4372f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #15181c; --card: #1e2227; --text: #e6e9ed; --muted: #9aa4b1; --line: #343a42; --accent: #5b8ff0; --accent-text: #0d1117; --danger: #ef6b62; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
  main { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px 24px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 16px; color: var(--muted); }
  strong { color: var(--text); }
  fieldset { border: 0; padding: 0; margin: 0 0 18px; }
  legend { font-weight: 600; margin-bottom: 8px; }
  label.option { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px; cursor: pointer; }
  label.option small { display: block; color: var(--muted); }
  select, input[type=password] { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
  .error { color: var(--danger); margin-bottom: 14px; }
  .actions { display: flex; gap: 10px; margin-top: 8px; }
  button { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--text); font: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
  .meta { font-size: 13px; color: var(--muted); margin-top: 18px; word-break: break-all; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function errorPage(message) {
  return page("无法授权", `<h1>无法授权</h1><p>${escape(message)}</p>`);
}

function consentPage({ client, request, sealed, needPassword, works, error, form = {} }) {
  const access = form.access || (request.readOnly ? "read" : "write");
  const options = works
    .map((item) => `<option value="${escape(item.value)}"${form.work === item.value ? " selected" : ""}>${escape(item.label)}</option>`)
    .join("");
  return page(
    "授权 " + client.name,
    `<h1>授权「${escape(client.name)}」使用 FRAME Studio</h1>
<p>授权后，这个应用可以通过 MCP 调用 FRAME 工具。随时可以在 设置 → MCP 接入 中撤销。</p>
${error ? `<div class="error">${escape(error)}</div>` : ""}
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="request" value="${escape(sealed)}">
  <fieldset>
    <legend>权限</legend>
    <label class="option"><input type="radio" name="access" value="write"${access === "write" ? " checked" : ""}><span>读写<small>查看、修改作品，生成配音，导出视频</small></span></label>
    <label class="option"><input type="radio" name="access" value="read"${access === "read" ? " checked" : ""}><span>只读<small>只能查看作品、截图和分析，不能修改</small></span></label>
  </fieldset>
  <fieldset>
    <legend>可以访问的作品</legend>
    <select name="work"><option value="">全部作品（也可以新建作品）</option>${options}</select>
  </fieldset>
  ${needPassword ? `<fieldset><legend>Studio 密码</legend><input type="password" name="password" autocomplete="current-password" required autofocus></fieldset>` : ""}
  <div class="actions">
    <button type="submit" name="decision" value="deny" formnovalidate>拒绝</button>
    <button type="submit" name="decision" value="allow" class="primary">允许</button>
  </div>
</form>
<div class="meta">授权后返回：${escape(redirectLabel(request.redirectUri))}<br>FRAME Studio ${escape(appVersion)}</div>`,
  );
}
