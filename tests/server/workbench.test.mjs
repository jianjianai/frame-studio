import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { command } from "../../server/process.mjs";
import { hash } from "../../server/security.mjs";
const url = process.env.FRAME_TEST_DATABASE_URL;
test(
  "work branches isolate history, active tasks, materials and durable chat retries",
  { skip: !url },
  async () => {
    assert.match(new URL(url).pathname, /frame_test/);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-workbench-")),
      db = await database(url, "test-password-at-least-14");
    await db.pool.query(
      "TRUNCATE repos,connections,github_accounts,auth_flows RESTART IDENTITY CASCADE",
    );
    const { app, actions, tasks, repos } = await createApp({
      db,
      data,
      masterKey: "22".repeat(32),
      scheduler: false,
    });
    const call = (name, args = {}) => actions.call(name, args);
    const git = (root, args) => command("git", args, { cwd: root });
    try {
      const repo = await call("repositories_add", { name: "分支测试" });
      const a = await call("works_create", { repo: repo.id, title: "作品 A" }),
        b = await call("works_create", { repo: repo.id, title: "作品 B" });
      assert.notEqual(a.branch, b.branch);
      const rootA = path.join(data, "works", a.id),
        rootB = path.join(data, "works", b.id);
      assert.deepEqual(
        fs
          .readdirSync(path.join(rootA, "projects"))
          .filter((x) => !x.startsWith(".")),
        [a.project],
      );
      const remote = path.join(data, "fixture-remote.git");
      await git(data, ["init", "--bare", remote]);
      await git(path.join(data, "repos", repo.id), [
        "remote",
        "add",
        "origin",
        remote,
      ]);
      await db.pool.query("UPDATE repos SET url=$2 WHERE id=$1", [
        repo.id,
        "https://github.com/fixture/works.git",
      ]);
      // This fixture alone substitutes a local remote; production still forbids file:// remotes.
      const productionGit = repos.git.bind(repos);
      repos.git = (root, args, auth) =>
        productionGit(
          root,
          auth ? ["-c", "protocol.file.allow=always", ...args] : args,
          auth,
        );
      await call("works_sync", { id: a.id, action: "push" });
      await call("works_sync", { id: b.id, action: "push" });
      assert.notEqual(
        await git(rootA, ["rev-parse", "HEAD"]),
        await git(rootB, ["rev-parse", "HEAD"]),
      );
      assert.equal(await git(rootA, ["rev-list", "--count", "HEAD"]), "1");
      assert.equal(
        await git(rootB, ["log", "--format=%s"]),
        "创建作品 · 作品 B",
      );
      const queued = await call("works_task", { id: a.id, kind: "build" });
      await assert.rejects(
        call("works_update", { id: a.id, title: "busy" }),
        { statusCode: 409 },
      );
      await call("works_update", {
        id: b.id,
        title: "B independently editable",
      });
      await call("works_sync", {
        id: b.id,
        action: "commit",
        message: "B rename",
      });
      assert.equal(
        await git(rootA, ["log", "--format=%s"]),
        "创建作品 · 作品 A",
      );
      await call("works_sync", { id: b.id, action: "push" });
      const remoteB = path.join(data, "remote-editor");
      await git(data, ["clone", "--branch", b.branch, remote, remoteB]);
      const info = path.join(
        remoteB,
        "projects",
        b.project,
        "production/work.json",
      );
      const changed = JSON.parse(fs.readFileSync(info, "utf8"));
      changed.description = "从另一台电脑修改";
      fs.writeFileSync(info, JSON.stringify(changed));
      await git(remoteB, ["add", "--", "projects"]);
      await git(remoteB, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@local",
        "commit",
        "-m",
        "Remote B update",
      ]);
      await git(remoteB, ["push", "origin", b.branch]);
      assert.equal(
        (await call("works_sync_status", { id: b.id, fetch: true })).behind,
        1,
      );
      assert.equal((await call("works_sync_status", { id: a.id })).behind, 0);
      await call("works_sync", { id: b.id, action: "pull" });
      assert.equal(
        (await actions.works.get(b.id)).description,
        changed.description,
      );
      assert.equal(
        (await tasks.get(queued.id)).state,
        "queued",
        "pulling B must not stop A",
      );
      await call("task_cancel", { id: queued.id });
      await assert.rejects(
        call("works_trash", { id: a.id, deleted: true, confirm: "wrong" }),
        /名称/,
      );
      const blob = Buffer.from("a shared reusable material"),
        begin = await call("upload_begin", {
          repo: repo.id,
          name: "sample.txt",
          bytes: blob.length,
          sha256: hash(blob),
          license: "fixture generated",
          mime: "text/plain",
        });
      await call("upload_chunk", {
        id: begin.id,
        offset: 0,
        base64: blob.toString("base64"),
      });
      const asset = await call("upload_finish", { id: begin.id });
      await call("works_use_asset", { id: a.id, asset: asset.id });
      assert(
        fs.existsSync(
          path.join(
            data,
            "libraries",
            repo.id,
            "materials",
            asset.sha,
            asset.name,
          ),
        ),
      );
      assert.equal(
        (await call("works_assets", { id: a.id })).some(
          (x) => x.id === asset.id,
        ),
        true,
      );
      assert.equal(
        (await call("works_assets", { id: b.id })).some(
          (x) => x.id === asset.id,
        ),
        false,
      );
      await assert.rejects(
        call("assets_trash", { id: asset.id, deleted: true }),
        /attached/,
      );
      await call("assets_update", {
        id: asset.id,
        name: "renamed.txt",
        tags: "tag",
      });
      assert(
        fs.existsSync(
          path.join(
            data,
            "libraries",
            repo.id,
            "materials",
            asset.sha,
            "renamed.txt",
          ),
        ),
      );
      const connection = await call("connections_save", {
        name: "fixture",
        tool: "codex",
        mode: "api",
        apiKey: "test-secret-should-not-leak",
        model: "fixture-model",
      });
      assert(
        !JSON.stringify(await call("connections_list")).includes("test-secret"),
      );
      const chat = await call("works_chat_create", {
          id: a.id,
          connection: connection.id,
          title: "Creation",
        }),
        requestKey = randomUUID();
      const args = {
        id: a.id,
        chat: chat.id,
        prompt: "make a film",
        requestKey,
        context: { time: 1 },
      };
      const first = await call("works_chat_send", args),
        retry = await call("works_chat_send", args);
      assert.equal(first.id, retry.id);
      assert.equal((await call("works_background")).length, 1);
      assert.equal((await call("works_stop", { id: a.id })).stopped, 1);
      await assert.rejects(
        call("password_change", { oldPassword: "a", newPassword: "b" }),
        /Unknown/,
      );
      const eventDir = path.join(data, "runs", first.id);
      fs.mkdirSync(eventDir, { recursive: true });
      fs.writeFileSync(
        path.join(eventDir, "events.ndjson"),
        JSON.stringify({ type: "message", id: "one", text: "你好" }) + "\n",
      );
      const task = await tasks.get(first.id);
      await tasks.collectEvents(task);
      await tasks.collectEvents(task);
      assert.equal(
        (
          await db.one(
            "SELECT count(*)::int AS n FROM events WHERE task=$1 AND kind='message'",
            [first.id],
          )
        ).n,
        1,
      );
    } finally {
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
