import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { Retention } from "../../server/retention.mjs";
import { GitHub } from "../../server/github.mjs";
import { vault } from "../../server/security.mjs";
const url = process.env.FRAME_TEST_DATABASE_URL;

test(
  "material catalog identities, bounded cleanup, multi-account reconnection and release source revisions",
  { skip: !url },
  async (t) => {
    assert.match(new URL(url).pathname, /frame_test/);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-lifecycle-")),
      db = await database(url, "test-password-at-least-14");
    await db.pool.query(
      "TRUNCATE repos,connections,github_accounts,auth_flows,assets RESTART IDENTITY CASCADE",
    );
    const key = "55".repeat(32),
      platform = await createApp({
        db,
        data,
        masterKey: key,
        scheduler: false,
      });
    const { actions, assets, repos } = platform,
      call = (name, args = {}) => actions.call(name, args),
      originalFetch = globalThis.fetch;
    try {
      const repo = await call("repositories_add", { name: "Lifecycle" }),
        work = await call("works_create", {
          repo: repo.id,
          title: "Source revision",
        });
      const file = path.join(data, "test.bin");
      fs.writeFileSync(file, "same content, separate identities");
      const legacy = await assets.register(file, {
        name: "legacy.bin",
        license: "fixture legacy upload",
      });
      await db.pool.query(
        "DELETE FROM settings WHERE key='asset-repositories-v4'",
      );
      await assets.migrate();
      assert(
        await db.one(
          "SELECT asset FROM asset_repos WHERE asset=$1 AND repo=$2",
          [legacy.id, repo.id],
        ),
        "unassigned legacy uploads survive migration with the same identity",
      );
      const a = await assets.register(file, {
          repo: repo.id,
          name: "a.bin",
          license: "fixture",
        }),
        b = await assets.register(file, {
          repo: repo.id,
          name: "b.bin",
          license: "fixture",
        });
      const library = (await repos.library(repo.id)).root,
        catalog = path.join(library, "materials/index.json");
      const rows = JSON.parse(fs.readFileSync(catalog));
      rows.find((x) => x.id === a.id).name = "renamed.bin";
      fs.renameSync(
        path.join(library, "materials", a.sha, "a.bin"),
        path.join(library, "materials", a.sha, "renamed.bin"),
      );
      fs.writeFileSync(catalog, JSON.stringify(rows));
      await assets.indexRepository(repo.id);
      assert.equal((await assets.get(a.id)).name, "renamed.bin");
      assert.equal((await assets.get(b.id)).name, "b.bin");
      fs.writeFileSync(
        catalog,
        JSON.stringify(rows.filter((x) => x.id !== b.id)),
      );
      await assets.indexRepository(repo.id);
      assert(
        !(await db.one(
          "SELECT asset FROM asset_repos WHERE asset=$1 AND repo=$2",
          [b.id, repo.id],
        )),
      );

      const retention = new Retention(db, data),
        exportId = randomUUID(),
        relative = `projects/${work.project}/exports/video.mp4`,
        run = path.join(data, "runs", exportId);
      fs.mkdirSync(path.dirname(path.join(run, relative)), { recursive: true });
      fs.writeFileSync(path.join(run, relative), "fixture video bytes");
      const commit = (
        await repos.git(
          (await repos.project(repo.id, work.project)).repo.root,
          ["rev-parse", "HEAD"],
        )
      ).trim();
      await db.pool.query(
        "INSERT INTO tasks(id,repo,project,kind,state,input,result,source_commit,finished,expires) VALUES($1,$2,$3,'render','succeeded','{}',$4,$5,now(),now()-interval '1 day')",
        [
          exportId,
          repo.id,
          work.project,
          { artifacts: [{ path: relative }] },
          commit,
        ],
      );
      // Many expired current previews must not starve export cleanup's bounded page.
      for (let i = 0; i < 35; i++)
        await db.pool.query(
          "INSERT INTO tasks(id,repo,project,kind,state,input,result,finished,expires) VALUES($1,$2,$3,'build','succeeded','{}','{}',now(),now()-interval '2 days')",
          [randomUUID(), repo.id, "retained-" + i],
        );
      const releaseLease = retention.lease(exportId);
      await retention.tick();
      assert(fs.existsSync(run));

      let expired = false,
        releaseBody,
        uploaded = 0;
      globalThis.fetch = async (address, options = {}) => {
        const uri = new URL(address),
          token = options.headers?.Authorization;
        const json = (body, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        if (uri.hostname === "api.github.com") {
          if (expired) return json({ message: "expired" }, 401);
          if (uri.pathname === "/user")
            return json({
              login: token.endsWith("account-b") ? "account-b" : "account-a",
            });
          if (uri.pathname === "/user/repos")
            return json([
              {
                full_name: "account-a/works",
                clone_url: "https://github.com/account-a/works.git",
                default_branch: "main",
                private: true,
              },
            ]);
          if (uri.pathname.includes("/releases/tags/")) return json({}, 404);
          if (uri.pathname.endsWith("/releases")) {
            releaseBody = JSON.parse(options.body);
            return json({
              html_url:
                "https://github.com/account-a/works/releases/tag/fixture",
              upload_url:
                "https://uploads.github.com/repos/account-a/works/releases/1/assets{?name,label}",
              assets: [],
            });
          }
        }
        if (uri.hostname === "uploads.github.com") {
          for await (const chunk of options.body) uploaded += chunk.length;
          return json({ id: 1 });
        }
        if (uri.hostname === "model.fixture")
          return json({
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "READY" }],
              },
            ],
          });
        throw new Error("Unexpected external request: " + uri.hostname);
      };
      const github = new GitHub(db, vault(key), repos, data),
        one = await github.connect("fixture-account-a"),
        two = await github.connect("fixture-account-b");
      assert.notEqual(one.id, two.id);
      await assert.rejects(
        github.connect("fixture-account-b", one.id),
        /原账号/,
      );
      expired = true;
      await assert.rejects(github.remoteRepos(one.id), /已过期/);
      assert.equal(
        (await github.list()).find((x) => x.id === one.id).state,
        "expired",
      );
      expired = false;
      assert.equal(
        (await github.connect("fixture-account-a", one.id)).id,
        one.id,
      );
      assert(!JSON.stringify(await github.list()).includes("fixture-account"));
      const connection = await call("connections_save", {
        name: "Model test",
        tool: "codex",
        mode: "api",
        model: "fixture",
        apiKey: "fixture-model-key",
        baseUrl: "https://model.fixture/v1",
      });
      assert((await call("connections_test", { id: connection.id })).ok);
      await db.pool.query("UPDATE repos SET url=$2,account=$3 WHERE id=$1", [
        repo.id,
        "https://github.com/account-a/works.git",
        one.id,
      ]);
      const root = (await repos.project(repo.id, work.project)).repo.root;
      await repos.git(root, [
        "update-ref",
        "refs/remotes/origin/" + work.branch,
        commit,
      ]);
      const realStatus = repos.status.bind(repos);
      repos.status = async () => ({
        remoteExists: true,
        ahead: 1,
        behind: 0,
        dirty: 1,
      });
      await github.release({
        task: exportId,
        artifact: relative,
        tag: "fixture",
        title: "Fixture release",
      });
      repos.status = realStatus;
      assert.equal(
        releaseBody.target_commitish,
        commit,
        "release targets exported source even when newer edits exist",
      );
      assert(uploaded > 0);
      releaseLease();
      await retention.tick();
      assert(!fs.existsSync(run));
      assert(
        (await db.one("SELECT cleaned FROM tasks WHERE id=$1", [exportId]))
          .cleaned,
      );
      assert.equal(
        (
          await db.one(
            "SELECT count(*)::int AS n FROM tasks WHERE project LIKE 'retained-%' AND cleaned IS NULL",
          )
        ).n,
        35,
      );
      await db.pool.query(
        "INSERT INTO repos(id,name) SELECT gen_random_uuid(),'scale-'||i FROM generate_series(1,100) i",
      );
      await db.pool.query(
        "INSERT INTO works(id,repo,project,title) SELECT gen_random_uuid(),r.id,'work-'||i,'scale work '||i FROM repos r CROSS JOIN generate_series(1,10) i WHERE r.name LIKE 'scale-%'",
      );
      repos.list = () => {
        throw new Error("Paged requests must not scan every repository");
      };
      const began = performance.now();
      const page = await call("works_page", { limit: 30, offset: 60 });
      assert.equal(page.items.length, 30);
      assert.equal(page.total, 1001);
      assert.equal((await call("repositories_page", { limit: 30 })).total, 101);
      t.diagnostic(
        JSON.stringify({
          syntheticRepositories: 100,
          syntheticWorks: 1000,
          pagedQueryMs: Math.round(performance.now() - began),
          fullScan: false,
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
      await platform.app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
