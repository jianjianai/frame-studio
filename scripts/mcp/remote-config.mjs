import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { validProjectId } from "../project-metadata.mjs";

const list = (value) => (value ?? "").split(/[\s,]+/).filter(Boolean);
const bool = (value, fallback = false) => {
  if (value === undefined || value === "") return fallback;
  if (!["true", "false"].includes(value))
    throw new Error("Boolean configuration must be true or false");
  return value === "true";
};
const integer = (value, fallback, min, max, name) => {
  const n = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${name} must be ${min}..${max}`);
  return n;
};
export const SCOPES = ["frame:read", "frame:write"];
export function redirectUri(value) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.hash ||
    !["http:", "https:"].includes(u.protocol)
  )
    throw new Error(
      "OAuth callbacks must use HTTP(S), without credentials or fragments",
    );
  return u.href;
}
export function loadRemoteConfig(
  root,
  { envFile = ".env", env = process.env } = {},
) {
  const file = path.resolve(root, envFile);
  const values = {
    ...(fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {}),
    ...env,
  };
  const publicUrl = new URL(
    values.FRAME_MCP_PUBLIC_URL || "http://127.0.0.1:8787",
  );
  if (
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.pathname !== "/"
  )
    throw new Error(
      "FRAME_MCP_PUBLIC_URL must be an origin, e.g. https://mcp.example.com",
    );
  if (!["http:", "https:"].includes(publicUrl.protocol))
    throw new Error("Remote public URL must use HTTP(S)");
  const mode = values.FRAME_MCP_AUTH_MODE || "both";
  if (!["oauth", "bearer", "both"].includes(mode))
    throw new Error("FRAME_MCP_AUTH_MODE must be oauth, bearer or both");
  const projects = list(values.FRAME_MCP_PROJECTS);
  if (
    !projects.length ||
    (projects.includes("*") && projects.length !== 1) ||
    projects.some((id) => id !== "*" && !validProjectId(id))
  )
    throw new Error(
      "Set FRAME_MCP_PROJECTS to project ids, or explicitly * for the whole workspace",
    );
  const readOnly = bool(values.FRAME_MCP_READ_ONLY);
  const allowedScopes = readOnly ? ["frame:read"] : SCOPES;
  const bearerToken =
    mode === "oauth" ? "" : values.FRAME_MCP_BEARER_TOKEN || "";
  if (
    mode !== "oauth" &&
    (!/^[A-Za-z0-9._~+/-]{32,512}={0,2}$/.test(bearerToken) ||
      /change|example|replace/i.test(bearerToken))
  )
    throw new Error(
      "FRAME_MCP_BEARER_TOKEN must be a random token of at least 32 characters",
    );
  const bearerScopes = list(
    values.FRAME_MCP_BEARER_SCOPES || allowedScopes.join(" "),
  );
  if (
    !bearerScopes.includes("frame:read") ||
    bearerScopes.some((s) => !SCOPES.includes(s))
  )
    throw new Error("Invalid Bearer scopes");
  const password =
    mode === "bearer" ? "" : values.FRAME_OAUTH_ADMIN_PASSWORD || "";
  if (
    mode !== "bearer" &&
    (password.length < 20 ||
      password.length > 256 ||
      /^(change|replace|example)/i.test(password))
  )
    throw new Error(
      "Set FRAME_OAUTH_ADMIN_PASSWORD to a strong private password of 20..256 characters",
    );
  let clients;
  try {
    clients = JSON.parse(values.FRAME_OAUTH_CLIENTS || "[]");
  } catch {
    throw new Error("FRAME_OAUTH_CLIENTS must contain valid JSON");
  }
  if (!Array.isArray(clients) || clients.length > 64)
    throw new Error(
      "FRAME_OAUTH_CLIENTS must be an array of at most 64 clients",
    );
  const tunnelEnabled = bool(values.CLOUDFLARE_TUNNEL_ENABLED);
  const tunnelToken = values.CLOUDFLARE_TUNNEL_TOKEN || "";
  const port = integer(values.FRAME_MCP_PORT, 8787, 0, 65535, "FRAME_MCP_PORT");
  if (tunnelEnabled && !tunnelToken)
    throw new Error("Tunnel requires CLOUDFLARE_TUNNEL_TOKEN");
  if (tunnelEnabled && port === 0)
    throw new Error("Tunnel requires a fixed FRAME_MCP_PORT");
  if (
    !["auto", "http2", "quic"].includes(
      values.CLOUDFLARE_TUNNEL_PROTOCOL || "auto",
    )
  )
    throw new Error("Tunnel protocol must be auto, http2 or quic");
  return {
    root: path.resolve(root),
    envFile: file,
    publicUrl: publicUrl.origin,
    resource: publicUrl.origin + "/mcp",
    host: values.FRAME_MCP_HOST || "127.0.0.1",
    port,
    projects: projects[0] === "*" ? [] : projects,
    readOnly,
    allowedScopes,
    mode,
    bearerToken,
    bearerScopes: bearerScopes.filter((s) => allowedScopes.includes(s)),
    oauth: {
      enabled: mode !== "bearer",
      password,
      clients,
      accessTtl: integer(
        values.FRAME_OAUTH_ACCESS_TTL,
        900,
        60,
        3600,
        "FRAME_OAUTH_ACCESS_TTL",
      ),
      refreshTtl: integer(
        values.FRAME_OAUTH_REFRESH_TTL,
        2592000,
        3600,
        7776000,
        "FRAME_OAUTH_REFRESH_TTL",
      ),
    },
    stateDirectory: path.join(root, ".secrets/frame-mcp"),
    timeoutMs:
      integer(
        values.FRAME_MCP_JOB_TIMEOUT,
        600,
        1,
        3600,
        "FRAME_MCP_JOB_TIMEOUT",
      ) * 1000,
    maxPrincipals: integer(
      values.FRAME_MCP_MAX_PRINCIPALS,
      32,
      1,
      128,
      "FRAME_MCP_MAX_PRINCIPALS",
    ),
    tunnel: {
      enabled: tunnelEnabled,
      token: tunnelToken,
      executable: values.CLOUDFLARED_PATH || "cloudflared",
      protocol: values.CLOUDFLARE_TUNNEL_PROTOCOL || "auto",
    },
  };
}
