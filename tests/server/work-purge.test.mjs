import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { ArtifactLeases } from "../../server/artifact-leases.mjs";
import { command } from "../../server/process.mjs";
import { hash } from "../../server/security.mjs";

for (const backend of ["sqlite", "postgres"]) {
  const url = process.env.FRAME_TEST_DATABASE_URL;
  test(
    `${backend}: work purge deletes remote branches, retains shared materials and retries partial cleanup`,
    { skip: backend === "postgres" && !url },
    async (t) => {
      if (backend === "postgres")
        assert.match(new URL(url).pathname, /frame_test/);
      const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-purge-"));
      const db =
        backend === "sqlite"
          ? await sqliteDatabase(path.join(data, "frame.sqlite"))
          : await database(url, "test-password-at-least-14");
      if (backend === "postgres")
        await db.pool.query(
          "TRUNCATE repos,connections,github_accounts,auth_flows RESTART IDENTITY CASCADE",
        );
      const { app, actions, repos } = await createApp({
        db,
        data,
        masterKey: "22".repeat(32),
        scheduler: false,
        localMode: backend === "sqlite",
        origin: "http://127.0.0.1:3900",
      });
      const leases = new ArtifactLeases(db);
      const call = (name, args = {}) => actions.call(name, args);
      const git = (root, args) => command("git", args, { cwd: root });
      try {
        const repo = await call("repositories_add", { name: "作品清理测试" });
        const a = await call("works_create", {
          repo: repo.id,
          title: "作品 A",
        });
        const b = await call("works_create", {
          repo: repo.id,
          title: "作品 B",
        });
        const root = path.join(data, "repos", repo.id);
        const remote = path.join(data, "fixture.git");
        await git(data, ["init", "--bare", remote]);
        await git(root, ["remote", "add", "origin", remote]);
        await db.pool.query("UPDATE repos SET url=$2 WHERE id=$1", [
          repo.id,
          "https://github.com/fixture/works.git",
        ]);
        const productionGit = repos.git.bind(repos);
        const fixtureGit = (root, args, auth) =>
          productionGit(
            root,
            auth ? ["-c", "protocol.file.allow=always", ...args] : args,
            auth,
          );
        repos.git = fixtureGit; // Only this fixture allows a local bare Git remote.
        await git(root, ["push", "origin", "main"]);
        await git(root, ["push", "origin", "main:refs/heads/frame/materials"]);
        await call("works_sync", { id: a.id, action: "push" });
        await call("works_sync", { id: b.id, action: "push" });
        const source = path.join(data, "works", a.id, "projects", a.project);
        const legacy = path.join(root, "projects", a.project);
        const metadata = fs.readFileSync(path.join(source, "project.ts"));
        fs.cpSync(source, legacy, { recursive: true });
        const content = Buffer.from("shared fixture material");
        const upload = await call("upload_begin", {
          repo: repo.id,
          name: "shared.txt",
          mime: "text/plain",
          bytes: content.length,
          sha256: hash(content),
          license: "test generated",
        });
        await call("upload_chunk", {
          id: upload.id,
          offset: 0,
          base64: content.toString("base64"),
        });
        const asset = await call("upload_finish", { id: upload.id });
        await call("works_use_asset", { id: a.id, asset: asset.id });
        await call("works_use_asset", { id: b.id, asset: asset.id });
        const chat = randomUUID(),
          task = randomUUID(),
          version = randomUUID(),
          undo = randomUUID();
        await db.pool.query(
          "INSERT INTO chats(id,repo,project,provider,title) VALUES($1,$2,$3,'codex','fixture')",
          [chat, repo.id, a.project],
        );
        await db.pool.query(
          "INSERT INTO tasks(id,repo,project,kind,state,input,chat,finished) VALUES($1,$2,$3,'agent','succeeded',$4,$5,now())",
          [task, repo.id, a.project, {}, chat],
        );
        await db.event(task, "message", { text: "fixture" });
        await db.pool.query(
          "INSERT INTO agent_tokens(hash,task) VALUES($1,$2)",
          ["fixture-token", task],
        );
        await db.pool.query(
          "INSERT INTO work_versions(id,work,name) VALUES($1,$2,'fixture')",
          [version, a.id],
        );
        await db.pool.query(
          "INSERT INTO work_undos(id,work,task,expected_commit,expected_revision,state) VALUES($1,$2,$3,$4,$5,'succeeded')",
          [undo, a.id, task, "a".repeat(40), "b".repeat(64)],
        );
        await db.setting("preview-link:fixture", { task });
        for (const folder of [
          path.join(data, "runs", task),
          path.join(data, "sessions", task),
          path.join(data, "sessions", chat),
          path.join(data, "versions", version),
          path.join(data, "restores", "undo-" + undo),
        ]) {
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(path.join(folder, "fixture.txt"), "fixture");
        }
        await t.test(
          "requires recycle bin, title confirmation and idle readers/tasks",
          async () => {
            await assert.rejects(
              call("works_purge", { id: b.id, confirm: b.title }),
              { statusCode: 409 },
            );
            await call("works_trash", {
              id: a.id,
              deleted: true,
              confirm: a.title,
            });
            await assert.rejects(
              call("works_purge", { id: a.id, confirm: "wrong" }),
              { statusCode: 400 },
            );
            await db.pool.query("UPDATE repos SET branch=$2 WHERE id=$1", [repo.id, a.branch]);
            await assert.rejects(call("works_purge", { id: a.id, confirm: a.title }), /主分支/);
            await db.pool.query("UPDATE repos SET branch='main' WHERE id=$1", [repo.id]);
            const release = await leases.acquire(task);
            await assert.rejects(
              call("works_purge", { id: a.id, confirm: a.title }),
              /正在读取/,
            );
            await release();
            const busy = randomUUID();
            await db.pool.query(
              "INSERT INTO tasks(id,repo,project,kind,input) VALUES($1,$2,$3,'build',$4)",
              [busy, repo.id, a.project, {}],
            );
            await assert.rejects(
              call("works_purge", { id: a.id, confirm: a.title }),
              { statusCode: 409 },
            );
            await db.pool.query("DELETE FROM tasks WHERE id=$1", [busy]);
            await assert.rejects(
              call("works_empty_trash", { repo: repo.id, confirm: "wrong" }),
            );
          },
        );
        await t.test(
          "remote rejection retains recoverable work; local failure resumes after remote deletion",
          async () => {
            repos.git = (root, args, auth) => {
              if (
                args[0] === "push" &&
                args.includes(":refs/heads/" + a.branch)
              )
                throw Error("remote rejected");
              return fixtureGit(root, args, auth);
            };
            await assert.rejects(
              call("works_purge", { id: a.id, confirm: a.title }),
              { statusCode: 502 },
            );
            const headers = {
              origin: "http://127.0.0.1:3900",
              host: "127.0.0.1:3900",
            };
            if (backend === "postgres") {
              const login = await app.inject({
                method: "POST",
                url: "/api/login",
                headers,
                payload: { password: "test-password-at-least-14" },
              });
              assert.equal(login.statusCode, 200);
              headers.cookie = login.headers["set-cookie"].split(";")[0];
            }
            const remoteFailure = await app.inject({
              method: "POST",
              url: "/api/action",
              headers,
              payload: {
                name: "works_purge",
                args: { id: a.id, confirm: a.title },
              },
            });
            assert.equal(remoteFailure.statusCode, 502);
            assert.match(remoteFailure.json().error, /远端作品分支删除失败/);
            assert.doesNotMatch(remoteFailure.json().error, /remote rejected/);
            assert.equal((await actions.works.get(a.id)).deleted, true);
            assert.equal(fs.existsSync(source), true);
            assert.equal(await db.setting("work-purge:" + a.id), undefined);
            repos.git = (root, args, auth) => {
              if (args[0] === "worktree" && args[1] === "remove")
                throw Error("local cleanup interrupted");
              return fixtureGit(root, args, auth);
            };
            await assert.rejects(
              call("works_purge", { id: a.id, confirm: a.title }),
              /interrupted/,
            );
            const partial = await call("works_empty_trash", {
              repo: repo.id,
              confirm: "清空回收站",
            });
            assert.equal(partial.failed.length, 1);
            assert.equal(partial.failed[0].id, a.id);
            assert.doesNotMatch(partial.failed[0].error, /interrupted|frame-purge/);
            assert.equal(
              await git(remote, [
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads/" + a.branch,
              ]),
              "",
            );
            await assert.rejects(
              call("works_trash", { id: a.id, deleted: false }),
              /永久清理/,
            );
            await assert.rejects(leases.acquire(task), { statusCode: 410 });
            repos.git = fixtureGit;
            await call("works_purge", { id: a.id, confirm: a.title });
            await assert.rejects(actions.works.get(a.id), { statusCode: 404 });
            for (const [table, column, value] of [
              ["tasks", "id", task],
              ["chats", "id", chat],
              ["work_versions", "work", a.id],
              ["work_undos", "work", a.id],
              ["events", "task", task],
              ["agent_tokens", "task", task],
            ])
              assert.equal(
                (
                  await db.one(
                    `SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`,
                    [value],
                  )
                ).n,
                0,
              );
            assert.equal(await db.setting("preview-link:fixture"), undefined);
            assert.equal(fs.existsSync(path.join(data, "works", a.id)), false);
            assert.equal(fs.existsSync(legacy), false);
            assert.equal(fs.existsSync(path.join(data, "runs", task)), false);
            assert.equal(
              fs.existsSync(path.join(data, "versions", version)),
              false,
            );
            assert.equal(
              fs.existsSync(path.join(data, "sessions", chat)),
              false,
            );
            assert.equal(
              fs.existsSync(path.join(data, "restores", "undo-" + undo)),
              false,
            );
            const refs = await git(remote, [
              "for-each-ref",
              "--format=%(refname)",
            ]);
            assert.match(refs, /refs\/heads\/main/);
            assert.match(refs, /refs\/heads\/frame\/materials/);
            assert.ok(refs.includes("refs/heads/" + b.branch));
            assert.equal(
              (
                await db.one("SELECT deleted FROM assets WHERE id=$1", [
                  asset.id,
                ])
              ).deleted,
              false,
            );
            assert.equal(
              (
                await db.one(
                  "SELECT count(*)::int AS n FROM asset_refs WHERE asset=$1",
                  [asset.id],
                )
              ).n,
              1,
            );
            assert.equal(
              fs.existsSync(path.join(data, "blobs", asset.sha)),
              true,
            );
            fs.mkdirSync(legacy, { recursive: true });
            fs.writeFileSync(path.join(legacy, "project.ts"), metadata);
            await repos.fetchBranches(repo.id);
            await actions.works.discover(repo.id);
            const listing = repos.list.bind(repos);
            try {
              // Simulate a filesystem listing captured before the purge completed.
              repos.list = async () => [{ ...await repos.get(repo.id), projects: [{ id: a.project, title: a.title }] }];
              await actions.works.discover(repo.id);
            } finally { repos.list = listing; }
            assert.equal(
              await db.one(
                "SELECT id FROM works WHERE repo=$1 AND project=$2",
                [repo.id, a.project],
              ),
              undefined,
            );
          },
        );
        await t.test(
          "clears every page in scope, reports failures and handles unpushed/absent branches",
          async () => {
            const c = await call("works_create", {
              repo: repo.id,
              title: "未同步作品",
            });
            await call("works_trash", {
              id: c.id,
              deleted: true,
              confirm: c.title,
            });
            const local = await call("repositories_add", {
              name: "跨页回收站",
            });
            let blocked;
            for (let i = 0; i < 31; i++) {
              const id = randomUUID(),
                project = "fixture-" + i;
              await db.pool.query(
                "INSERT INTO works(id,repo,project,title,branch,deleted) VALUES($1,$2,$3,$4,$5,true)",
                [id, local.id, project, "回收作品 " + i, "works/" + project],
              );
              if (i === 30) blocked = { id, project };
            }
            const busy = randomUUID();
            await db.pool.query(
              "INSERT INTO tasks(id,repo,project,kind,input) VALUES($1,$2,$3,'build',$4)",
              [busy, local.id, blocked.project, {}],
            );
            const page = await call("works_page", {
              repo: local.id,
              deleted: true,
              limit: 30,
            });
            assert.equal(page.items.length, 30);
            assert.equal(page.total, 31);
            const result = await call("works_empty_trash", {
              repo: local.id,
              confirm: "清空回收站",
            });
            assert.equal(result.total, 31);
            assert.equal(result.purged.length, 30);
            assert.equal(result.failed[0].id, blocked.id);
            assert.equal((await actions.works.get(c.id)).deleted, true);
            await db.pool.query("DELETE FROM tasks WHERE id=$1", [busy]);
            assert.equal(
              (
                await call("works_empty_trash", {
                  repo: local.id,
                  confirm: "清空回收站",
                })
              ).purged.length,
              1,
            );
            assert.equal(
              (await call("works_empty_trash", { confirm: "清空回收站" }))
                .purged.length,
              1,
            );
            assert.equal(
              (await call("works_empty_trash", { confirm: "清空回收站" }))
                .total,
              0,
            );
            assert.equal((await actions.works.get(b.id)).deleted, false);
          },
        );
      } finally {
        await leases.close();
        await app.close();
        fs.rmSync(data, { recursive: true, force: true });
      }
    },
  );
}
