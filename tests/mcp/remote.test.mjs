import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  Client,
  StreamableHTTPClientTransport,
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
} from "@modelcontextprotocol/client";
import { fixture, repo, call } from "./helpers.mjs";
import { loadRemoteConfig } from "../../scripts/mcp/remote-config.mjs";
import {
  RemoteAuth,
  validateOAuthClients,
} from "../../scripts/mcp/remote-auth.mjs";
import { startRemoteServer } from "../../scripts/mcp/remote-http.mjs";
import { tunnelCommand, startTunnel } from "../../scripts/mcp/tunnel.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";

const secret = () => randomBytes(32).toString("base64url");
const callback = "https://ai.example/callback";
// Restart tests deliberately use fresh TCP connections; authorization state, not socket reuse, is under test.
const fetch = (url, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Connection", "close");
  return globalThis.fetch(url, { ...init, headers });
};
function configuration(root, overrides = {}) {
  return loadRemoteConfig(root, {
    env: {
      FRAME_MCP_PUBLIC_URL: "http://127.0.0.1:8787",
      FRAME_MCP_PORT: "0",
      FRAME_MCP_PROJECTS: "test-film",
      FRAME_MCP_AUTH_MODE: "both",
      FRAME_MCP_BEARER_TOKEN: secret(),
      FRAME_OAUTH_ADMIN_PASSWORD: secret(),
      FRAME_OAUTH_REDIRECT_URIS: callback,
      ...overrides,
    },
  });
}
async function running(f, overrides = {}) {
  const config = configuration(f.root, overrides),
    app = await startRemoteServer(config);
  config.publicUrl = app.url;
  config.resource = app.url + "/mcp";
  config.origins = [app.url];
  return app;
}
async function connect(app, token = app.config.bearerToken) {
  const client = new Client({ name: "remote-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(app.config.resource), {
      fetch,
      requestInit: { headers: { Authorization: "Bearer " + token } },
    }),
  );
  return client;
}
const form = async (app, route, values, headers = {}) =>
  fetch(app.url + route, {
    method: "POST",
    headers: {
      Connection: "close",
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(values),
    redirect: "manual",
  });
async function registration(app, method = "none", redirect = callback) {
  const response = await fetch(app.url + "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Fixture AI",
      redirect_uris: [redirect],
      token_endpoint_auth_method: method,
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
async function consent(
  app,
  authorizationUrl,
  {
    password = app.config.oauth.password,
    origin = app.url,
    cookieOverride,
    decision = "allow",
  } = {},
) {
  const page = await fetch(authorizationUrl),
    text = await page.text();
  assert.equal(page.status, 200, text);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const id = /name="request" value="([^"]+)"/.exec(text)?.[1];
  assert.ok(id);
  const cookie = cookieOverride ?? page.headers.get("set-cookie").split(";")[0];
  const response = await form(
    app,
    "/oauth/authorize",
    { request: id, password, decision },
    { Origin: origin, Cookie: cookie },
  );
  return response;
}
async function code(
  app,
  client,
  {
    scope = "frame:read frame:write",
    resource = app.config.resource,
    redirect = callback,
  } = {},
) {
  const verifier = secret(),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(app.url + "/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    scope,
    state: "test-state",
  }).toString();
  const approved = await consent(app, url);
  assert.equal(approved.status, 303, await approved.clone().text());
  const redirected = new URL(approved.headers.get("location"));
  assert.equal(redirected.searchParams.get("state"), "test-state");
  assert.equal(redirected.searchParams.get("iss"), app.url);
  return { code: redirected.searchParams.get("code"), verifier, url };
}
async function grant(app, client, options) {
  const c = await code(app, client, options);
  const response = await form(app, "/oauth/token", {
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: callback,
    resource: app.config.resource,
    code: c.code,
    code_verifier: c.verifier,
    ...(client.client_secret ? { client_secret: client.client_secret } : {}),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test("remote env init is private and non-overwriting; invalid authentication and public origins fail closed", () => {
  const f = fixture();
  try {
    const file = path.join(f.root, ".evn");
    const invoke = () =>
      spawnSync(
        process.execPath,
        [
          "--",
          path.join(repo, "scripts/mcp-remote.mjs"),
          "init",
          "--env-file",
          file,
        ],
        { cwd: repo, encoding: "utf8" },
      );
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    const config = loadRemoteConfig(f.root, {
      envFile: file,
      env: { FRAME_MCP_PROJECTS: "test-film" },
    });
    assert.ok(config.bearerToken.length >= 32);
    assert.ok(!result.stdout.includes(config.bearerToken));
    const before = fs.readFileSync(file, "utf8");
    assert.notEqual(invoke().status, 0);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.throws(
      () => configuration(f.root, { FRAME_MCP_BEARER_TOKEN: "weak" }),
      /random token/,
    );
    assert.throws(
      () =>
        configuration(f.root, {
          FRAME_MCP_PUBLIC_URL: "http://remote.example",
        }),
      /HTTPS/,
    );
    assert.throws(
      () => configuration(f.root, { FRAME_MCP_PROJECTS: "" }),
      /PROJECTS/,
    );
    const invalid = configuration(f.root, {
      FRAME_OAUTH_CLIENTS:
        '[{"client_id":"ai","redirect_uris":["https://unapproved.example/callback"]}]',
    });
    assert.throws(() => validateOAuthClients(invalid), /Callback/);
    assert.throws(
      () =>
        configuration(f.root, {
          FRAME_OAUTH_CLIENTS: '{"client_secret":"private malformed value',
        }),
      /must contain valid JSON/,
    );
    assert.throws(
      () =>
        configuration(f.root, {
          FRAME_OAUTH_REDIRECT_URIS: "https://ai.example/#fragment",
        }),
      /callbacks/,
    );
    assert.throws(
      () =>
        configuration(f.root, {
          CLOUDFLARE_TUNNEL_ENABLED: "true",
          CLOUDFLARE_TUNNEL_TOKEN: "fake",
        }),
      /HTTPS/,
    );
  } finally {
    f.close();
  }
});

test(
  "Bearer HTTP serves real SDK tools, rejects unauthenticated/origin/host access and protects downloads",
  { timeout: 30000 },
  async () => {
    const f = fixture({ browser: true });
    let app, client;
    try {
      app = await running(f);
      const response = await fetch(app.config.resource);
      assert.equal(response.status, 401);
      assert.ok(
        response.headers.get("www-authenticate").includes("resource_metadata"),
      );
      assert.equal(
        (
          await fetch(app.config.resource, {
            headers: { Authorization: "Bearer invalid" },
          })
        ).status,
        401,
      );
      const hostStatus = await new Promise((resolve, reject) => {
        const request = http.get(
          app.url + "/healthz",
          { headers: { Host: "evil.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on("error", reject);
      });
      assert.equal(hostStatus, 403);
      assert.equal(
        (
          await fetch(app.config.resource, {
            headers: {
              Authorization: "Bearer " + app.config.bearerToken,
              Origin: "https://evil.example",
            },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(
            app.config.resource + "?access_token=" + app.config.bearerToken,
          )
        ).status,
        401,
      );
      client = await connect(app);
      assert.deepEqual(
        (await call(client, "frame_list_projects")).projects.map((p) => p.id),
        ["test-film"],
      );
      const blocked = await client.callTool({
        name: "frame_read_file",
        arguments: { project: "another-film", path: "scene.ts" },
      });
      assert.equal(blocked.isError, true);
      const source = await call(client, "frame_read_file", {
        project: "test-film",
        path: "scene.ts",
      });
      const edit = await client.callTool({
        name: "frame_patch_files",
        arguments: {
          project: "test-film",
          changes: [
            {
              path: "scene.ts",
              expectedSha256: source.sha256,
              replacements: [
                { find: "createScene", replace: "createScene", count: 1 },
              ],
            },
          ],
        },
      });
      assert.notEqual(edit.isError, true, JSON.stringify(edit));
      fs.mkdirSync(f.file("exports/sample"), { recursive: true });
      fs.writeFileSync(f.file("exports/sample/media.wav"), "abcdefghijklmnop");
      const url = app.url + "/artifacts/test-film/exports/sample/media.wav";
      assert.equal((await fetch(url)).status, 401);
      const piece = await fetch(url, {
        headers: {
          Authorization: "Bearer " + app.config.bearerToken,
          Range: "bytes=2-5",
        },
      });
      assert.equal(piece.status, 206);
      assert.equal(await piece.text(), "cdef");
      assert.equal(piece.headers.get("content-range"), "bytes 2-5/16");
      assert.equal(
        (
          await fetch(app.url + "/artifacts/test-film/production/brief.md", {
            headers: { Authorization: "Bearer " + app.config.bearerToken },
          })
        ).status,
        404,
      );
      const health = await fetch(app.url + "/healthz");
      assert.deepEqual(await health.json(), { status: "ready" });
    } finally {
      await client?.close();
      await app?.close();
      f.close();
    }
  },
);

test(
  "official OAuth SDK discovers, registers, authorizes with PKCE and connects over Streamable HTTP",
  { timeout: 30000 },
  async () => {
    const f = fixture({ browser: true });
    let app, client, transport;
    try {
      app = await running(f);
      const resource = await discoverOAuthProtectedResourceMetadata(
        new URL(app.config.resource),
      );
      assert.equal(resource.resource, app.config.resource);
      const metadata = await discoverAuthorizationServerMetadata(app.url);
      assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
      let info, tokens, verifier, authorizationUrl, discovery;
      const provider = {
        redirectUrl: callback,
        clientMetadata: {
          client_name: "SDK OAuth",
          redirect_uris: [callback],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
        clientInformation: () => info,
        saveClientInformation: (value) => {
          info = value;
        },
        tokens: () => tokens,
        saveTokens: (value) => {
          tokens = value;
        },
        saveCodeVerifier: (value) => {
          verifier = value;
        },
        codeVerifier: () => verifier,
        redirectToAuthorization: (url) => {
          authorizationUrl = url;
        },
        state: () => "sdk-state",
        saveDiscoveryState: (value) => {
          discovery = value;
        },
        discoveryState: () => discovery,
      };
      transport = new StreamableHTTPClientTransport(
        new URL(app.config.resource),
        { authProvider: provider },
      );
      client = new Client({ name: "oauth-real-client", version: "1.0.0" });
      await assert.rejects(() => client.connect(transport));
      assert.ok(authorizationUrl, "SDK must discover and start OAuth");
      assert.ok(info.client_id);
      const approval = await consent(app, authorizationUrl);
      assert.equal(approval.status, 303, await approval.clone().text());
      await transport.finishAuth(
        new URL(approval.headers.get("location")).searchParams,
      );
      assert.ok(tokens.access_token);
      await client.close();
      client = new Client({ name: "oauth-real-client", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.config.resource), {
          authProvider: provider,
        }),
      );
      assert.equal(
        (await call(client, "frame_list_projects")).projects[0].id,
        "test-film",
      );
      const saved = fs.readFileSync(
        path.join(app.config.stateDirectory, "oauth.json"),
        "utf8",
      );
      assert.ok(!saved.includes(tokens.access_token));
      assert.ok(!saved.includes(tokens.refresh_token));
      assert.ok(!saved.includes(app.config.oauth.password));
    } finally {
      await client?.close();
      await app?.close();
      f.close();
    }
  },
);

test(
  "OAuth binds resource, callback, client and PKCE; consent rejects CSRF and wrong passwords",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    let app;
    try {
      app = await running(f);
      const c = await registration(app),
        issued = await code(app, c);
      const wrong = await form(app, "/oauth/token", {
        grant_type: "authorization_code",
        client_id: c.client_id,
        redirect_uri: callback,
        resource: app.config.resource,
        code: issued.code,
        code_verifier: secret(),
      });
      assert.equal(wrong.status, 400);
      assert.equal((await wrong.json()).error, "invalid_grant");
      const replay = await form(app, "/oauth/token", {
        grant_type: "authorization_code",
        client_id: c.client_id,
        redirect_uri: callback,
        resource: app.config.resource,
        code: issued.code,
        code_verifier: issued.verifier,
      });
      assert.equal(replay.status, 400);
      const redirected = new URL(issued.url);
      redirected.searchParams.set(
        "redirect_uri",
        "https://evil.example/callback",
      );
      assert.equal(
        (await fetch(redirected, { redirect: "manual" })).status,
        400,
      );
      const audience = new URL(issued.url);
      audience.searchParams.set("resource", "https://other.example/mcp");
      assert.equal((await fetch(audience)).status, 400);
      const challenge = new URL(issued.url);
      challenge.searchParams.set("code_challenge_method", "plain");
      assert.equal((await fetch(challenge)).status, 400);
      assert.equal(
        (
          await consent(app, issued.url, {
            cookieOverride: "frame_oauth=wrong",
          })
        ).status,
        403,
      );
      assert.equal(
        (await consent(app, issued.url, { password: "wrong password" })).status,
        403,
      );
      assert.equal(
        (await consent(app, issued.url, { origin: "https://evil.example" }))
          .status,
        403,
      );
      const denied = await consent(app, issued.url, { decision: "deny" });
      assert.equal(
        new URL(denied.headers.get("location")).searchParams.get("error"),
        "access_denied",
      );
      const deniedRegistration = await fetch(app.url + "/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://evil.example/callback"],
          token_endpoint_auth_method: "none",
        }),
      });
      assert.equal(deniedRegistration.status, 400);
    } finally {
      await app?.close();
      f.close();
    }
  },
);

test(
  "read-only OAuth is enforced in HTTP and tools; refresh rotates, persists, expires and replay revokes",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    let app, client;
    try {
      app = await running(f);
      const config = app.config,
        c = await registration(app),
        tokens = await grant(app, c, { scope: "frame:read" });
      client = await connect(app, tokens.access_token);
      assert.ok(
        !(await client.listTools()).tools.some(
          (t) => t.name === "frame_edit_files",
        ),
      );
      const forbidden = await fetch(app.config.resource, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tokens.access_token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "frame_edit_files", arguments: {} },
        }),
      });
      assert.equal(forbidden.status, 403);
      const refresh = () =>
        form(app, "/oauth/token", {
          grant_type: "refresh_token",
          client_id: c.client_id,
          resource: app.config.resource,
          refresh_token: tokens.refresh_token,
        });
      const next = await refresh();
      assert.equal(next.status, 200);
      const rotated = await next.json();
      assert.notEqual(rotated.refresh_token, tokens.refresh_token);
      await client.close();
      client = undefined;
      await app.close();
      config.port = Number(new URL(config.publicUrl).port);
      app = await startRemoteServer(config);
      assert.equal(
        app.auth.verify("Bearer " + rotated.access_token).scopes.join(" "),
        "frame:read",
      );
      const now = app.auth.now;
      app.auth.now = () => now() + config.oauth.accessTtl * 1000 + 1;
      assert.throws(
        () => app.auth.verify("Bearer " + rotated.access_token),
        /expired/,
      );
      app.auth.now = now;
      const reuse = await refresh();
      assert.equal(reuse.status, 400);
      assert.throws(
        () => app.auth.verify("Bearer " + rotated.access_token),
        /expired/,
      );
      const other = await grant(app, c);
      const revoke = await form(app, "/oauth/revoke", {
        client_id: c.client_id,
        token: other.refresh_token,
      });
      assert.equal(revoke.status, 200);
      assert.throws(
        () => app.auth.verify("Bearer " + other.access_token),
        /expired/,
      );
    } finally {
      await client?.close();
      await app?.close();
      f.close();
    }
  },
);

test(
  "HTTP jobs survive requests, resist cancellation by another authorization and return download URLs",
  { timeout: 30000 },
  async () => {
    const f = fixture({ browser: true });
    let app, client;
    try {
      app = await running(f);
      client = await connect(app);
      const otherTokens = await grant(app, await registration(app));
      const job = await call(client, "frame_start_validation", {
        project: "test-film",
        action: "typecheck",
      });
      const other = await connect(app, otherTokens.access_token);
      try {
        const cancellation = await other.callTool({
          name: "frame_cancel_job",
          arguments: { project: "test-film", jobId: job.id },
        });
        assert.notEqual(
          cancellation.isError,
          true,
          JSON.stringify(cancellation),
        );
        assert.ok(
          ["unobserved", "succeeded"].includes(
            cancellation.structuredContent.status,
          ),
          JSON.stringify(cancellation),
        );
      } finally {
        await other.close();
      }
      await client.close();
      client = await connect(app);
      let state;
      for (let i = 0; i < 80; i++) {
        state = await call(client, "frame_job", {
          project: "test-film",
          jobId: job.id,
        });
        if (!["running", "cancelling"].includes(state.status)) break;
        await delay(100);
      }
      assert.equal(state.status, "succeeded", JSON.stringify(state));
      const artifact = await client.callTool({
        name: "frame_read_artifact",
        arguments: { project: "test-film", jobId: job.id, name: "result.json" },
      });
      assert.notEqual(artifact.isError, true, JSON.stringify(artifact));
      assert.ok(
        artifact.structuredContent.remoteArtifacts?.some((a) =>
          a.uri.startsWith(app.url + "/artifacts/"),
        ),
      );
      assert.equal(app.principals.size, 2);
    } finally {
      await client?.close();
      await app?.close();
      f.close();
    }
  },
);

test(
  "confidential OAuth clients verify secrets, state locks reject a second instance and Bearer-only stays usable",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    let app;
    try {
      app = await running(f);
      assert.throws(() => new RemoteAuth(app.config), /lock/);
      const c = await registration(app, "client_secret_post");
      const tokens = await grant(app, c);
      const bad = await form(app, "/oauth/token", {
        grant_type: "refresh_token",
        client_id: c.client_id,
        client_secret: "bad",
        resource: app.config.resource,
        refresh_token: tokens.refresh_token,
      });
      assert.equal(bad.status, 401);
      const basicClient = await registration(app, "client_secret_basic"),
        issued = await code(app, basicClient);
      const body = {
        grant_type: "authorization_code",
        redirect_uri: callback,
        resource: app.config.resource,
        code: issued.code,
        code_verifier: issued.verifier,
      };
      const malformed = await form(app, "/oauth/token", body, {
        Authorization: "Basic " + Buffer.from("%ZZ:invalid").toString("base64"),
      });
      assert.equal(malformed.status, 401);
      const basic = await form(app, "/oauth/token", body, {
        Authorization:
          "Basic " +
          Buffer.from(
            basicClient.client_id + ":" + basicClient.client_secret,
          ).toString("base64"),
      });
      assert.equal(basic.status, 200, await basic.clone().text());
      await app.close();
      app = await running(f, { FRAME_MCP_AUTH_MODE: "bearer" });
      assert.equal(
        (await fetch(app.url + "/.well-known/oauth-authorization-server"))
          .status,
        404,
      );
      assert.deepEqual(
        (
          await (
            await fetch(app.url + "/.well-known/oauth-protected-resource/mcp")
          ).json()
        ).authorization_servers,
        [],
      );
    } finally {
      await app?.close();
      f.close();
    }
  },
);

test(
  "Cloudflare token is environment-only; owned tunnel exit and shutdown are observable",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      const config = configuration(f.root),
        token = secret();
      config.tunnel.token = token;
      const spec = tunnelCommand(config);
      assert.ok(!spec.args.join(" ").includes(token));
      assert.equal(spec.options.env.TUNNEL_TOKEN, token);
      assert.equal(spec.options.env.FRAME_OAUTH_ADMIN_PASSWORD, undefined);
      assert.equal(spec.options.windowsHide, true);
      const tunnelConfig = {
        ...config,
        tunnel: { ...config.tunnel, executable: process.execPath },
      };
      const original = process.env.NODE_OPTIONS;
      // Use a real executable failure path: node rejects the cloudflared-only arguments.
      let exited;
      const messages = [];
      const tunnel = startTunnel(tunnelConfig, {
        onExit: (value) => {
          exited = value;
        },
        onLog: (line) => messages.push(line),
      });
      await tunnel.ready;
      for (let i = 0; i < 40 && !exited; i++) await delay(25);
      assert.ok(exited);
      assert.notEqual(exited.code, 0);
      await tunnel.close();
      assert.ok(messages.every((line) => !line.includes(token)));
      assert.equal(process.env.NODE_OPTIONS, original);
    } finally {
      f.close();
    }
  },
);

test(
  "legacy 2025 Streamable HTTP initializes and lists tools without a server session",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    let app;
    try {
      app = await running(f);
      const request = async (body) => {
        const response = await fetch(app.config.resource, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + app.config.bearerToken,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
          },
          body: JSON.stringify(body),
        });
        assert.ok(response.ok, await response.clone().text());
        const text = await response.text();
        return text.startsWith("event:") || text.startsWith("data:")
          ? text
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => JSON.parse(line.slice(5)))
              .find((message) => message.id === body.id)
          : text
            ? JSON.parse(text)
            : undefined;
      };
      const init = await request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "1" },
        },
      });
      assert.equal(init.result.protocolVersion, "2025-11-25");
      await request({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listed = await request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      assert.ok(
        listed.result.tools.some((t) => t.name === "frame_project_context"),
      );
    } finally {
      await app?.close();
      f.close();
    }
  },
);

test(
  "browser consent preserves cookies, submits owner password and reaches the allowed external callback",
  { timeout: 60000 },
  async () => {
    const f = fixture();
    let app, browser, callbackServer, callbackUrl, callbackReferer;
    try {
      // A real second origin avoids depending on interception of redirect chains.
      // Loopback HTTP is the OAuth exception; production callback configuration requires HTTPS.
      callbackServer = http.createServer((request, response) => {
        callbackReferer = request.headers.referer;
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<h1>OAuth callback received</h1>");
      });
      await new Promise((resolve, reject) => {
        callbackServer.once("error", reject);
        callbackServer.listen(0, "127.0.0.1", resolve);
      });
      callbackUrl = `http://127.0.0.1:${callbackServer.address().port}/callback`;
      app = await running(f, { FRAME_OAUTH_REDIRECT_URIS: callbackUrl });
      const registered = await registration(app, "none", callbackUrl),
        issued = await code(app, registered, { redirect: callbackUrl });
      browser = await launchBrowser();
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(20000);
      const navigationErrors = [];
      page.on("console", (message) => {
        if (message.type() === "error") navigationErrors.push(message.text());
      });
      page.on("requestfailed", (request) =>
        navigationErrors.push(request.failure()?.errorText),
      );
      await page.goto(issued.url.href);
      await page
        .getByLabel("输入本机配置的授权密码")
        .fill(app.config.oauth.password);
      const [approval] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/oauth/authorize",
        ),
        page
          .getByRole("button", { name: "允许连接" })
          .click({ noWaitAfter: true }),
      ]);
      assert.equal(
        approval.status(),
        303,
        approval.status() === 303 ? "" : await approval.text(),
      );
      try {
        await page.waitForURL(callbackUrl + "**", { waitUntil: "commit" });
      } catch (error) {
        throw new Error(
          error.message +
            "\nBrowser errors: " +
            JSON.stringify(navigationErrors),
        );
      }
      const redirected = new URL(page.url());
      assert.equal(callbackReferer, undefined);
      assert.ok(redirected.searchParams.get("code"));
      assert.equal(redirected.searchParams.get("iss"), app.url);
      const response = await form(app, "/oauth/token", {
        grant_type: "authorization_code",
        client_id: registered.client_id,
        redirect_uri: callbackUrl,
        resource: app.config.resource,
        code: redirected.searchParams.get("code"),
        code_verifier: issued.verifier,
      });
      assert.equal(response.status, 200, await response.clone().text());
    } finally {
      await browser?.close();
      if (callbackServer)
        await new Promise((resolve) => {
          callbackServer.close(resolve);
          callbackServer.closeAllConnections();
        });
      await app?.close();
      f.close();
    }
  },
);
