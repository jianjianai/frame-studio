import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate, migrationPlan } from "../../server/migrations.mjs";

const url = process.env.FRAME_TEST_DATABASE_URL;

test(
  "V4 to V5 real database upgrade preserves work, queued requests and history; old binaries fail closed",
  { skip: !url, timeout: 30000 },
  async () => {
    const source = new URL(url);
    assert.match(decodeURIComponent(source.pathname), /frame_test/);
    if (process.env.DATABASE_URL) {
      const application = new URL(process.env.DATABASE_URL);
      assert.notEqual(
        source.host + source.pathname,
        application.host + application.pathname,
      );
    }
    const name = "frame_test_v5_upgrade_" + randomUUID().replaceAll("-", "");
    assert.match(name, /^frame_test_v5_upgrade_[a-f0-9]{32}$/);
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    let pool,
      created = false;
    try {
      // The isolated fixture gets its own database, not a destructive reset of the shared test database.
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
      source.pathname = "/" + name;
      pool = new pg.Pool({ connectionString: source.toString(), max: 2 });
      const all = migrationPlan(),
        v4 = all.filter((item) => item.id < "0007-");
      assert.equal(v4.length, 6);
      await migrate(pool, v4);
      const repo = randomUUID(),
        work = randomUUID(),
        chat = randomUUID(),
        task = randomUUID(),
        requestKey = randomUUID();
      await pool.query("INSERT INTO repos(id,name) VALUES($1,'V4 content')", [
        repo,
      ]);
      await pool.query(
        "INSERT INTO works(id,repo,project,title,branch) VALUES($1,$2,'legacy-film','原作品','works/legacy-film')",
        [work, repo],
      );
      await pool.query(
        "INSERT INTO chats(id,repo,project,provider,title,upstream) VALUES($1,$2,'legacy-film','codex','旧对话','legacy-upstream')",
        [chat, repo],
      );
      const input = {
        provider: "codex",
        prompt: "尚未执行的旧请求",
        context: { time: 2 },
      };
      await pool.query(
        "INSERT INTO tasks(id,repo,project,kind,input,chat,request_key) VALUES($1,$2,'legacy-film','agent',$3,$4,$5)",
        [task, repo, input, chat, requestKey],
      );
      await pool.query(
        "INSERT INTO events(task,kind,data) VALUES($1,'message',$2)",
        [task, { text: "原始持久记录" }],
      );
      await migrate(pool, all);
      const upgraded = (
        await pool.query("SELECT * FROM tasks WHERE id=$1", [task])
      ).rows[0];
      assert.equal(upgraded.state, "queued");
      assert.equal(upgraded.request_key, requestKey);
      assert.deepEqual(upgraded.input, input);
      for (const column of [
        "request_input",
        "execution",
        "review_reference",
        "base_commit",
      ])
        assert.equal(
          upgraded[column],
          null,
          "legacy provenance must not be invented: " + column,
        );
      assert.deepEqual(upgraded.metrics, {});
      assert.equal(
        (await pool.query("SELECT title FROM works WHERE id=$1", [work]))
          .rows[0].title,
        "原作品",
      );
      const conversation = (
        await pool.query(
          "SELECT upstream,upstream_execution FROM chats WHERE id=$1",
          [chat],
        )
      ).rows[0];
      assert.equal(conversation.upstream, "legacy-upstream");
      assert.equal(conversation.upstream_execution, null);
      assert.deepEqual(
        (await pool.query("SELECT data FROM events WHERE task=$1", [task]))
          .rows[0].data,
        { text: "原始持久记录" },
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM work_undos")).rows[0]
          .n,
        0,
      );
      await migrate(pool, all);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM frame_schema_migrations",
          )
        ).rows[0].n,
        all.length,
      );
      await assert.rejects(migrate(pool, v4), /newer than this application/);
      assert.deepEqual(
        (await pool.query("SELECT input FROM tasks WHERE id=$1", [task]))
          .rows[0].input,
        input,
      );
    } finally {
      await pool?.end();
      try {
        if (created) await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
    }
  },
);
