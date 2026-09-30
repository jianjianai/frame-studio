import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";

const url = process.env.FRAME_TEST_DATABASE_URL;
test(
  "OAuth discovery, consent, PKCE, audience, replay, rotation, revocation; authenticated WebSocket push and engine removal",
  { skip: !url, timeout: 60000 },
  async () => {
    assert.match(new URL(url).pathname, /frame_test/);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-realtime-"));
    const db = await database(url, "test-password-at-least-14"),
      origin = "http://frame.test";
    await db.pool.query("TRUNCATE engines");
    const { app, actions } = await createApp({
      db,
      data,
      masterKey: "55".repeat(32),
      origin,
      scheduler: false,
    });
    let ws;
    try {
      const post = (endpoint, payload, cookie) =>
        app.inject({
          method: "POST",
          url: endpoint,
          headers: { origin, ...(cookie ? { cookie } : {}) },
          payload,
        });
      const challenge = await app.inject({ url: "/mcp" });
      assert.equal(challenge.statusCode, 401);
      assert.match(
        challenge.headers["www-authenticate"],
        /oauth-protected-resource\/mcp/,
      );
      assert.equal(
        (
          await app.inject({ url: "/.well-known/oauth-authorization-server" })
        ).json().code_challenge_methods_supported[0],
        "S256",
      );
      assert.equal(
        (
          await post("/oauth/register", {
            redirect_uris: [
              "https://chatgpt.com.evil.test/connector_platform_oauth_redirect",
            ],
          })
        ).statusCode,
        400,
      );
      const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
      const registration = await post("/oauth/register", {
        client_name: "ChatGPT fixture",
        redirect_uris: [redirect],
      });
      assert.equal(registration.statusCode, 201);
      const client = registration.json().client_id,
        verifier = "v".repeat(50),
        resource = origin + "/mcp";
      const query = {
        client_id: client,
        redirect_uri: redirect,
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        state: "fixture-state",
        scope: "frame:workbench",
        resource,
      };
      const consent = await app.inject({
        url: "/oauth/authorize?" + new URLSearchParams(query),
      });
      assert.equal(consent.statusCode, 200);
      assert.match(consent.body, /登录并授权/);
      const cookie = consent.headers["set-cookie"].split(";")[0];
      const form = {
        request: consent.body.match(/name="request" value="([^"]+)"/)[1],
        csrf: consent.body.match(/name="csrf" value="([^"]+)"/)[1],
        password: "test-password-at-least-14",
        decision: "allow",
      };
      assert.equal(
        (await post("/oauth/authorize", { ...form, csrf: "bad" }, cookie))
          .statusCode,
        403,
      );
      for (const invalidOrigin of ["null", "https://evil.test"]) {
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/oauth/authorize",
              headers: { origin: invalidOrigin, cookie },
              payload: form,
            })
          ).statusCode,
          403,
        );
      }
      const authorized = await post("/oauth/authorize", form, cookie);
      assert.equal(authorized.statusCode, 302);
      const callback = new URL(authorized.headers.location);
      assert.equal(callback.searchParams.get("state"), query.state);
      assert.equal(callback.searchParams.get("iss"), origin);
      const tokenArgs = {
        grant_type: "authorization_code",
        code: callback.searchParams.get("code"),
        code_verifier: verifier,
        client_id: client,
        redirect_uri: redirect,
        resource,
      };
      assert.equal(
        (
          await post("/oauth/token", {
            ...tokenArgs,
            code_verifier: "x".repeat(50),
          })
        ).json().error,
        "invalid_grant",
      );
      assert.equal(
        (await post("/oauth/token", { ...tokenArgs, resource: origin })).json()
          .error,
        "invalid_target",
      );
      const issued = (await post("/oauth/token", tokenArgs)).json();
      assert(issued.access_token);
      assert(issued.refresh_token);
      const grant = (await actions.call("oauth_grants")).find(
        (row) => row.name === "ChatGPT fixture",
      );
      assert(grant && !grant.revoked, "Active OAuth connection is listed");
      assert.equal(
        (await post("/oauth/token", tokenArgs)).json().error,
        "invalid_grant",
      );
      assert.equal(
        (
          await app.inject({
            url: "/api/me",
            headers: { authorization: "Bearer " + issued.access_token },
          })
        ).statusCode,
        401,
        "MCP OAuth must not grant admin API access",
      );
      const mcp = async (access) =>
        app.inject({
          method: "POST",
          url: "/mcp",
          headers: {
            authorization: "Bearer " + access,
            accept: "application/json, text/event-stream",
          },
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "fixture", version: "1" },
            },
          },
        });
      assert.equal((await mcp(issued.access_token)).statusCode, 200);
      const rotated = (
        await post("/oauth/token", {
          grant_type: "refresh_token",
          client_id: client,
          refresh_token: issued.refresh_token,
          resource,
        })
      ).json();
      assert(
        rotated.access_token && rotated.access_token !== issued.access_token,
      );
      assert.equal((await mcp(issued.access_token)).statusCode, 401);
      assert.equal((await mcp(rotated.access_token)).statusCode, 200);
      assert.equal(
        (
          await post("/oauth/token", {
            grant_type: "refresh_token",
            client_id: client,
            refresh_token: issued.refresh_token,
            resource,
          })
        ).json().error,
        "invalid_grant",
      );
      assert.equal(
        (await mcp(rotated.access_token)).statusCode,
        401,
        "refresh reuse revokes token family",
      );
      assert(
        !(await actions.call("oauth_grants")).some(
          (row) => row.id === grant.id,
        ),
        "Revoked OAuth connection is omitted from the connection list",
      );
      await actions.call("oauth_revoke", { id: grant.id });
      assert(
        (
          await db.one("SELECT revoked FROM oauth_grants WHERE id=$1", [
            grant.id,
          ])
        ).revoked,
        "Revocation remains recorded for token-family protection",
      );
      assert(
        !JSON.stringify(await actions.call("oauth_grants")).includes(
          issued.access_token,
        ),
      );

      const login = await post("/api/login", {
        password: "test-password-at-least-14",
      });
      const session = login.headers["set-cookie"].split(";")[0];
      await app.listen({ host: "127.0.0.1", port: 0 });
      const endpoint = `ws://127.0.0.1:${app.server.address().port}/api/ws`;
      const wrong = new WebSocket(endpoint, {
        headers: { origin: "https://evil.test", cookie: session },
      });
      await once(wrong, "error");
      ws = new WebSocket(endpoint, { headers: { origin, cookie: session } });
      await once(ws, "open");
      const queue = [];
      ws.on("message", (data) => queue.push(JSON.parse(data.toString())));
      const wait = async (predicate) => {
        const end = Date.now() + 6000;
        while (Date.now() < end) {
          const row = queue.find(predicate);
          if (row) return row;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error("Missing WebSocket event " + JSON.stringify(queue));
      };
      ws.send(
        JSON.stringify({
          type: "subscribe",
          id: "background",
          name: "works_background",
        }),
      );
      await wait((v) => v.id === "background");
      const flow = randomUUID();
      await db.pool.query(
        "INSERT INTO auth_flows(id,kind,expires) VALUES($1,'github',now()+interval '15 minutes')",
        [flow],
      );
      ws.send(
        JSON.stringify({
          type: "subscribe",
          id: "login",
          name: "auth_state",
          args: { id: flow },
        }),
      );
      await wait((v) => v.id === "login" && v.result?.state === "pending");
      await db.pool.query(
        "UPDATE auth_flows SET state='succeeded' WHERE id=$1",
        [flow],
      );
      await wait((v) => v.id === "login" && v.result?.state === "succeeded");
      const saved = await actions.call("engines_save", {
        name: "Delete fixture",
        url: "https://example.test/v1",
        model: "fixture",
        voice: "fixture",
        enabled: true,
      });
      ws.send(
        JSON.stringify({
          type: "call",
          id: "remove",
          name: "engines_delete",
          args: { id: saved.id },
        }),
      );
      assert.equal(
        (await wait((v) => v.id === "remove")).result.deleted,
        saved.id,
      );
      assert(
        !(await actions.call("engines_list")).some((e) => e.id === saved.id),
      );
      const closed = once(ws, "close");
      await post("/api/logout", {}, session);
      ws.send(
        JSON.stringify({ type: "call", id: "expired", name: "engines_list" }),
      );
      assert.equal((await closed)[0], 4401);
    } finally {
      ws?.terminate();
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
