import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { WorkUndo } from "../../server/work-undo.mjs";
import { applyProject } from "../../server/apply-project.mjs";
import { treeHash, copyTree } from "../../server/project-files.mjs";

const url = process.env.FRAME_TEST_DATABASE_URL;
async function fixture(run) {
  assert.match(new URL(url).pathname, /frame_test/);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-v5-undo-"));
  const db = await database(url, "v5-undo-fixture-password");
  await db.pool.query(
    "TRUNCATE repos,tasks,events,chats,works,connections,assets,engines,auth_flows CASCADE",
  );
  const services = await createApp({
    db,
    data,
    masterKey: "13".repeat(32),
    scheduler: false,
  });
  const { actions, repos } = services;
  try {
    const repo = await actions.call("repositories_add", {
      name: "Undo fixture",
    });
    const work = await actions.call("works_create", {
      repo: repo.id,
      title: "Undo work",
    });
    const location = await repos.project(repo.id, work.project);
    const text = "export const value = 1;\n";
    fs.writeFileSync(path.join(location.dir, "undo-fixture.ts"), text);
    const before = await repos.checkpoint(repo.id, work.project, "Before AI");
    fs.writeFileSync(
      path.join(location.dir, "undo-fixture.ts"),
      "export const value = 2;\n",
    );
    const after = await repos.checkpoint(repo.id, work.project, "AI change");
    const task = randomUUID();
    await db.pool.query(
      "INSERT INTO tasks(id,repo,project,kind,state,input,base_commit,result,finished) VALUES($1,$2,$3,'agent','succeeded',$4,$5,$6,now())",
      [
        task,
        repo.id,
        work.project,
        { prompt: "Change the fixture", context: { start: 1, end: 2 } },
        before,
        {
          commit: after,
          validation: [{ check: "structure", status: "passed", durationMs: 1 }],
        },
      ],
    );
    const args = async () => ({
      id: work.id,
      task,
      requestKey: randomUUID(),
      expectedCommit: await repos.git(location.repo.root, [
        "rev-parse",
        "HEAD",
      ]),
      expectedRevision: await treeHash(location.dir),
    });
    await run({
      ...services,
      db,
      data,
      repo,
      work,
      location,
      before,
      after,
      task,
      args,
      text,
    });
  } finally {
    await services.app.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
}

test(
  "inverse undo preserves later unrelated work, appends a commit and is idempotent",
  { skip: !url },
  () =>
    fixture(async (f) => {
      fs.writeFileSync(
        path.join(f.location.dir, "later.txt"),
        "Do not lose this later work\n",
      );
      const later = await f.repos.checkpoint(
        f.repo.id,
        f.work.project,
        "Later unrelated edit",
      );
      const review = await f.actions.call("works_result", {
        id: f.work.id,
        task: f.task,
      });
      assert.equal(review.before, f.before);
      assert.equal(review.after, f.after);
      assert.equal(review.current, later);
      assert.equal(review.total, 1);
      assert.equal(review.changes[0].path, "undo-fixture.ts");
      assert.equal(review.undo.available, true);
      const request = await f.args();
      const undone = await f.actions.call("works_undo", request);
      assert.equal(undone.state, "succeeded");
      assert.equal(
        fs.readFileSync(path.join(f.location.dir, "undo-fixture.ts"), "utf8"),
        f.text,
      );
      assert.equal(
        fs.readFileSync(path.join(f.location.dir, "later.txt"), "utf8"),
        "Do not lose this later work\n",
      );
      assert.equal(
        await f.repos.git(f.location.repo.root, ["rev-parse", "HEAD^"]),
        later,
      );
      assert.equal(
        await f.repos.git(f.location.repo.root, ["status", "--porcelain"]),
        "",
      );
      assert(undone.previewTask);
      assert.deepEqual(await f.actions.call("works_undo", request), undone);
      assert.equal(
        (
          await f.db.one(
            "SELECT count(*)::int AS n FROM work_undos WHERE task=$1",
            [f.task],
          )
        ).n,
        1,
      );
      assert.equal(
        (await f.actions.call("works_result", { id: f.work.id, task: f.task }))
          .undo.reason,
        "本次修改已撤销",
      );
    }),
);

test(
  "overlapping inverse conflict never modifies live files, index or branch",
  { skip: !url },
  () =>
    fixture(async (f) => {
      fs.writeFileSync(
        path.join(f.location.dir, "undo-fixture.ts"),
        "export const value = 3;\n",
      );
      const later = await f.repos.checkpoint(
        f.repo.id,
        f.work.project,
        "Conflicting later edit",
      );
      const request = await f.args();
      await assert.rejects(
        f.actions.call("works_undo", request),
        (e) => e.code === "UNDO_CONFLICT",
      );
      assert.equal(
        fs.readFileSync(path.join(f.location.dir, "undo-fixture.ts"), "utf8"),
        "export const value = 3;\n",
      );
      assert.equal(
        await f.repos.git(f.location.repo.root, ["rev-parse", "HEAD"]),
        later,
      );
      assert.equal(
        await f.repos.git(f.location.repo.root, ["status", "--porcelain"]),
        "",
      );
      assert.equal(
        (await f.db.one("SELECT count(*)::int AS n FROM work_undos")).n,
        0,
      );
    }),
);

test(
  "stale, dirty and cross-work undo requests are rejected without losing edits",
  { skip: !url },
  () =>
    fixture(async (f) => {
      const stale = await f.args();
      fs.writeFileSync(path.join(f.location.dir, "later.txt"), "unsaved\n");
      await assert.rejects(
        f.actions.call("works_undo", stale),
        (e) => e.code === "UNDO_BASE_CHANGED",
      );
      await assert.rejects(
        f.actions.call("works_undo", await f.args()),
        (e) => e.code === "UNDO_DIRTY_WORK",
      );
      assert.equal(
        fs.readFileSync(path.join(f.location.dir, "later.txt"), "utf8"),
        "unsaved\n",
      );
      const other = await f.actions.call("works_create", {
        repo: f.repo.id,
        title: "Other",
      });
      await assert.rejects(
        f.actions.call("works_undo", { ...stale, id: other.id }),
        (e) => e.statusCode === 404,
      );
      await assert.rejects(
        f.actions.call("works_result", { id: other.id, task: f.task }),
        (e) => e.statusCode === 404,
      );
    }),
);

test(
  "a crash after file replacement resumes the same undo without replaying AI",
  { skip: !url },
  () =>
    fixture(async (f) => {
      const options = {
        db: f.db,
        data: f.data,
        works: f.actions.works,
        repos: f.repos,
        tasks: f.tasks,
      };
      const interrupted = new WorkUndo({
        ...options,
        apply: async (args) => {
          await applyProject(args);
          throw Error("simulated interruption after rename");
        },
      });
      const request = await f.args();
      await assert.rejects(
        interrupted.undo(request),
        (e) => e.code === "UNDO_RECOVERY_REQUIRED",
      );
      assert.equal(
        (
          await f.db.one("SELECT state FROM work_undos WHERE id=$1", [
            request.requestKey,
          ])
        ).state,
        "failed",
      );
      await assert.rejects(
        f.repos.writable(f.repo.id, f.work.project),
        (e) => e.code === "UNDO_RECOVERY_REQUIRED",
      );
      const result = await new WorkUndo(options).undo(request);
      assert.equal(result.state, "succeeded");
      assert.equal(
        fs.readFileSync(path.join(f.location.dir, "undo-fixture.ts"), "utf8"),
        f.text,
      );
      assert.equal(
        await f.repos.git(f.location.repo.root, ["rev-parse", "HEAD^"]),
        f.after,
      );
      assert.equal(
        (
          await f.db.one(
            "SELECT count(*)::int AS n FROM tasks WHERE kind='agent'",
          )
        ).n,
        1,
      );
      assert.deepEqual(await new WorkUndo(options).undo(request), result);
    }),
);

test(
  "undo recovers a crash between directory renames while the work entry is temporarily absent",
  { skip: !url },
  () =>
    fixture(async (f) => {
      const options = {
        db: f.db,
        data: f.data,
        works: f.actions.works,
        repos: f.repos,
        tasks: f.tasks,
      };
      const interrupted = new WorkUndo({
        ...options,
        apply: async ({ source, destination, run, id, hashTree = treeHash }) => {
          const output = await hashTree(source);
          await copyTree(source, destination + ".frame-" + id);
          fs.writeFileSync(
            path.join(run, "apply.json"),
            JSON.stringify({ output }),
          );
          fs.renameSync(destination, path.join(run, "original-project"));
          throw Error("simulated crash between the two directory renames");
        },
      });
      const request = await f.args();
      await assert.rejects(
        interrupted.undo(request),
        (error) => error.code === "UNDO_RECOVERY_REQUIRED",
      );
      assert.equal(fs.existsSync(f.location.dir), false);
      const review = await f.actions.call("works_result", {
        id: f.work.id,
        task: f.task,
      });
      assert.equal(review.undo.recovery, true);
      assert.equal(review.undo.available, true);
      const result = await new WorkUndo(options).undo(request);
      assert.equal(result.state, "succeeded");
      assert.equal(
        fs.readFileSync(path.join(f.location.dir, "undo-fixture.ts"), "utf8"),
        f.text,
      );
      assert.equal(
        await f.repos.git(f.location.repo.root, ["status", "--porcelain"]),
        "",
      );
    }),
);


test("inverse undo restores executable-only changes and leaves a clean worktree", { skip: !url }, () =>
  fixture(async (f) => {
    const file = path.join(f.location.dir, "undo-fixture.ts");
    await f.repos.git(f.location.repo.root, ["config", "core.filemode", "true"]);
    const before = await f.repos.git(f.location.repo.root, ["rev-parse", "HEAD"]);
    fs.chmodSync(file, 0o755);
    const after = await f.repos.checkpoint(f.repo.id, f.work.project, "AI executable-bit change");
    assert.notEqual(before, after);
    await f.db.pool.query("UPDATE tasks SET base_commit=$2,result=$3 WHERE id=$1", [f.task, before, { commit: after }]);
    const text = fs.readFileSync(file, "utf8");
    const undone = await f.actions.call("works_undo", await f.args());
    assert.equal(undone.state, "succeeded");
    assert.equal(fs.readFileSync(file, "utf8"), text);
    assert.equal(fs.statSync(file).mode & 0o111, 0);
    assert.equal(await f.repos.git(f.location.repo.root, ["status", "--porcelain"]), "");
  }),
);
