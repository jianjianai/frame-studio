import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, until } from "./paseo-test-fixture.mjs";
import {
  PaseoDrafts,
  capturePaseoCandidate,
} from "../../server/paseo-drafts.mjs";
import { copyTree, treeHash } from "../../server/project-files.mjs";

async function watcher(t, overrides = {}) {
  const f = await fixture(t);
  const { draft } = await f.workService.prepare(f.work.id);
  const native = {
    state: "ready",
    activeAgents: [],
    activeTerminals: 0,
    pendingPermissions: 0,
    incomplete: false,
  };
  const counts = { validate: 0, publish: 0 },
    errors = [];
  const manager = {
    ensure: async () => ({ ...draft, runtimeFingerprint: "d".repeat(64) }),
    observe: async () => native,
  };
  const validate = async (candidate) => {
    counts.validate++;
    const root = path.join(
      f.data,
      "runs",
      candidate.runId,
      "projects",
      f.work.project,
    );
    return {
      status: "passed",
      fingerprint: await treeHash(root),
      modeFingerprint: await treeHash(root, { includeExecutableMode: true }),
    };
  };
  const publish = async (candidate) => {
    counts.publish++;
    await copyTree(
      path.join(f.data, "runs", candidate.runId, "projects", f.work.project),
      f.canonical,
    );
    return { commit: "a".repeat(40) };
  };
  const drafts = new PaseoDrafts({
    ...f,
    manager,
    validate,
    publish,
    debounceMs: 30,
    reconcileMs: 60000,
    onError: (_work, error) => errors.push(error),
    ...overrides,
  });
  t.after(() => drafts.close());
  await drafts.start(f.work.id);
  return {
    ...f,
    draft,
    drafts,
    manager,
    native,
    counts,
    errors,
    validate,
    publish,
  };
}
const row = async (f, state) =>
  (await f.store.listCandidates(f.work.id, { states: [state] }))[0];

test("Opening a clean draft does not create a task; debounced editor saves publish one verified revision", async (t) => {
  const f = await watcher(t);
  assert.equal((await f.store.listCandidates(f.work.id)).length, 0);
  for (let index = 0; index < 4; index++)
    await fs.writeFile(
      path.join(f.draft.projectRoot, "scene.ts"),
      "export const editor=" + index + ";",
    );
  const applied = await until(() => row(f, "applied"));
  assert.equal(f.counts.validate, 1);
  assert.equal(f.counts.publish, 1);
  assert.match(
    await fs.readFile(path.join(f.canonical, "scene.ts"), "utf8"),
    /editor=3/,
  );
  assert.equal(applied.snapshotFingerprint, await treeHash(f.canonical));
  assert.deepEqual(f.errors, []);
});

test("Observed native agent/terminal activity and incomplete pagination defer candidate capture until idle", async (t) => {
  const f = await watcher(t);
  f.native.activeAgents = ["running-agent"];
  await fs.writeFile(
    path.join(f.draft.projectRoot, "scene.ts"),
    "export const terminal=true;",
  );
  await f.drafts.reconcile(f.work.id, { force: true });
  assert.equal((await f.store.listCandidates(f.work.id)).length, 0);
  f.native.activeAgents = [];
  f.native.activeTerminals = 1;
  await f.drafts.reconcile(f.work.id);
  assert.equal(f.counts.validate, 0);
  f.native.activeTerminals = 0;
  f.native.incomplete = true;
  await f.drafts.reconcile(f.work.id);
  assert.equal(f.counts.validate, 0);
  f.native.incomplete = false;
  await f.drafts.reconcile(f.work.id);
  await until(() => row(f, "applied"));
  assert.equal(f.counts.publish, 1);
});

test("A failing validator retains the candidate; an API retry without a watcher reuses it and cannot bypass validation", async (t) => {
  const f = await watcher(t);
  let failing = true;
  f.drafts.validate = async (candidate) => {
    if (failing) {
      f.counts.validate++;
      throw Error("Actual runtime failure");
    }
    return f.validate(candidate);
  };
  await fs.writeFile(
    path.join(f.draft.projectRoot, "scene.ts"),
    "export const retry=true;",
  );
  await f.drafts.reconcile(f.work.id, { force: true });
  const invalid = await until(() => row(f, "invalid"));
  assert.equal(f.counts.publish, 0);
  await assert.rejects(
    f.drafts.apply(f.work.id, invalid.id),
    /Only a verified/,
  );
  await f.drafts.stop(f.work.id);
  failing = false;
  const response = await f.drafts.retry(f.work.id, invalid.id);
  assert.equal(response.state, "queued_validation");
  assert.equal(response.id, invalid.id);
  assert.equal("runId" in response, false);
  await f.drafts.start(f.work.id);
  const applied = await until(() => row(f, "applied"));
  assert.equal(applied.id, invalid.id);
  assert.equal(f.counts.validate, 2);
  assert.equal(f.counts.publish, 1);
});

test("A source change during validation supersedes its immutable candidate and applies only the latest source", async (t) => {
  const f = await watcher(t);
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  f.drafts.validate = async (candidate) => {
    const result = await f.validate(candidate);
    if (first) {
      first = false;
      await blocked;
    }
    return result;
  };
  await fs.writeFile(
    path.join(f.draft.projectRoot, "scene.ts"),
    "export const version=1;",
  );
  await f.drafts.reconcile(f.work.id, { force: true });
  const old = await until(() => row(f, "validating"));
  await fs.writeFile(
    path.join(f.draft.projectRoot, "scene.ts"),
    "export const version=2;",
  );
  await f.drafts.reconcile(f.work.id, { force: true });
  release();
  const applied = await until(() => row(f, "applied"));
  assert.notEqual(applied.id, old.id);
  assert.equal((await f.store.getCandidate(old.id)).state, "superseded");
  assert.equal(f.counts.publish, 1);
  assert.match(
    await fs.readFile(path.join(f.canonical, "scene.ts"), "utf8"),
    /version=2/,
  );
});

test("Publication retry after a lost receipt reuses the same verified result and canonical bytes", async (t) => {
  const f = await watcher(t);
  let once = true;
  f.drafts.publish = async (candidate) => {
    const result = await f.publish(candidate);
    if (once) {
      once = false;
      throw Error("Lost apply acknowledgement");
    }
    return result;
  };
  await fs.writeFile(
    path.join(f.draft.projectRoot, "scene.ts"),
    "export const appliedBeforeAck=true;",
  );
  await f.drafts.reconcile(f.work.id, { force: true });
  const failed = await until(() => row(f, "publish_failed"));
  assert.equal(f.counts.validate, 1);
  assert.equal(f.counts.publish, 1);
  await f.drafts.retry(f.work.id, failed.id);
  const applied = await until(() => row(f, "applied"));
  assert.equal(applied.id, failed.id);
  assert.equal(f.counts.validate, 1);
  assert.equal(f.counts.publish, 2);
});

test("Canonical executable mode changes cause a conflict even when every source byte matches", async (t) => {
  const f = await watcher(t);
  f.drafts.validate = async (candidate) => {
    await fs.chmod(path.join(f.canonical, "scene.ts"), 0o755);
    return f.validate(candidate);
  };
  await fs.writeFile(
    path.join(f.draft.projectRoot, "scene.ts"),
    "export const candidate=true;",
  );
  await f.drafts.reconcile(f.work.id, { force: true });
  const conflict = await until(() => row(f, "conflict"));
  assert.equal(f.counts.publish, 0);
  assert.match(conflict.error, /Canonical source changed/);
});

test("A candidate capture rejects a mixed save or path traversal and removes only its owned partial run", async (t) => {
  const f = await fixture(t);
  const { draft, binding } = await f.workService.prepare(f.work.id);
  const runId = randomUUID();
  await assert.rejects(
    capturePaseoCandidate({
      ...f,
      projectRoot: draft.projectRoot,
      generation: binding.generation,
      runId,
      baselineFingerprint: binding.baselineFingerprint,
      baselineModeFingerprint: binding.baselineModeFingerprint,
      copy: async (source, target) => {
        await copyTree(source, target);
        await fs.writeFile(
          path.join(source, "scene.ts"),
          "export const changedDuringCopy=true;",
        );
      },
    }),
    /Draft changed while capturing/,
  );
  await assert.rejects(fs.stat(path.join(f.data, "runs", runId)), {
    code: "ENOENT",
  });
  await assert.rejects(
    capturePaseoCandidate({
      ...f,
      work: { ...f.work, project: "../foreign" },
      projectRoot: draft.projectRoot,
      generation: "0",
    }),
  );
});
