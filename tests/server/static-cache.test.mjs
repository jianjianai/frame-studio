import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { createApp } from "../../server/app.mjs";
import { hash } from "../../server/security.mjs";

test(
  "content-hashed public bundles cache immutably while HTML, API and private previews do not",
  { timeout: 30000 },
  async () => {
    const web = path.resolve(import.meta.dirname, "../../studio-dist");
    assert(
      fs.existsSync(path.join(web, "index.html")),
      "build the current studio before testing static headers",
    );
    const assets = fs
      .readdirSync(path.join(web, "assets"))
      .filter((name) => /-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(name));
    assert(
      assets.some((name) => name.endsWith(".js")),
      "the current build contains hashed JavaScript",
    );
    assert(
      assets.some((name) => name.endsWith(".css")),
      "the current build contains hashed CSS",
    );
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-static-cache-"));
    const db = await sqliteDatabase(path.join(data, "frame.sqlite"));
    const origin = "http://127.0.0.1:57181";
    let app;
    try {
      ({ app } = await createApp({
        db,
        data,
        origin,
        masterKey: "11".repeat(32),
        scheduler: false,
        localMode: true,
      }));
      const headers = { host: new URL(origin).host };
      for (const name of [
        assets.find((name) => name.endsWith(".js")),
        assets.find((name) => name.endsWith(".css")),
      ]) {
        const response = await app.inject({ url: "/assets/" + name, headers });
        assert.equal(response.statusCode, 200);
        assert.match(response.headers["cache-control"], /public/);
        assert.match(response.headers["cache-control"], /max-age=31536000/);
        assert.match(response.headers["cache-control"], /immutable/);
        assert(
          response.headers.etag,
          "content-hashed resources retain conditional-request support",
        );
        const unchanged = await app.inject({
          url: "/assets/" + name,
          headers: { ...headers, "if-none-match": response.headers.etag },
        });
        assert.equal(unchanged.statusCode, 304);
        assert.match(unchanged.headers["cache-control"], /immutable/);
      }
      for (const url of [
        "/",
        "/index.html",
        "/favicon.svg",
        "/assets/missing-abcdefgh.js",
      ]) {
        const response = await app.inject({ url, headers });
        assert.equal(response.statusCode, 200, url);
        assert.doesNotMatch(
          response.headers["cache-control"],
          /immutable|31536000/,
          url,
        );
      }
      const api = await app.inject({ url: "/api/me", headers });
      assert.equal(api.statusCode, 200);
      assert.equal(api.headers["cache-control"], "no-store");
      const task = randomUUID(),
        token = randomUUID(),
        base = "preview";
      const privateDir = path.join(data, "runs", task, base, "assets");
      fs.mkdirSync(privateDir, { recursive: true });
      fs.writeFileSync(
        path.join(privateDir, "index-abcdefgh.js"),
        "console.log('private preview')",
      );
      await db.setting("preview:" + hash(token), {
        task,
        base,
        expires: Date.now() + 60000,
      });
      const preview = await app.inject({
        url: "/preview/" + token + "/assets/index-abcdefgh.js",
        headers,
      });
      assert.equal(preview.statusCode, 200);
      assert.match(preview.headers["cache-control"], /private/);
      assert.doesNotMatch(
        preview.headers["cache-control"],
        /public|immutable|31536000/,
      );
    } finally {
      if (app) await app.close();
      else await db.pool.end();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
