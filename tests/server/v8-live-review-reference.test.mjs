import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LivePreviewSessions } from "../../server/live-preview.mjs";
import { liveSourceInventory } from "../../scripts/live-preview-bundle.mjs";
import {
  freezeReviewReference,
  prepareReviewReference,
} from "../../server/review-reference.mjs";
import { reviewContextSchema } from "../../src/contracts/platform.mjs";
import { readCreatorContext } from "../../scripts/creator-context.mjs";
import { treeHash, copyTree } from "../../server/project-files.mjs";
import { database } from "../../server/db.mjs";

const project = "test-film";
const metadata = (duration = 8) =>
  `export default {id:'test-film',title:'Live review',duration:${duration},fps:24,beats:[{id:'opening',at:0,title:'Opening'}],subtitles:[],load:()=>import('./scene')};`;
async function fixture() {
  const data = await fs.mkdtemp(
    path.join(os.tmpdir(), "frame-v8-live-review-"),
  );
  const dir = path.join(data, "work/projects", project);
  await fs.mkdir(path.join(dir, "public"), { recursive: true });
  await fs.writeFile(path.join(dir, "project.ts"), metadata());
  await fs.writeFile(path.join(dir, "scene.ts"), "export const color='green';");
  await fs.writeFile(path.join(dir, "public/image.bin"), "last good media");
  const work = {
    id: randomUUID(),
    repo: randomUUID(),
    project,
    deleted: false,
  };
  const tasks = new Map(),
    workers = new Map();
  const repos = { data, project: async () => ({ dir }) };
  const db = {
    one: async (sql, args) => {
      if (!sql.startsWith("SELECT review_reference"))
        return tasks.get(args[0]) || null;
      const row = [...tasks.values()].find(
        (task) =>
          task.repo === args[0] &&
          task.project === args[1] &&
          !task.cleaned &&
          task.review_reference?.status === "versioned" &&
          task.review_reference?.mode === "live" &&
          task.review_reference.liveSessionId === args[2] &&
          task.review_reference.sourceRevision === args[3] &&
          ([
            "queued",
            "running",
            "cancelling",
            "publishing",
            "publish_failed",
          ].includes(task.state) ||
            Date.parse(task.expires || "") > Date.now()),
      );
      return row ? { review_reference: row.review_reference } : null;
    },
  };
  const livePreview = new LivePreviewSessions({
    data,
    db,
    repos,
    bundleFactory: async (args) => {
      workers.set(args.projectDir, args);
      return { close: async () => {} };
    },
  });
  const link = await livePreview.start({ work }),
    session = livePreview.sessions.get(link.sessionId);
  async function publish(session) {
    const args = workers.get(session.projectDir);
    await fs.mkdir(path.join(args.outDir, "assets"), { recursive: true });
    await fs.writeFile(
      path.join(args.outDir, "assets/player.js"),
      "export const ready=true;",
    );
    await fs.writeFile(
      path.join(args.outDir, "assets/project.js"),
      "export default {};",
    );
    await args.onBundle({
      ...(await liveSourceInventory(session.projectDir, project)),
      projectUrl: "assets/project.js",
      playerUrl: "assets/player.js",
      styles: [],
      files: ["assets/player.js", "assets/project.js"],
      buildMs: 1,
    });
    return session.manifest.sourceRevision;
  }
  const displayed = await publish(session);
  const context = {
    time: 1,
    shotId: "opening",
    liveSessionId: session.id,
    sourceRevision: displayed,
  };
  const freeze = (value = context, overrides = {}) =>
    freezeReviewReference({
      db,
      repos,
      repo: work.repo,
      project,
      context: value,
      livePreview,
      data,
      ...overrides,
    });
  return {
    data,
    dir,
    work,
    tasks,
    db,
    saveReference(reference, overrides = {}) {
      const id = randomUUID();
      tasks.set(id, {
        id,
        repo: work.repo,
        project,
        state: "succeeded",
        expires: new Date(Date.now() + 86400000).toISOString(),
        review_reference: reference,
        ...overrides,
      });
      return tasks.get(id);
    },
    workers,
    repos,
    livePreview,
    session,
    displayed,
    context,
    freeze,
    publish,
    close: async () => {
      await livePreview.close();
      await fs.rm(data, { recursive: true, force: true });
    },
  };
}

test("live review keeps the exact displayed source and media after a newer syntax error and later successful revision", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(
      path.join(f.dir, "scene.ts"),
      "export const = syntax error",
    );
    await fs.writeFile(
      path.join(f.dir, "public/image.bin"),
      "changed unfinished media",
    );
    f.workers.get(f.dir).onError(Error("Fixture syntax error"));
    assert.equal(f.session.state, "error");
    const frozen = await f.freeze();
    assert.equal(frozen.mode, "live");
    assert.equal(frozen.sourceRevision, f.displayed);
    assert.equal(frozen.sourceCommit, undefined);
    assert.equal(frozen.previewTask, undefined);
    assert.equal(
      await fs.readFile(
        path.join(f.data, frozen.snapshotPath, "scene.ts"),
        "utf8",
      ),
      "export const color='green';",
    );
    assert.equal(
      await fs.readFile(
        path.join(f.data, frozen.snapshotPath, "public/image.bin"),
        "utf8",
      ),
      "last good media",
    );
    await fs.writeFile(
      path.join(f.dir, "scene.ts"),
      "export const color='blue';",
    );
    const later = await f.publish(f.session);
    assert.notEqual(later, f.displayed);
    assert.equal(
      (await f.freeze()).fingerprint,
      frozen.fingerprint,
      "later valid updates do not reinterpret the old reference",
    );
  } finally {
    await f.close();
  }
});

test("live session references enforce repository/project ownership and identify the exact AI task", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.freeze(f.context, { repo: randomUUID() }),
      /does not belong/,
    );
    await assert.rejects(
      f.freeze(f.context, { project: "other-film" }),
      /does not belong/,
    );
    await assert.rejects(
      f.freeze({ ...f.context, draftTask: randomUUID() }),
      /draft does not belong/,
    );
    const taskId = randomUUID(),
      otherTask = randomUUID();
    const task = {
      id: taskId,
      repo: f.work.repo,
      project,
      kind: "agent",
      state: "running",
    };
    f.tasks.set(taskId, task);
    const draft = path.join(f.data, "runs", taskId, "projects", project);
    await copyTree(f.dir, draft);
    await fs.writeFile(
      path.join(draft, "scene.ts"),
      "export const color='draft';",
    );
    const link = await f.livePreview.start({ work: f.work, task: taskId });
    const session = f.livePreview.sessions.get(link.sessionId),
      revision = await f.publish(session);
    const context = {
      time: 2,
      liveSessionId: session.id,
      sourceRevision: revision,
      draftTask: taskId,
    };
    const frozen = await f.freeze(context);
    assert.equal(frozen.source, "task");
    assert.equal(frozen.draftTask, taskId);
    await assert.rejects(
      f.freeze({ ...context, draftTask: otherTask }),
      /draft does not belong/,
    );
    const { draftTask: _task, ...missing } = context;
    await assert.rejects(f.freeze(missing), /must identify its task/);
    f.tasks.set(otherTask, { ...task, id: otherTask, repo: randomUUID() });
    await assert.rejects(
      f.livePreview.start({ work: f.work, task: otherTask }),
      /does not belong/,
    );
    await assert.rejects(
      f.freeze({ ...context, sourceRevision: "f".repeat(64) }),
      /expired/,
    );
  } finally {
    await f.close();
  }
});

test("public review context accepts one complete live or immutable identity and rejects forged mixed fields", () => {
  const live = {
    time: 1,
    liveSessionId: randomUUID(),
    sourceRevision: "a".repeat(64),
    draftTask: randomUUID(),
  };
  assert.equal(reviewContextSchema.safeParse(live).success, true);
  assert.equal(
    reviewContextSchema.safeParse({
      time: 1,
      sourceCommit: "b".repeat(40),
      previewTask: randomUUID(),
    }).success,
    true,
  );
  for (const value of [
    { ...live, sourceCommit: "b".repeat(40) },
    { ...live, previewTask: randomUUID() },
    { time: 1, liveSessionId: live.liveSessionId },
    { time: 1, sourceRevision: live.sourceRevision },
    { time: 1, draftTask: live.draftTask },
    { ...live, liveSessionId: "../../other" },
    { ...live, sourceRevision: "../../other" },
    { ...live, snapshotPath: "../../credentials" },
    { ...live, start: 3, end: 2 },
    { ...live, sourceCommit: "short" },
  ])
    assert.equal(
      reviewContextSchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
});

test("queued execution compares to an immutable live snapshot after source changes even without a Git commit", async () => {
  const f = await fixture();
  try {
    const reference = await f.freeze();
    await fs.writeFile(
      path.join(f.dir, "scene.ts"),
      "export const color='new execution';",
    );
    await fs.writeFile(path.join(f.dir, "project.ts"), metadata(12));
    await fs.writeFile(
      path.join(f.dir, "public/image.bin"),
      "new execution media",
    );
    const run = path.join(f.data, "runs", randomUUID());
    await copyTree(f.dir, path.join(run, "projects", project));
    const task = {
      project,
      input: { context: f.context },
      review_reference: reference,
    };
    const prepared = await prepareReviewReference({
      repos: f.repos,
      task,
      run,
      fingerprint: await treeHash(f.dir),
      data: f.data,
    });
    assert.equal(prepared.disposition, "compare-to-latest");
    assert.equal(prepared.sourceRevision, f.displayed);
    assert.equal(prepared.path, "review/reference/projects/test-film");
    assert.equal(
      await fs.readFile(path.join(run, prepared.path, "scene.ts"), "utf8"),
      "export const color='green';",
    );
    assert.equal(
      await fs.readFile(
        path.join(run, prepared.path, "public/image.bin"),
        "utf8",
      ),
      "last good media",
    );
    assert.match(
      await fs.readFile(
        path.join(run, "projects", project, "scene.ts"),
        "utf8",
      ),
      /new execution/,
    );
    const identicalRun = path.join(f.data, "runs", randomUUID());
    await copyTree(
      path.join(f.data, reference.snapshotPath),
      path.join(identicalRun, "projects", project),
    );
    const current = await prepareReviewReference({
      repos: f.repos,
      task,
      run: identicalRun,
      fingerprint: reference.fingerprint,
      data: f.data,
    });
    assert.equal(current.disposition, "current");
    assert.equal(current.path, "projects/test-film");
  } finally {
    await f.close();
  }
});

test("live reference preparation rejects path forgery, changed snapshots, links and coordinates outside the frozen version", async () => {
  const f = await fixture();
  try {
    const reference = await f.freeze();
    const prepare = (ref = reference, context = f.context) =>
      prepareReviewReference({
        repos: f.repos,
        task: { project, input: { context }, review_reference: ref },
        run: path.join(f.data, "runs", randomUUID()),
        sourceCommit: "c".repeat(40),
        fingerprint: "d".repeat(64),
        data: f.data,
      });
    await assert.rejects(
      prepare({ ...reference, snapshotPath: "../outside/projects/test-film" }),
      /Invalid live review source/,
    );
    await assert.rejects(
      prepare({
        ...reference,
        snapshotPath: reference.snapshotPath + "/../test-film",
      }),
      /Invalid live review source/,
    );
    await assert.rejects(
      prepare({ ...reference, liveSessionId: randomUUID() }),
      /Invalid live review source/,
    );
    await assert.rejects(
      prepare(reference, { time: 9 }),
      (error) => error.code === "REVIEW_RANGE_INVALID",
    );
    await assert.rejects(
      prepare({ ...reference, shotId: "missing" }),
      /镜头不存在/,
    );
    const snapshot = path.join(f.data, reference.snapshotPath);
    await fs.appendFile(path.join(snapshot, "scene.ts"), "\n// tampered");
    await assert.rejects(prepare(), /snapshot is missing or changed/);
    await assert.rejects(
      f.freeze(),
      /Frozen live review source was modified/,
      "freezing again must not bless a changed persisted snapshot",
    );
    await fs.writeFile(
      path.join(snapshot, "scene.ts"),
      "export const color='green';",
    );
    await fs.rm(path.join(snapshot, "public/image.bin"));
    const outside = path.join(f.data, "outside.bin");
    await fs.writeFile(outside, "must not copy");
    await fs.symlink(outside, path.join(snapshot, "public/image.bin"));
    await assert.rejects(prepare(), /Links and special files/);
    await assert.rejects(
      f.freeze(f.context, {
        livePreview: {
          freezeReference: async () => ({
            dir: path.join(f.data, "outside"),
            source: "work",
          }),
        },
      }),
      /Invalid live review snapshot/,
    );
  } finally {
    await f.close();
  }
});

test("an interrupted first freeze cannot bless a partial media snapshot on retry", async () => {
  const f = await fixture();
  try {
    const revision =
      f.session.manifest.assetRevisions["films/test-film/image.bin"];
    const media = f.session.mediaFiles.get(revision);
    f.session.mediaFiles.delete(revision);
    await assert.rejects(f.freeze(), /media revision has expired/);
    await assert.rejects(
      f.freeze(),
      /media revision has expired/,
      "a retry must rebuild or reject a partial copy, never trust its presence",
    );
    f.session.mediaFiles.set(revision, media);
    const recovered = await f.freeze();
    assert.equal(
      await fs.readFile(
        path.join(f.data, recovered.snapshotPath, "public/image.bin"),
        "utf8",
      ),
      "last good media",
    );
  } finally {
    await f.close();
  }
});

test("concurrent freezes share one complete immutable snapshot without leaking temporary directories", async () => {
  const f = await fixture();
  try {
    const values = await Promise.all([f.freeze(), f.freeze(), f.freeze()]);
    assert(
      values.every(
        (value) =>
          value.snapshotPath === values[0].snapshotPath &&
          value.fingerprint === values[0].fingerprint,
      ),
    );
    const parent = path.join(f.data, "live-preview-references", f.session.id);
    assert.deepEqual(await fs.readdir(parent), [f.displayed]);
    assert.equal(
      await fs.readFile(
        path.join(f.data, values[0].snapshotPath, "public/image.bin"),
        "utf8",
      ),
      "last good media",
    );
  } finally {
    await f.close();
  }
});

test("saved live references survive idle release, service restart and revision eviction", async () => {
  for (const mode of ["idle", "restart", "eviction"]) {
    const f = await fixture();
    let restarted;
    try {
      const reference = await f.freeze();
      f.saveReference(reference);
      if (mode === "eviction") {
        for (let i = 0; i < 17; i++) {
          await fs.writeFile(
            path.join(f.dir, "scene.ts"),
            `export const color='revision-${i}';`,
          );
          await f.publish(f.session);
        }
        assert.equal(f.session.sourceSnapshots.has(f.displayed), false);
      } else if (mode === "restart") {
        await f.livePreview.close();
        restarted = new LivePreviewSessions({
          data: f.data,
          db: f.db,
          repos: f.repos,
          bundleFactory: async () => ({ close: async () => {} }),
        });
      } else await f.livePreview.stop(f.session.id);
      const restored = await f.freeze(
        f.context,
        restarted ? { livePreview: restarted } : {},
      );
      assert.deepEqual(restored, reference, mode);
      assert.equal(
        await fs.readFile(
          path.join(f.data, restored.snapshotPath, "scene.ts"),
          "utf8",
        ),
        "export const color='green';",
      );
    } finally {
      await restarted?.close();
      await f.close();
    }
  }
});

test("saved live reference lookup remains bound to retained same-work task records and intact canonical files", async () => {
  const f = await fixture();
  try {
    const reference = await f.freeze();
    const saved = f.saveReference(reference);
    await f.livePreview.stop(f.session.id);
    await assert.rejects(
      f.freeze(f.context, { repo: randomUUID() }),
      /does not belong/,
    );
    await assert.rejects(
      f.freeze(f.context, { project: "other-film" }),
      /does not belong/,
    );
    await assert.rejects(
      f.freeze({ ...f.context, draftTask: randomUUID() }),
      /draft does not belong/,
    );
    await assert.rejects(
      f.freeze({ ...f.context, sourceRevision: "f".repeat(64) }),
      /does not belong/,
    );
    saved.cleaned = new Date().toISOString();
    await assert.rejects(f.freeze(), /does not belong/);
    saved.cleaned = null;
    saved.expires = new Date(Date.now() - 1000).toISOString();
    await assert.rejects(f.freeze(), /does not belong/);
    saved.expires = new Date(Date.now() + 86400000).toISOString();
    saved.review_reference = {
      ...reference,
      snapshotPath: "../outside/projects/test-film",
    };
    await assert.rejects(f.freeze(), /Invalid saved live review source/);
    saved.review_reference = reference;
    const snapshot = path.join(f.data, reference.snapshotPath);
    await fs.appendFile(path.join(snapshot, "scene.ts"), "\n// tampered");
    await assert.rejects(f.freeze(), /snapshot is missing or changed/);
    await fs.writeFile(
      path.join(snapshot, "scene.ts"),
      "export const color='green';",
    );
    await fs.rm(path.join(snapshot, "public/image.bin"));
    const outside = path.join(f.data, "outside.bin");
    await fs.writeFile(outside, "must not accept a link");
    await fs.symlink(outside, path.join(snapshot, "public/image.bin"));
    await assert.rejects(f.freeze(), /Links and special files/);
    await fs.rm(snapshot, { recursive: true, force: true });
    await assert.rejects(f.freeze(), /snapshot is missing or changed/);
    f.tasks.clear();
    await assert.rejects(f.freeze(), /does not belong/);
  } finally {
    await f.close();
  }
});

test("saved draft references require their original task after the live session closes", async () => {
  const f = await fixture();
  try {
    const taskId = randomUUID();
    f.tasks.set(taskId, {
      id: taskId,
      repo: f.work.repo,
      project,
      kind: "agent",
      state: "running",
    });
    const draft = path.join(f.data, "runs", taskId, "projects", project);
    await copyTree(f.dir, draft);
    const link = await f.livePreview.start({ work: f.work, task: taskId });
    const session = f.livePreview.sessions.get(link.sessionId);
    const revision = await f.publish(session);
    const context = {
      time: 2,
      liveSessionId: session.id,
      sourceRevision: revision,
      draftTask: taskId,
    };
    const reference = await f.freeze(context);
    f.saveReference(reference);
    await f.livePreview.stop(session.id);
    assert.deepEqual(await f.freeze(context), reference);
    await assert.rejects(
      f.freeze({ ...context, draftTask: randomUUID() }),
      /draft does not belong/,
    );
    const { draftTask: _task, ...missing } = context;
    await assert.rejects(f.freeze(missing), /draft does not belong/);
  } finally {
    await f.close();
  }
});

test("creator handoff identifies the exact live reference without leaking task credentials", async () => {
  const f = await fixture();
  try {
    const root = path.resolve(f.dir, "../.."),
      task = randomUUID();
    const reference = await f.freeze();
    await fs.writeFile(
      path.join(root, "task.json"),
      JSON.stringify({
        id: task,
        kind: "agent",
        project,
        input: { context: f.context },
        credential: "private-fixture-credential",
        reviewReference: {
          ...reference,
          disposition: "compare-to-latest",
          path: "review/reference/projects/" + project,
        },
      }),
    );
    const context = readCreatorContext(root);
    assert.equal(context.request.liveSessionId, f.context.liveSessionId);
    assert.equal(context.reference.sourceRevision, f.context.sourceRevision);
    assert.equal(context.reference.mode, "live");
    assert.equal(context.reference.source, "work");
    assert.equal(context.focus.mapping, "requires_comparison");
    assert.equal(context.focus.time, null);
    assert.equal(
      JSON.stringify(context).includes("private-fixture-credential"),
      false,
    );
    assert.equal(context.reference.sourceCommit, undefined);
  } finally {
    await f.close();
  }
});

test(
  "retained saved live references recover through the real PostgreSQL task record after session release",
  { skip: !process.env.FRAME_TEST_DATABASE_URL },
  async () => {
    const url = process.env.FRAME_TEST_DATABASE_URL;
    assert.match(new URL(url).pathname, /frame_test/);
    const f = await fixture(),
      taskId = randomUUID();
    const db = await database(url, "v8-reference-database-password");
    try {
      const frozen = await f.freeze();
      await db.pool.query("INSERT INTO repos(id,name) VALUES($1,$2)", [
        f.work.repo,
        "V8 reference recovery",
      ]);
      await db.pool.query(
        "INSERT INTO tasks(id,repo,project,kind,state,input,review_reference,expires) VALUES($1,$2,$3,'agent','succeeded','{}',$4,now()+interval '7 days')",
        [taskId, f.work.repo, project, frozen],
      );
      await f.livePreview.stop(f.session.id);
      const recovered = await f.freeze(f.context, { db });
      assert.deepEqual(recovered, frozen);
      await assert.rejects(
        f.freeze(f.context, { db, repo: randomUUID() }),
        /does not belong/,
      );
      await db.pool.query(
        "UPDATE tasks SET expires=now()-interval '1 day' WHERE id=$1",
        [taskId],
      );
      await assert.rejects(f.freeze(f.context, { db }), /does not belong/);
      await db.pool.query("UPDATE tasks SET state='queued' WHERE id=$1", [
        taskId,
      ]);
      assert.deepEqual(
        await f.freeze(f.context, { db }),
        frozen,
        "active tasks retain their references beyond terminal expiry",
      );
      await db.pool.query("UPDATE tasks SET cleaned=now() WHERE id=$1", [
        taskId,
      ]);
      await assert.rejects(f.freeze(f.context, { db }), /does not belong/);
    } finally {
      await db.pool.query("DELETE FROM tasks WHERE id=$1", [taskId]);
      await db.pool.query("DELETE FROM repos WHERE id=$1", [f.work.repo]);
      await db.pool.end();
        await f.close();
    }
  },
);
