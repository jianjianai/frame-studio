import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { hash, token, passwordMatches } from "./security.mjs";

const scope = "frame:workbench";
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function validOAuthRedirect(value) {
  try {
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.hash &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
const challenge = (verifier) =>
  createHash("sha256").update(verifier).digest("base64url");

export async function installOAuth(app, db, actions, origin) {
  const resource = origin + "/mcp";
  // Database schema is installed transactionally before HTTP routes start.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 16384 },
    (req, body, done) => {
      const params = new URLSearchParams(body);
      if ([...params.keys()].length !== new Set(params.keys()).size)
        return done(
          Object.assign(Error("Duplicate OAuth parameter"), {
            statusCode: 400,
          }),
        );
      done(null, Object.fromEntries(params));
    },
  );
  const failure = (res, error, description, status = 400) =>
    res.code(status).send({ error, error_description: description });
  const metadata = {
    resource,
    authorization_servers: [origin],
    scopes_supported: [scope],
    bearer_methods_supported: ["header"],
    resource_name: "FRAME 创作工作台",
  };
  app.get("/.well-known/oauth-protected-resource", async () => metadata);
  app.get("/.well-known/oauth-protected-resource/mcp", async () => metadata);
  const issuer = {
    issuer: origin,
    authorization_endpoint: origin + "/oauth/authorize",
    token_endpoint: origin + "/oauth/token",
    registration_endpoint: origin + "/oauth/register",
    revocation_endpoint: origin + "/oauth/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [scope],
    authorization_response_iss_parameter_supported: true,
  };
  app.get("/.well-known/oauth-authorization-server", async () => issuer);
  app.post("/oauth/register", async (req, res) => {
    const a = req.body || {};
    if (
      !Array.isArray(a.redirect_uris) ||
      !a.redirect_uris.length ||
      a.redirect_uris.length > 5 ||
      !a.redirect_uris.every(validOAuthRedirect) ||
      (a.token_endpoint_auth_method && a.token_endpoint_auth_method !== "none")
    )
      return failure(
        res,
        "invalid_client_metadata",
        "Use absolute HTTP(S) OAuth callbacks and public-client PKCE authentication",
      );
    const id = token(),
      name = String(a.client_name || "ChatGPT").slice(0, 100);
    await db.pool.query(
      "INSERT INTO oauth_clients(id,name,redirects) VALUES($1,$2,$3)",
      [id, name, JSON.stringify(a.redirect_uris)],
    );
    return res.code(201).send({
      client_id: id,
      client_name: name,
      redirect_uris: a.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: issuer.grant_types_supported,
      response_types: ["code"],
      scope,
    });
  });
  app.get("/oauth/authorize", async (req, res) => {
    const a = req.query || {};
    const client =
      typeof a.client_id === "string"
        ? await db.one("SELECT * FROM oauth_clients WHERE id=$1", [a.client_id])
        : null;
    if (!client || !client.redirects.includes(a.redirect_uri))
      return failure(res, "invalid_request", "Unknown client or redirect URI");
    if (
      a.response_type !== "code" ||
      a.code_challenge_method !== "S256" ||
      !/^[a-zA-Z0-9_-]{43}$/.test(a.code_challenge || "") ||
      a.resource !== resource ||
      (a.scope && a.scope !== scope) ||
      typeof a.state !== "string" ||
      a.state.length > 2048
    )
      return failure(
        res,
        "invalid_request",
        "Authorization code, S256 PKCE, state and the FRAME MCP resource are required",
      );
    const id = token(),
      csrf = req.cookies.frame_oauth_csrf || token();
    await db.pool.query(
      "INSERT INTO oauth_requests VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')",
      [id, client.id, a.redirect_uri, a.code_challenge, a.state, hash(csrf)],
    );
    res.setCookie("frame_oauth_csrf", csrf, {
      path: "/oauth",
      httpOnly: true,
      secure: req.protocol === "https",
      sameSite: "lax",
      maxAge: 600,
    });
    const signedIn =
      req.cookies.frame_session &&
      (await db.one(
        "SELECT hash FROM sessions WHERE hash=$1 AND expires>now()",
        [hash(req.cookies.frame_session)],
      ));
    return res
      .type("text/html; charset=utf-8")
      .send(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权 ChatGPT · FRAME</title><style>body{margin:0;background:#171b19;color:#e5e7e3;font:16px/1.7 system-ui}main{max-width:500px;margin:12vh auto;padding:32px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:10px 0;border-radius:8px;font:inherit}button{cursor:pointer;background:#d3e5ba;color:#171b19}small{opacity:.75}</style><main><h1>连接 FRAME 与 ChatGPT</h1><p>客户端：${escape(client.name)}</p><p>授权后，ChatGPT 可以读取和修改作品、管理素材、启动创作、预览和导出，也可以删除作品。授权范围是当前单用户工作台。</p><small>授权结果返回已登记的回调地址。可随时在 FRAME「设置 → 访问设置」撤销连接。</small><form action="/oauth/authorize" method="post"><input type="hidden" name="request" value="${id}"><input type="hidden" name="csrf" value="${escape(csrf)}">${signedIn ? "<p>已登录管理员账号</p>" : '<label>FRAME 登录密码<input type="password" name="password" required autocomplete="current-password"></label>'}<button name="decision" value="allow">登录并授权</button><button name="decision" value="deny" formnovalidate>取消</button></form></main></html>`,
      );
  });
  app.post("/oauth/authorize", async (req, res) => {
    const a = req.body || {};
    if (typeof a.csrf !== "string" || a.csrf !== req.cookies.frame_oauth_csrf)
      return failure(res, "invalid_request", "Invalid authorization form", 403);
    const row =
      typeof a.request === "string"
        ? await db.one(
            "SELECT * FROM oauth_requests WHERE id=$1 AND csrf=$2 AND expires>now()",
            [a.request, hash(a.csrf)],
          )
        : null;
    if (!row)
      return failure(
        res,
        "invalid_request",
        "Authorization expired; reconnect from ChatGPT",
      );
    const redirect = new URL(row.redirect);
    redirect.searchParams.set("state", row.state);
    redirect.searchParams.set("iss", origin);
    if (a.decision !== "deny") {
      const signedIn =
        req.cookies.frame_session &&
        (await db.one(
          "SELECT hash FROM sessions WHERE hash=$1 AND expires>now()",
          [hash(req.cookies.frame_session)],
        ));
      if (
        !signedIn &&
        !passwordMatches(a.password, (await db.setting("admin")).password)
      )
        return failure(res, "access_denied", "密码错误，请返回重试", 401);
      const code = token();
      // Consuming the form and issuing a code are a single atomic operation.
      const issued = await db.pool.query(
        "WITH request AS (DELETE FROM oauth_requests WHERE id=$1 RETURNING *) INSERT INTO oauth_codes SELECT $2,client,redirect,challenge,now()+interval '2 minutes' FROM request RETURNING hash",
        [row.id, hash(code)],
      );
      if (!issued.rowCount)
        return failure(res, "invalid_request", "Authorization already used");
      redirect.searchParams.set("code", code);
    } else {
      await db.pool.query("DELETE FROM oauth_requests WHERE id=$1", [row.id]);
      redirect.searchParams.set("error", "access_denied");
    }
    return res.redirect(redirect.href);
  });
  app.post("/oauth/token", async (req, res) => {
    const a = req.body || {};
    if (a.resource !== resource)
      return failure(res, "invalid_target", "Incorrect MCP resource");
    if (typeof a.client_id !== "string")
      return failure(res, "invalid_client", "Client ID required");
    const access = token(),
      refresh = token();
    if (a.grant_type === "authorization_code") {
      if (
        typeof a.code !== "string" ||
        typeof a.code_verifier !== "string" ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(a.code_verifier)
      )
        return failure(res, "invalid_grant", "Invalid PKCE verifier");
      const result = await db.pool.query(
        `WITH code AS (DELETE FROM oauth_codes WHERE hash=$1 AND client=$2 AND redirect=$3 AND challenge=$4 AND expires>now() RETURNING client)
        INSERT INTO oauth_grants(id,client,access,refresh,resource,scope,access_expires,refresh_expires) SELECT $5,client,$6,$7,$8,$9,now()+interval '1 hour',now()+interval '30 days' FROM code RETURNING id`,
        [
          hash(a.code),
          a.client_id,
          a.redirect_uri,
          challenge(a.code_verifier),
          randomUUID(),
          hash(access),
          hash(refresh),
          resource,
          scope,
        ],
      );
      if (!result.rowCount)
        return failure(
          res,
          "invalid_grant",
          "Code expired, used, or PKCE/redirect mismatch",
        );
    } else if (a.grant_type === "refresh_token") {
      if (typeof a.refresh_token !== "string")
        return failure(res, "invalid_grant", "Refresh token required");
      const old = hash(a.refresh_token);
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const row = (
          await client.query(
            "SELECT * FROM oauth_grants WHERE refresh=$1 AND client=$2 AND resource=$3 AND NOT revoked AND refresh_expires>now() FOR UPDATE",
            [old, a.client_id, resource],
          )
        ).rows[0];
        if (!row) {
          await client.query(
            "UPDATE oauth_grants SET revoked=true WHERE client=$1 AND id IN (SELECT grant_id FROM oauth_used_refresh WHERE hash=$2)",
            [a.client_id, old],
          );
          await client.query("COMMIT");
          return failure(
            res,
            "invalid_grant",
            "Refresh token expired or reused; authorize again",
          );
        }
        await client.query("INSERT INTO oauth_used_refresh VALUES($1,$2)", [
          old,
          row.id,
        ]);
        await client.query(
          "UPDATE oauth_grants SET access=$2,refresh=$3,access_expires=now()+interval '1 hour' WHERE id=$1",
          [row.id, hash(access), hash(refresh)],
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    } else
      return failure(
        res,
        "unsupported_grant_type",
        "Use authorization_code or refresh_token",
      );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope,
    };
  });
  app.post("/oauth/revoke", async (req) => {
    if (
      typeof req.body?.token === "string" &&
      typeof req.body?.client_id === "string"
    )
      await db.pool.query(
        "UPDATE oauth_grants SET revoked=true WHERE client=$1 AND (access=$2 OR refresh=$2)",
        [req.body.client_id, hash(req.body.token)],
      );
    return {};
  });
  actions.registry.oauth_grants = {
    description: "List OAuth connections",
    schema: z.object({}),
    fn: () =>
      db.all(
        "SELECT g.id,c.name,g.created,g.refresh_expires,g.revoked FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client WHERE NOT g.revoked ORDER BY g.created DESC LIMIT 100",
      ),
  };
  actions.registry.oauth_revoke = {
    description: "Revoke an OAuth connection",
    schema: z.object({ id: z.string().uuid() }),
    fn: async ({ id }) => {
      await db.pool.query("UPDATE oauth_grants SET revoked=true WHERE id=$1", [
        id,
      ]);
      return { ok: true };
    },
  };
  const clean = async () => {
    await db.pool.query(
      "DELETE FROM oauth_requests WHERE expires<now(); DELETE FROM oauth_codes WHERE expires<now(); DELETE FROM oauth_grants WHERE refresh_expires<now()-interval '1 day'; DELETE FROM oauth_clients WHERE created<now()-interval '1 day' AND id NOT IN (SELECT client FROM oauth_grants UNION SELECT client FROM oauth_requests UNION SELECT client FROM oauth_codes)",
    );
  };
  const cleanup = setInterval(() => void clean().catch(() => {}), 3600000);
  cleanup.unref();
  app.addHook("onClose", async () => clearInterval(cleanup));
  return {
    async verify(value) {
      return !!(await db.one(
        "SELECT id FROM oauth_grants WHERE access=$1 AND resource=$2 AND scope=$3 AND NOT revoked AND access_expires>now() AND refresh_expires>now()",
        [hash(value), resource, scope],
      ));
    },
    challenge: `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${scope}"`,
  };
}
