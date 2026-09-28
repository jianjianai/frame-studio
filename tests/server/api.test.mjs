import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { hash } from "../../server/security.mjs";
const url = process.env.FRAME_TEST_DATABASE_URL;
test(
  "platform authentication, project conflicts, persistent tasks, assets and MCP",
  { skip: !url },
  async () => {
    assert.match(
      new URL(url).pathname,
      /frame_test/,
      "Integration tests require a dedicated frame_test database",
    );
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-api-")),
      db = await database(url, "test-password-at-least-14");
    await db.pool.query(
      "TRUNCATE events,tasks,chats,asset_refs,assets,repos,tokens,sessions,engines RESTART IDENTITY CASCADE",
    );
    const { app, actions, tasks } = await createApp({
      db,
      data,
      masterKey: "11".repeat(32),
      origin: "http://frame.test",
      scheduler: false,
    });
    try {
      assert.equal((await app.inject({ url: "/api/me" })).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/login",
            payload: { password: "test-password-at-least-14" },
            headers: { origin: "http://evil.test" },
          })
        ).statusCode,
        403,
      );
      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { password: "test-password-at-least-14" },
        headers: { origin: "http://frame.test" },
      });
      assert.equal(login.statusCode, 200, login.body);
      const cookie = login.headers["set-cookie"].split(";")[0];
      assert.match(login.headers["set-cookie"], /HttpOnly/);
      const call = async (name, args = {}) => {
        const r = await app.inject({
          method: "POST",
          url: "/api/action",
          headers: { cookie, origin: "http://frame.test" },
          payload: { name, args },
        });
        assert.equal(r.statusCode, 200, r.body);
        return r.json();
      };
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/action",
            headers: { cookie, origin: "http://evil.test" },
            payload: { name: "repositories_list" },
          })
        ).statusCode,
        403,
      );
      const repo = await call("repositories_add", { name: "Integration" });
      assert(repo.id);
      const dir = path.join(data, "repos", repo.id, "projects", "hello");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        dir + "/project.ts",
        "export default {id:'hello',title:'Hello',duration:12,fps:30,renderer:'canvas',load:()=>import('./scene')};",
      );
      fs.writeFileSync(dir + "/scene.ts", "export const value = 1;");
      const read = await call("project_read", {
        repo: repo.id,
        project: "hello",
        path: "scene.ts",
      });
      assert.equal(read.sha256, hash(read.content));
      await call("project_write", {
        repo: repo.id,
        project: "hello",
        path: "scene.ts",
        expectedSha256: read.sha256,
        content: "export const value = 2;",
      });
      const conflict = await app.inject({
        method: "POST",
        url: "/api/action",
        headers: { cookie, origin: "http://frame.test" },
        payload: {
          name: "project_write",
          args: {
            repo: repo.id,
            project: "hello",
            path: "scene.ts",
            expectedSha256: read.sha256,
            content: "stale",
          },
        },
      });
      assert.equal(conflict.statusCode, 409);
      const body = Buffer.from("test material"),
        upload = await call("upload_begin", {
          name: "test.txt",
          bytes: body.length,
          sha256: hash(body),
          license: "Original",
        });
      const chunk = {
        id: upload.id,
        offset: 0,
        base64: body.toString("base64"),
      };
      assert.equal((await call("upload_chunk", chunk)).offset, body.length);
      assert.equal((await call("upload_chunk", chunk)).offset, body.length);
      const asset = await call("upload_finish", { id: upload.id });
      assert.equal(
        (await call("upload_finish", { id: upload.id })).id,
        asset.id,
      );
      assert.equal((await call("assets_list", { unused: true })).length, 1);
      const ref = await call("assets_attach", {
        id: asset.id,
        repo: repo.id,
        project: "hello",
      });
      assert.equal(
        fs.readFileSync(dir + "/" + ref.path, "utf8"),
        "test material",
      );
      assert.equal((await call("assets_list", { unused: true })).length, 0);
      await assert.rejects(
        actions.call("assets_trash", { id: asset.id, deleted: true }),
        /attached/,
      );
      const task = await call("task_create", {
        repo: repo.id,
        project: "hello",
        kind: "frame",
      });
      assert.equal((await tasks.get(task.id)).state, "queued");
      await assert.rejects(
        actions.call("project_write", {
          repo: repo.id,
          project: "hello",
          path: "scene.ts",
          expectedSha256: hash("export const value = 2;"),
          content: "busy",
        }),
        /active task/,
      );
      await call("task_cancel", { id: task.id });
      assert.equal((await tasks.get(task.id)).state, "cancelled");
      await assert.rejects(
        actions.call("assets_purge", { id: asset.id }),
        /recycled/,
      );
      await call("assets_detach", {
        id: asset.id,
        repo: repo.id,
        project: "hello",
      });
      assert.equal(
        (await call("assets_list", { unused: true })).length,
        0,
        "retained project bytes still count as a reference",
      );
      await assert.rejects(
        actions.call("assets_trash", { id: asset.id, deleted: true }),
        /attached/,
      );
      fs.unlinkSync(dir + "/" + ref.path);
      await call("assets_trash", { id: asset.id, deleted: true });
      await call("assets_purge", { id: asset.id });
      assert.equal(fs.existsSync(path.join(data, "blobs", asset.sha)), false);
      assert.equal(fs.existsSync(dir + "/" + ref.path), false);
      const work = await call("works_create", {
        title: "独立作品",
        duration: 2,
      });
      assert.notEqual(
        work.repo,
        repo.id,
        "default storage is a dedicated content repository",
      );
      assert.equal(
        fs.existsSync(path.join(data, "repos", work.repo, "package.json")),
        false,
      );
      const source = await call("works_read", {
        id: work.id,
        path: "scene.ts",
      });
      const version = await call("works_checkpoint", {
        id: work.id,
        name: "初稿",
      });
      await call("works_write", {
        id: work.id,
        path: "scene.ts",
        expectedSha256: source.sha256,
        content: source.content + "\n// second version\n",
      });
      await call("works_restore", { id: work.id, version: version.id });
      assert.equal(
        (await call("works_read", { id: work.id, path: "scene.ts" })).content,
        source.content,
      );
      assert.equal(
        (await call("works_versions", { id: work.id })).length,
        2,
        "restore saves current version",
      );
      await call("works_update", {
        id: work.id,
        title: "改名的作品",
        category: "科普",
        status: "review",
      });
      const duplicate = await call("works_duplicate", {
        id: work.id,
        title: "作品副本",
      });
      assert.notEqual(duplicate.id, work.id);
      assert.equal(duplicate.category, "科普");
      assert.match(
        (await call("works_read", { id: duplicate.id, path: "project.ts" }))
          .content,
        new RegExp(duplicate.project),
      );
      const workTask = await call("works_task", { id: work.id, kind: "build" });
      await assert.rejects(
        actions.call("works_trash", { id: work.id, deleted: true }),
        /active task/,
      );
      await call("task_cancel", { id: workTask.id });
      await call("works_trash", { id: work.id, deleted: true });
      assert(
        (await call("works_list", { deleted: true })).some(
          (w) => w.id === work.id,
        ),
      );
      await assert.rejects(
        actions.call("works_write", {
          id: work.id,
          path: "scene.ts",
          expectedSha256: source.sha256,
          content: "bad",
        }),
        /Restore/,
      );
      await call("works_trash", { id: work.id, deleted: false });
      assert(
        (await call("works_list", { search: "改名" })).some(
          (w) => w.id === work.id,
        ),
      );
      const tok = await call("tokens_create", { name: "test" });
      const headers = {
        authorization: "Bearer " + tok.token,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      };
      const mcp = await app.inject({
        method: "POST",
        url: "/mcp",
        headers,
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        },
      });
      assert.equal(mcp.statusCode, 200, mcp.body);
      assert.match(mcp.body, /frame-studio/);
      await call("tokens_revoke", { id: tok.id });
      assert.equal(
        (await app.inject({ url: "/api/me", headers })).statusCode,
        401,
      );
    } finally {
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
