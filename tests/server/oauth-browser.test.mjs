import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";

const databaseUrl = process.env.FRAME_TEST_DATABASE_URL;
test(
  "OAuth browser form preserves origin and follows the permitted ChatGPT callback",
  { skip: !databaseUrl, timeout: 60000 },
  async () => {
    assert.match(new URL(databaseUrl).pathname, /frame_test/);
    const origin = `http://127.0.0.1:${Number(process.env.FRAME_TEST_PORT || 55191)}`;
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-oauth-browser-"));
    const password = "test-password-at-least-14";
    const db = await database(databaseUrl, password);
    await db.pool.query("TRUNCATE engines");
    const { app } = await createApp({
      db,
      data,
      masterKey: "66".repeat(32),
      origin,
      scheduler: false,
    });
    let browser, client;
    try {
      await app.listen({
        host: "127.0.0.1",
        port: Number(new URL(origin).port),
      });
      browser = await launchBrowser();
      const ctx = await browser.newContext();
      const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
      const alternateRedirect =
        "https://chatgpt.com/connector/oauth/browser-fixture";
      const registration = await ctx.request.post(origin + "/oauth/register", {
        data: {
          client_name: "OAuth browser fixture",
          redirect_uris: [redirect, alternateRedirect],
        },
      });
      assert.equal(registration.status(), 201);
      client = (await registration.json()).client_id;
      const verifier = "v".repeat(64);
      const query = new URLSearchParams({
        client_id: client,
        redirect_uri: redirect,
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        resource: origin + "/mcp",
        scope: "frame:workbench",
        state: "browser-fixture",
      });
      const page = await ctx.newPage();
      const policyErrors = [];
      page.on("console", (m) => {
        if (
          m.type() === "error" &&
          /Content Security Policy|form-action/.test(m.text())
        )
          policyErrors.push(m.text());
      });
      // Intercept only the external destination; the real form, cookies, headers and redirects run in Chromium.
      await page.route("https://chatgpt.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<p>ChatGPT callback received</p>",
        }),
      );
      await page.goto(origin + "/oauth/authorize?" + query);
      await page.getByLabel("FRAME 登录密码").fill(password);
      const submitted = page.waitForResponse(
        (r) =>
          r.url() === origin + "/oauth/authorize" &&
          r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "登录并授权" }).click();
      const response = await submitted;
      const submittedOrigin = response.request().headers().origin;
      assert.equal(
        response.status(),
        302,
        `Consent failed: origin=${submittedOrigin}, status=${response.status()}`,
      );
      assert.equal(submittedOrigin, origin);
      await page.waitForURL(redirect + "?**", { timeout: 10000 });
      assert.deepEqual(policyErrors, []);
      const callback = new URL(page.url());
      assert.equal(callback.searchParams.get("state"), query.get("state"));
      assert.equal(callback.searchParams.get("iss"), origin);
      const issuedResponse = await ctx.request.post(origin + "/oauth/token", {
        form: {
          grant_type: "authorization_code",
          code: callback.searchParams.get("code"),
          code_verifier: verifier,
          client_id: client,
          redirect_uri: redirect,
          resource: origin + "/mcp",
        },
      });
      assert.equal(issuedResponse.status(), 200);
      const issued = await issuedResponse.json();
      assert(issued.access_token);
      const tools = await ctx.request.post(origin + "/mcp", {
        headers: {
          Authorization: "Bearer " + issued.access_token,
          Accept: "application/json, text/event-stream",
        },
        data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      assert.equal(tools.status(), 200);
      assert.match(await tools.text(), /frame_works_page/);
      // Denial must follow the same browser redirect and include the issuer, without minting a code.
      query.set("redirect_uri", alternateRedirect);
      await page.goto(origin + "/oauth/authorize?" + query);
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.waitForURL(alternateRedirect + "?**", { timeout: 10000 });
      const denied = new URL(page.url());
      assert.equal(denied.searchParams.get("error"), "access_denied");
      assert.equal(denied.searchParams.get("iss"), origin);
      assert.equal(denied.searchParams.get("code"), null);
      // Existing admin login is usable on the consent form too.
      assert.equal(
        (
          await ctx.request.post(origin + "/api/login", {
            headers: { Origin: origin },
            data: { password },
          })
        ).status(),
        200,
      );
      await page.goto(origin + "/oauth/authorize?" + query);
      assert.equal(await page.getByLabel("FRAME 登录密码").count(), 0);
      await page.getByRole("button", { name: "登录并授权" }).click();
      await page.waitForURL(alternateRedirect + "?**", { timeout: 10000 });
      assert(new URL(page.url()).searchParams.get("code"));
      assert.deepEqual(policyErrors, []);
    } finally {
      await browser?.close();
      if (client) {
        await db.pool.query("DELETE FROM oauth_requests WHERE client=$1;", [
          client,
        ]);
        await db.pool.query("DELETE FROM oauth_codes WHERE client=$1;", [
          client,
        ]);
        await db.pool.query("DELETE FROM oauth_grants WHERE client=$1;", [
          client,
        ]);
        await db.pool.query("DELETE FROM oauth_clients WHERE id=$1;", [client]);
      }
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
