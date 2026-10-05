import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { sameRedirect, validRedirect } from "../server/oauth.mjs";

const PASSWORD = "oauth-test-password";
const REDIRECT = "http://127.0.0.1:33418/callback";

describe("MCP OAuth", () => {
  let app, base, work;
  const form = (body) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString(), redirect: "manual" });
  const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const mcp = (token, method, params = {}) =>
    fetch(base + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const mcpResult = async (response) => JSON.parse((await response.text()).split("\n").find((line) => line.startsWith("data: ")).slice(6)).result;

  /** Register, consent (as the given form choices) and exchange the code. */
  async function authorize(choices = {}, { scope = "frame:read frame:write" } = {}) {
    const client = await (await fetch(base + "/oauth/register", json({ client_name: "测试客户端", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }))).json();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT.replace("33418", "40001"), // loopback: any port
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      scope,
      resource: base + "/mcp",
    });
    const page = await fetch(`${base}/oauth/authorize?${query}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("测试客户端");
    expect(html).toContain('type="password"');
    const sealed = /name="request" value="([^"]+)"/.exec(html)[1];
    const approved = await fetch(base + "/oauth/authorize", form({ request: sealed, decision: "allow", password: PASSWORD, access: "write", work: "", ...choices }));
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("location"));
    expect(location.port).toBe("40001");
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code");
    const tokens = await (
      await fetch(base + "/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: location.origin + location.pathname }))
    ).json();
    return { client, tokens, code, verifier };
  }

  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-oauth-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0", FRAME_PASSWORD: PASSWORD }, plugins });
    base = await app.listen();
    work = await app.services.works.create({ title: "授权测试" });
  });
  afterAll(() => app.close());

  it("points unauthenticated MCP clients at the metadata", async () => {
    const response = await mcp(null, "tools/list");
    expect(response.status).toBe(401);
    const header = response.headers.get("www-authenticate");
    expect(header).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    const resource = await (await fetch(base + "/.well-known/oauth-protected-resource/mcp")).json();
    expect(resource).toMatchObject({ resource: base + "/mcp", authorization_servers: [base] });
    const server = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
    expect(server).toMatchObject({ issuer: base, token_endpoint: base + "/oauth/token", code_challenge_methods_supported: ["S256"] });
  });

  it("answers CORS preflights and cross-origin token requests", async () => {
    const preflight = await fetch(base + "/oauth/token", { method: "OPTIONS", headers: { Origin: "https://inspector.example", "Access-Control-Request-Method": "POST" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const response = await fetch(base + "/oauth/token", { ...form({ grant_type: "refresh_token", refresh_token: "x", client_id: "nope" }), headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://inspector.example" } });
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("invalid_client");
  });

  it("rejects bad registrations and unknown clients", async () => {
    const bad = await fetch(base + "/oauth/register", json({ redirect_uris: ["http://evil.example/cb"] }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_redirect_uri");
    const page = await fetch(`${base}/oauth/authorize?client_id=nope&response_type=code`);
    expect(page.status).toBe(400);
  });

  it("issues tokens after consent and serves MCP with them", async () => {
    const { tokens, client, code, verifier } = await authorize();
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "frame:read frame:write" });
    const listed = await mcpResult(await mcp(tokens.access_token, "tools/list"));
    expect(listed.tools.map((tool) => tool.name)).toContain("file_write");
    // Codes are single use.
    const again = await fetch(base + "/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id }));
    expect((await again.json()).error).toBe("invalid_grant");
    // OAuth tokens reach the tools only.
    const api = await fetch(base + "/api/works", { headers: { Authorization: "Bearer " + tokens.access_token } });
    expect(api.status).toBe(403);
  });

  it("binds a grant to one work and to read-only access", async () => {
    const { tokens } = await authorize({ access: "read", work: `local/${work.id}` }, { scope: "frame:read" });
    expect(tokens.scope).toBe("frame:read");
    const listed = await mcpResult(await mcp(tokens.access_token, "tools/list"));
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain("work_context");
    expect(names).not.toContain("file_write");
    expect(names).not.toContain("works_list");
    const context = await mcpResult(await mcp(tokens.access_token, "tools/call", { name: "work_context", arguments: {} }));
    expect(context.content[0].text).toContain(work.id);
  });

  it("rotates refresh tokens and revokes grants", async () => {
    const { tokens, client } = await authorize();
    const refreshed = await (await fetch(base + "/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }))).json();
    expect(refreshed.access_token).toBeTruthy();
    const reused = await fetch(base + "/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }));
    expect((await reused.json()).error).toBe("invalid_grant");

    const login = await fetch(base + "/api/login", json({ password: PASSWORD }));
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const grants = await (await fetch(base + "/api/mcp/oauth", { headers: { Cookie: cookie } })).json();
    const grant = grants.find((item) => item.clientId === client.client_id);
    expect(grant).toMatchObject({ clientName: "测试客户端", readOnly: false });
    expect(grant.refreshHash).toBeUndefined();
    // OAuth tokens cannot manage grants themselves.
    expect((await fetch(base + "/api/mcp/oauth", { headers: { Authorization: "Bearer " + refreshed.access_token } })).status).toBe(403);
    await fetch(base + "/api/mcp/oauth/" + grant.id, { method: "DELETE", headers: { Cookie: cookie } });
    expect((await mcp(refreshed.access_token, "tools/list")).status).toBe(401);
  });

  it("refuses a wrong password and a wrong PKCE verifier", async () => {
    const client = await (await fetch(base + "/oauth/register", json({ redirect_uris: [REDIRECT] }))).json();
    const challenge = createHash("sha256").update("right").digest("base64url");
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    const sealed = /name="request" value="([^"]+)"/.exec(await (await fetch(`${base}/oauth/authorize?${query}`)).text())[1];
    const wrong = await fetch(base + "/oauth/authorize", form({ request: sealed, decision: "allow", password: "nope", access: "write" }));
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("密码错误");
    const tampered = await fetch(base + "/oauth/authorize", form({ request: sealed.replace(/.$/, "x"), decision: "allow", password: PASSWORD }));
    expect(tampered.status).toBe(400);
    const approved = await fetch(base + "/oauth/authorize", form({ request: sealed, decision: "allow", password: PASSWORD, access: "write" }));
    const code = new URL(approved.headers.get("location")).searchParams.get("code");
    const token = await fetch(base + "/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: "wrong", client_id: client.client_id }));
    expect((await token.json()).error).toBe("invalid_grant");
    const denied = await fetch(base + "/oauth/authorize", form({ request: sealed, decision: "deny" }));
    expect(new URL(denied.headers.get("location")).searchParams.get("error")).toBe("access_denied");
  });

  it("validates redirect URIs", () => {
    expect(validRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(validRedirect("http://localhost:8080/cb")).toBe(true);
    expect(validRedirect("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(validRedirect("http://example.com/cb")).toBe(false);
    expect(validRedirect("javascript:alert(1)")).toBe(false);
    expect(validRedirect("https://a.example/cb#frag")).toBe(false);
    expect(sameRedirect("http://127.0.0.1:1/cb", "http://127.0.0.1:2/cb")).toBe(true);
    expect(sameRedirect("https://a.example/cb", "https://a.example/cb2")).toBe(false);
  });
});
