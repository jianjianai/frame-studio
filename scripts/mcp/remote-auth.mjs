import fs from "node:fs";
import path from "node:path";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { redirectUri } from "./remote-config.mjs";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
const same = (a, b) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export const json = (value, status = 200, headers = {}) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
export class AuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const bad = (code, message, status) => {
  throw new AuthError(code, message, status);
};
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const unique = (params) => {
  for (const key of params.keys())
    if (params.getAll(key).length !== 1)
      bad("invalid_request", "Duplicate parameter: " + key);
  return params;
};

export function validateOAuthClients(config) {
  const clients = new Map();
  for (const client of config.oauth.clients) {
    if (
      !client ||
      !/^[\w.-]{1,128}$/.test(client.client_id || "") ||
      clients.has(client.client_id)
    )
      throw new Error("Unique static OAuth client_id required");
    const checked = RemoteAuth.prototype.clientMetadata.call(
      { config },
      client,
    );
    if (
      checked.token_endpoint_auth_method !== "none" &&
      typeof client.client_secret !== "string"
    )
      throw new Error("Configured confidential client needs a secret");
    if (
      client.client_secret &&
      (typeof client.client_secret !== "string" ||
        client.client_secret.length < 32)
    )
      throw new Error("Client secrets require at least 32 characters");
    clients.set(client.client_id, {
      ...checked,
      client_id: client.client_id,
      secretHash: client.client_secret ? hash(client.client_secret) : undefined,
    });
  }
  return clients;
}

/** Single workspace owner. Stored access/refresh tokens and client secrets are hashes only. */
export class RemoteAuth {
  constructor(config, { now = () => Date.now() } = {}) {
    this.config = config;
    this.now = now;
    this.pending = new Map();
    this.codes = new Map();
    this.failures = [];
    this.staticClients = validateOAuthClients(config);
    this.directory = config.stateDirectory;
    for (const dir of [path.dirname(this.directory), this.directory]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(dir).isSymbolicLink())
        throw new Error("OAuth state directories cannot be links");
    }
    this.lock = path.join(this.directory, "server.lock");
    this.lockId = randomUUID();
    let fd;
    try {
      fd = fs.openSync(this.lock, "wx", 0o600);
    } catch (e) {
      if (e.code === "EEXIST")
        throw new Error(
          "Remote server active or crash lock remains; inspect " + this.lock,
        );
      throw e;
    }
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, token: this.lockId }),
      );
      fs.closeSync(fd);
      fd = undefined;
      this.file = path.join(this.directory, "oauth.json");
      if (
        fs.existsSync(this.file) &&
        (fs.lstatSync(this.file).isSymbolicLink() ||
          fs.statSync(this.file).nlink > 1 ||
          fs.statSync(this.file).size > 8 * 1024 * 1024)
      )
        throw new Error("Invalid OAuth state file");
      this.state = fs.existsSync(this.file)
        ? JSON.parse(fs.readFileSync(this.file, "utf8"))
        : { version: 1, clients: {}, grants: {}, access: {}, refresh: {} };
      if (
        this.state.version !== 1 ||
        ["clients", "grants", "access", "refresh"].some(
          (k) =>
            !this.state[k] ||
            typeof this.state[k] !== "object" ||
            Array.isArray(this.state[k]),
        )
      )
        throw new Error("Invalid OAuth state");
      this.salt = randomBytes(16);
      this.passwordHash = scryptSync(config.oauth.password, this.salt, 32);
      this.prune();
      this.save();
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      this.close();
      throw error;
    }
  }
  close() {
    if (
      fs.existsSync(this.lock) &&
      JSON.parse(fs.readFileSync(this.lock, "utf8")).token === this.lockId
    )
      fs.unlinkSync(this.lock);
  }
  save() {
    const tmp = this.file + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state), {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(tmp, this.file);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
  prune() {
    const now = this.now();
    for (const map of [this.pending, this.codes])
      for (const [key, value] of map) if (value.expires <= now) map.delete(key);
    for (const [key, g] of Object.entries(this.state.grants))
      if (g.expires <= now || g.revoked) delete this.state.grants[key];
    for (const kind of ["access", "refresh"])
      for (const [key, t] of Object.entries(this.state[kind]))
        if (t.expires <= now || !this.state.grants[t.grant])
          delete this.state[kind][key];
    for (const [key, c] of Object.entries(this.state.clients))
      if (
        c.expires <= now &&
        !Object.values(this.state.grants).some((g) => g.clientId === key)
      )
        delete this.state.clients[key];
  }
  clientMetadata(data) {
    const uris = data.redirect_uris;
    if (
      !Array.isArray(uris) ||
      !uris.length ||
      uris.length > 16 ||
      uris.some(
        (uri) =>
          typeof uri !== "string" ||
          !this.config.oauth.redirects.includes(redirectUri(uri)),
      )
    )
      bad(
        "invalid_redirect_uri",
        "Callback is not in FRAME_OAUTH_REDIRECT_URIS",
      );
    const method = data.token_endpoint_auth_method ?? "client_secret_basic";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method))
      bad(
        "invalid_client_metadata",
        "Unsupported client authentication method",
      );
    if (
      data.grant_types &&
      (!Array.isArray(data.grant_types) ||
        data.grant_types.some(
          (x) => !["authorization_code", "refresh_token"].includes(x),
        ))
    )
      bad("invalid_client_metadata", "Unsupported grant type");
    if (
      data.response_types &&
      JSON.stringify(data.response_types) !== '["code"]'
    )
      bad("invalid_client_metadata", "Only code response supported");
    return {
      client_name: String(data.client_name || "External AI client").slice(
        0,
        120,
      ),
      redirect_uris: [...new Set(uris.map(redirectUri))],
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }
  client(id) {
    const client = this.staticClients.get(id) ?? this.state.clients[id];
    if (!client || client.client_id !== id)
      bad("invalid_client", "Unknown client", 401);
    if (
      client.redirect_uris.some(
        (uri) => !this.config.oauth.redirects.includes(uri),
      )
    )
      bad("invalid_client", "Client callbacks are no longer allowed", 401);
    return client;
  }
  scopes(value) {
    const scopes = [
      ...new Set(
        (value || this.config.allowedScopes.join(" "))
          .split(" ")
          .filter(Boolean),
      ),
    ];
    if (
      !scopes.includes("frame:read") ||
      scopes.some((s) => !this.config.allowedScopes.includes(s))
    )
      bad("invalid_scope", "Unsupported scope");
    return scopes;
  }
  verify(header) {
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header || "");
    if (!match) bad("invalid_token", "Bearer authorization required", 401);
    const token = match[1],
      config = this.config;
    if (config.bearerToken && same(token, config.bearerToken))
      return {
        principal: "bearer:" + hash(token),
        scopes: config.bearerScopes,
        token,
      };
    const access = this.state.access[hash(token)],
      grant = access && this.state.grants[access.grant];
    if (
      !config.oauth.enabled ||
      !access ||
      access.expires <= this.now() ||
      !grant ||
      grant.revoked ||
      grant.expires <= this.now() ||
      grant.resource !== config.resource
    )
      bad("invalid_token", "Invalid or expired access token", 401);
    const scopes = grant.scopes.filter((s) => config.allowedScopes.includes(s));
    return {
      principal: "oauth:" + access.grant,
      scopes,
      token,
      expiresAt: Math.floor(access.expires / 1000),
      clientId: grant.clientId,
    };
  }
  active(principal) {
    if (principal.startsWith("bearer:"))
      return (
        !!this.config.bearerToken &&
        principal === "bearer:" + hash(this.config.bearerToken)
      );
    const grant = this.state.grants[principal.slice(6)];
    return (
      !!grant &&
      !grant.revoked &&
      grant.expires > this.now() &&
      grant.resource === this.config.resource
    );
  }
  challenge(error = "invalid_token", scope) {
    const metadata =
      this.config.publicUrl + "/.well-known/oauth-protected-resource/mcp";
    return json({ error }, error === "insufficient_scope" ? 403 : 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${metadata}", error="${error}", scope="${scope || this.config.allowedScopes.join(" ")}"`,
    });
  }
  authenticateClient(params, request) {
    let id = params.get("client_id"),
      secret = params.get("client_secret");
    const authorization = request.headers.get("authorization");
    if (authorization) {
      if (!authorization.startsWith("Basic ") || secret)
        bad("invalid_client", "Invalid client authentication", 401);
      const basic = Buffer.from(authorization.slice(6), "base64").toString(
          "utf8",
        ),
        separator = basic.indexOf(":");
      if (separator < 0)
        bad("invalid_client", "Invalid client authentication", 401);
      let basicId;
      try {
        basicId = decodeURIComponent(
          basic.slice(0, separator).replaceAll("+", " "),
        );
        secret = decodeURIComponent(
          basic.slice(separator + 1).replaceAll("+", " "),
        );
      } catch {
        bad("invalid_client", "Invalid client authentication", 401);
      }
      if (id && id !== basicId)
        bad("invalid_client", "Client identity mismatch", 401);
      id = basicId;
    }
    const client = this.client(id);
    if (client.token_endpoint_auth_method === "none") {
      if (secret || authorization)
        bad("invalid_client", "Public client cannot use a client secret", 401);
    } else if (
      !secret ||
      !same(hash(secret), client.secretHash || "") ||
      (client.token_endpoint_auth_method === "client_secret_basic") !==
        !!authorization
    )
      bad("invalid_client", "Invalid client authentication", 401);
    return client;
  }
  ensureTokenCapacity() {
    if (
      Object.keys(this.state.access).length >= 10000 ||
      Object.keys(this.state.refresh).length >= 10000
    )
      bad(
        "temporarily_unavailable",
        "Token capacity reached; revoke old authorizations or retry after expiry",
        429,
      );
  }
  issue(grantId) {
    const grant = this.state.grants[grantId],
      access = opaque(),
      refresh = opaque();
    this.state.access[hash(access)] = {
      grant: grantId,
      expires: this.now() + this.config.oauth.accessTtl * 1000,
    };
    this.state.refresh[hash(refresh)] = {
      grant: grantId,
      expires: grant.expires,
      used: false,
    };
    this.save();
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: this.config.oauth.accessTtl,
      refresh_token: refresh,
      scope: grant.scopes
        .filter((s) => this.config.allowedScopes.includes(s))
        .join(" "),
    };
  }
  revokeAll() {
    for (const grant of Object.values(this.state.grants)) grant.revoked = true;
    this.prune();
    this.save();
  }
  async handle(request) {
    const url = new URL(request.url),
      route = url.pathname,
      config = this.config;
    if (
      request.method === "GET" &&
      [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ].includes(route)
    )
      return json({
        resource: config.resource,
        resource_name: "FRAME animation workspace",
        authorization_servers: config.oauth.enabled ? [config.publicUrl] : [],
        bearer_methods_supported: ["header"],
        scopes_supported: config.allowedScopes,
      });
    if (!config.oauth.enabled) return null;
    if (
      route === "/.well-known/oauth-authorization-server" &&
      request.method === "GET"
    )
      return json({
        issuer: config.publicUrl,
        authorization_endpoint: config.publicUrl + "/oauth/authorize",
        token_endpoint: config.publicUrl + "/oauth/token",
        registration_endpoint: config.publicUrl + "/oauth/register",
        revocation_endpoint: config.publicUrl + "/oauth/revoke",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "none",
          "client_secret_basic",
          "client_secret_post",
        ],
        scopes_supported: config.allowedScopes,
        authorization_response_iss_parameter_supported: true,
      });
    if (!route.startsWith("/oauth/")) return null;
    this.prune();
    if (route === "/oauth/register" && request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        bad("invalid_request", "JSON body required");
      if (Object.keys(this.state.clients).length >= 256)
        bad(
          "temporarily_unavailable",
          "Client registration capacity reached",
          429,
        );
      const data = await request.json(),
        meta = this.clientMetadata(data),
        id = randomUUID();
      const secret =
        meta.token_endpoint_auth_method === "none" ? undefined : opaque();
      this.state.clients[id] = {
        ...meta,
        client_id: id,
        secretHash: secret ? hash(secret) : undefined,
        expires: this.now() + 90 * 86400000,
      };
      this.save();
      return json(
        {
          ...meta,
          client_id: id,
          client_id_issued_at: Math.floor(this.now() / 1000),
          ...(secret
            ? { client_secret: secret, client_secret_expires_at: 0 }
            : {}),
        },
        201,
      );
    }
    if (route === "/oauth/authorize" && request.method === "GET") {
      const q = unique(url.searchParams),
        client = this.client(q.get("client_id")),
        redirect = q.get("redirect_uri");
      if (!client.redirect_uris.includes(redirect))
        bad("invalid_request", "Callback must match exactly");
      if (
        q.get("response_type") !== "code" ||
        q.get("code_challenge_method") !== "S256" ||
        !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") || "")
      )
        bad("invalid_request", "Authorization code with S256 PKCE required");
      if (q.get("resource") !== config.resource)
        bad("invalid_target", "Resource must match this MCP endpoint");
      if ((q.get("state") || "").length > 2048)
        bad("invalid_request", "State too large");
      if (this.pending.size >= 128)
        bad("temporarily_unavailable", "Too many pending authorizations", 429);
      const id = opaque(),
        csrf = opaque(),
        scopes = this.scopes(q.get("scope"));
      this.pending.set(id, {
        clientId: client.client_id,
        redirect,
        state: q.get("state"),
        challenge: q.get("code_challenge"),
        scopes,
        csrf: hash(csrf),
        expires: this.now() + 600000,
      });
      const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FRAME 授权</title><style>body{font:17px system-ui;max-width:640px;margin:8vh auto;padding:24px;background:#111827;color:#f3f4f6}input,button{font:inherit;padding:12px;margin:12px 0}input{width:90%}small{word-break:break-all}button{cursor:pointer}</style><h1>连接 FRAME 动画工作区</h1><p><strong>${escape(client.client_name)}</strong> 请求${scopes.includes("frame:write") ? "读取、编辑并运行" : "只读访问"}工程。</p><p>工程范围：${escape(config.projects.length ? config.projects.join(", ") : "全部工程")}</p><p>回调地址：<small>${escape(redirect)}</small></p><form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${id}"><label>输入本机配置的授权密码<input type="password" name="password" autocomplete="current-password" required maxlength="256"></label><button name="decision" value="allow">允许连接</button> <button name="decision" value="deny" formnovalidate>拒绝</button></form><p>此密码仅用于此授权页，请勿填入外部 AI 的 token 配置。</p></html>`;
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie": `frame_oauth=${csrf}; HttpOnly; SameSite=Lax; Path=/oauth/authorize; Max-Age=600${config.publicUrl.startsWith("https:") ? "; Secure" : ""}`,
        },
      });
    }
    if (
      request.method !== "POST" ||
      !["/oauth/authorize", "/oauth/token", "/oauth/revoke"].includes(route)
    )
      return json({ error: "not_found" }, 404);
    if (
      !request.headers
        .get("content-type")
        ?.startsWith("application/x-www-form-urlencoded")
    )
      bad("invalid_request", "Form body required");
    const params = unique(new URLSearchParams(await request.text()));
    if (route === "/oauth/authorize") {
      if (request.headers.get("origin") !== config.publicUrl)
        bad("invalid_request", "Authorization origin mismatch", 403);
      const id = params.get("request"),
        pending = this.pending.get(id),
        cookie = /(?:^|;\s*)frame_oauth=([^;]+)/.exec(
          request.headers.get("cookie") || "",
        )?.[1];
      if (
        !pending ||
        pending.expires <= this.now() ||
        !cookie ||
        !same(hash(cookie), pending.csrf)
      )
        bad(
          "invalid_request",
          "Authorization request expired or browser cookie missing",
          403,
        );
      const redirect = new URL(pending.redirect);
      if (pending.state !== null)
        redirect.searchParams.set("state", pending.state);
      redirect.searchParams.set("iss", config.publicUrl);
      if (params.get("decision") === "deny") {
        this.pending.delete(id);
        redirect.searchParams.set("error", "access_denied");
      } else {
        if (params.get("decision") !== "allow")
          bad("invalid_request", "Explicit decision required");
        this.failures = this.failures.filter((t) => t > this.now() - 600000);
        if (this.failures.length >= 10)
          bad(
            "temporarily_unavailable",
            "Too many failed logins; retry after ten minutes",
            429,
          );
        const password = params.get("password") || "";
        if (
          password.length > 256 ||
          !timingSafeEqual(
            scryptSync(password, this.salt, 32),
            this.passwordHash,
          )
        ) {
          this.failures.push(this.now());
          bad("access_denied", "Invalid authorization password", 403);
        }
        if (
          Object.keys(this.state.grants).length >= 2048 ||
          this.codes.size >= 128
        )
          bad("temporarily_unavailable", "Authorization capacity reached", 429);
        this.pending.delete(id);
        const code = opaque();
        this.codes.set(hash(code), { ...pending, expires: this.now() + 60000 });
        redirect.searchParams.set("code", code);
      }
      return new Response(null, {
        status: 303,
        headers: {
          Location: redirect.href,
          "Cache-Control": "no-store",
          "Set-Cookie": `frame_oauth=; HttpOnly; SameSite=Lax; Path=/oauth/authorize; Max-Age=0${config.publicUrl.startsWith("https:") ? "; Secure" : ""}`,
        },
      });
    }
    const client = this.authenticateClient(params, request);
    if (route === "/oauth/revoke") {
      const value = hash(params.get("token") || ""),
        entry = this.state.refresh[value] ?? this.state.access[value],
        grant = entry && this.state.grants[entry.grant];
      if (grant?.clientId === client.client_id) {
        grant.revoked = true;
        this.save();
      }
      return json({});
    }
    if (params.get("resource") !== config.resource)
      bad("invalid_target", "Resource must match this MCP endpoint");
    if (params.get("grant_type") === "authorization_code") {
      const key = hash(params.get("code") || ""),
        code = this.codes.get(key),
        verifier = params.get("code_verifier") || "";
      if (
        !code ||
        code.expires <= this.now() ||
        code.clientId !== client.client_id ||
        code.redirect !== params.get("redirect_uri")
      )
        bad("invalid_grant", "Invalid authorization code");
      this.ensureTokenCapacity();
      this.codes.delete(key);
      if (
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        !same(
          createHash("sha256").update(verifier).digest("base64url"),
          code.challenge,
        )
      )
        bad("invalid_grant", "PKCE verification failed");
      const grantId = randomUUID();
      this.state.grants[grantId] = {
        clientId: client.client_id,
        scopes: code.scopes,
        resource: config.resource,
        expires: this.now() + config.oauth.refreshTtl * 1000,
        revoked: false,
      };
      return json(this.issue(grantId));
    }
    if (params.get("grant_type") === "refresh_token") {
      const entry = this.state.refresh[hash(params.get("refresh_token") || "")],
        grant = entry && this.state.grants[entry.grant];
      if (
        !entry ||
        !grant ||
        grant.clientId !== client.client_id ||
        grant.resource !== config.resource ||
        grant.revoked ||
        entry.expires <= this.now()
      )
        bad("invalid_grant", "Invalid refresh token");
      if (entry.used) {
        grant.revoked = true;
        this.save();
        bad("invalid_grant", "Refresh token reuse revoked this authorization");
      }
      if (
        params.has("scope") &&
        this.scopes(params.get("scope")).some((s) => !grant.scopes.includes(s))
      )
        bad("invalid_scope", "Refresh cannot increase scope");
      // Keep the original grant scope stable; narrower requests require a new authorization.
      if (
        params.has("scope") &&
        this.scopes(params.get("scope")).join(" ") !== grant.scopes.join(" ")
      )
        bad("invalid_scope", "Use a new authorization to change scope");
      this.ensureTokenCapacity();
      entry.used = true;
      return json(this.issue(entry.grant));
    }
    bad("unsupported_grant_type", "Use authorization_code or refresh_token");
  }
}
