import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./paseo-test-fixture.mjs";
import {
  PaseoWork,
  freezePaseoSubmission,
  paseoIntentHash,
  preparePaseoDraft,
} from "../../server/paseo-work.mjs";
import { treeHash } from "../../server/project-files.mjs";
import { freezeReviewReference } from "../../server/review-reference.mjs";
import { LivePreviewSessions } from "../../server/live-preview.mjs";

const sha = (digit) => digit.repeat(64);
test("Concurrent preparation creates one stable draft with mode identity and reopening preserves manual edits", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      preparePaseoDraft({ data: f.data, work: f.work, source: f.canonical }),
    ),
  );
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(
    results[0].draftRevision,
    await treeHash(f.canonical, { includeExecutableMode: true }),
  );
  await fs.writeFile(
    path.join(results[0].projectRoot, "scene.ts"),
    "export const color='manual';",
  );
  const reopened = await f.workService.prepare(f.work.id);
  assert.equal(reopened.draft.created, false);
  assert.match(
    await fs.readFile(
      path.join(reopened.draft.projectRoot, "scene.ts"),
      "utf8",
    ),
    /manual/,
  );
  assert.equal(
    reopened.binding.baselineFingerprint,
    await treeHash(f.canonical),
  );
});

test("Initial preparation rejects out-of-scope links and retains no partially prepared stable draft", async (t) => {
  const f = await fixture(t);
  await fs.symlink(
    path.join(f.directory, "database.sqlite"),
    path.join(f.canonical, "public", "linked"),
  );
  await assert.rejects(
    f.workService.prepare(f.work.id),
    /Links and special files/,
  );
  const base = path.join(f.data, "paseo", f.work.id);
  const contents = await fs.readdir(base);
  assert.equal(
    contents.some((name) => name.startsWith("draft")),
    false,
  );
  assert.throws(() => paseoIntentHash({ value: NaN }), /finite/);
  assert.equal(
    paseoIntentHash({ b: 2, a: 1 }),
    paseoIntentHash({ a: 1, b: 2 }),
  );
});

async function frozenFixture(t) {
  const f = await fixture(t);
  await f.workService.prepare(f.work.id);
  const sessionId = randomUUID(),
    sourceRevision = sha("a");
  const snapshot = path.join(
    f.data,
    "live-preview-references",
    sessionId,
    sourceRevision,
    "projects/fixture",
  );
  await fs.mkdir(snapshot, { recursive: true });
  await fs.writeFile(
    path.join(snapshot, "project.ts"),
    "export default {id:'fixture',title:'Frozen',duration:2,fps:12,load:()=>import('./scene')};",
  );
  await fs.writeFile(
    path.join(snapshot, "scene.ts"),
    "export const oldSource=true;",
  );
  const reference = {
    dir: snapshot,
    sourceRevision,
    source: "paseo",
    sessionId,
    task: null,
    fingerprint: await treeHash(snapshot, { includeIgnored: true }),
  };
  const asset = randomUUID();
  await f.db.pool.query(
    "INSERT INTO assets(id,name,sha,bytes,mime,license) VALUES($1,'Own sample',$2,1,'audio/wav','fixture')",
    [asset, sha("b")],
  );
  await f.db.pool.query(
    "INSERT INTO asset_repos(asset,repo,catalog_id) VALUES($1,$2,$1)",
    [asset, f.work.repo],
  );
  let calls = 0;
  const livePreview = {
    async freezeReference(input) {
      calls++;
      assert.equal(input.repo, f.work.repo);
      if (
        input.sessionId !== sessionId ||
        input.sourceRevision !== sourceRevision
      )
        throw Object.assign(Error("Expired"), { statusCode: 410 });
      return reference;
    },
  };
  const submission = {
    agentId: "agent-one",
    messageId: randomUUID(),
    prompt: "Use this frame",
    profileId: "frame-profile",
    model: "selected-model",
    attachmentsFingerprint: sha("c"),
    context: {
      time: 1,
      start: 0.5,
      end: 1.5,
      assets: [asset],
      liveSessionId: sessionId,
      sourceRevision,
    },
  };
  const options = {
    ...f,
    work: f.work,
    submission,
    livePreview,
    authorizeAgent: async (_work, agentId) =>
      agentId === "agent-one"
        ? { id: agentId, provider: "frame-profile", model: "selected-model" }
        : null,
    resolveSelection: async () => ({
      schema: 1,
      provider: "codex",
      connection: randomUUID(),
      authGeneration: "1",
    }),
  };
  return { ...f, reference, submission, options, calls: () => calls };
}

test("Frozen native submissions reuse exact context across retries and reject changed intent or foreign selections", async (t) => {
  const f = await frozenFixture(t);
  const first = await freezePaseoSubmission(f.options);
  const retried = await freezePaseoSubmission({
    ...f.options,
    livePreview: {
      freezeReference() {
        throw Error("Must not re-freeze");
      },
    },
  });
  assert.deepEqual(retried, first);
  const referenceFolder = path.join(
    f.data,
    "paseo",
    f.work.id,
    "references/messages",
    f.submission.messageId,
  );
  await fs.rm(referenceFolder, { recursive: true });
  assert.deepEqual(
    await freezePaseoSubmission({
      ...f.options,
      livePreview: {
        freezeReference() {
          throw Error("Must not re-freeze");
        },
      },
      resolveSelection() {
        throw Error("Must not reselect credentials");
      },
    }),
    first,
  );
  const recoveredManifest = JSON.parse(
    await fs.readFile(path.join(referenceFolder, "manifest.json"), "utf8"),
  );
  assert.equal(recoveredManifest.materials[0].name, "Own sample");
  assert.equal(recoveredManifest.materials[0].sha256, sha("b"));
  assert.equal(first.reviewReference.mode, "live");
  assert.match(first.attachment.text, /Own sample/);
  assert.doesNotMatch(
    JSON.stringify(first),
    /snapshotPath|authGeneration|database.sqlite|frame-paseo-test-/,
  );
  const stored = await f.store.getMessage({
    workId: f.work.id,
    ...f.submission,
  });
  assert.equal(
    stored.reviewReference.snapshotPath,
    path.relative(f.data, f.reference.dir).replaceAll("\\", "/"),
  );
  assert.equal(stored.execution.authGeneration, "1");
  assert.deepEqual(stored.execution.nativeSelection, {
    provider: "frame-profile",
    model: "selected-model",
  });
  assert.doesNotMatch(JSON.stringify(first), /nativeSelection/);
  const changedNative = await freezePaseoSubmission({
    ...f.options,
    authorizeAgent() {
      throw Error(
        "A completed frozen retry must retain the original selection",
      );
    },
  });
  assert.deepEqual(changedNative, first);
  assert.deepEqual(
    (await f.store.getMessage({ workId: f.work.id, ...f.submission })).execution
      .nativeSelection,
    stored.execution.nativeSelection,
  );
  await assert.rejects(
    freezePaseoSubmission({
      ...f.options,
      submission: {
        ...f.submission,
        context: { ...f.submission.context, time: 1.1 },
      },
    }),
    /different frozen intent/,
  );
  await assert.rejects(
    freezePaseoSubmission({
      ...f.options,
      submission: {
        ...f.submission,
        messageId: randomUUID(),
        profileId: "other-profile",
      },
    }),
    /provider selection changed/,
  );
  await assert.rejects(
    freezePaseoSubmission({
      ...f.options,
      submission: {
        ...f.submission,
        messageId: randomUUID(),
        agentId: "foreign-agent",
      },
    }),
    /does not belong/,
  );
  await assert.rejects(
    freezePaseoSubmission({
      ...f.options,
      submission: {
        ...f.submission,
        messageId: randomUUID(),
        context: { ...f.submission.context, assets: [randomUUID()] },
      },
    }),
    /does not belong/,
  );
});

test("Paseo frozen review survives an expired live session with exact work ownership and immutable snapshot checks", async (t) => {
  const f = await frozenFixture(t);
  await freezePaseoSubmission(f.options);
  const expired = {
    freezeReference: async () => {
      throw Object.assign(Error("Expired"), { statusCode: 410 });
    },
  };
  const options = {
    db: f.db,
    repos: f.repos,
    repo: f.work.repo,
    project: f.work.project,
    context: f.submission.context,
    data: f.data,
    livePreview: expired,
  };
  const reference = await freezeReviewReference(options);
  assert.equal(reference.source, "paseo");
  assert.equal(reference.fingerprint, f.reference.fingerprint);
  await assert.rejects(
    freezeReviewReference({ ...options, repo: randomUUID() }),
    /Expired/,
  );
  await assert.rejects(
    freezeReviewReference({
      ...options,
      context: { ...options.context, draftTask: randomUUID() },
    }),
    /does not belong/,
  );
  await fs.writeFile(
    path.join(f.reference.dir, "scene.ts"),
    "export const tampered=true;",
  );
  await assert.rejects(freezeReviewReference(options), /missing or changed/);
});

test("Work status projects public candidate and native metadata without leaking private run and launch values", async (t) => {
  const f = await fixture(t);
  await f.workService.prepare(f.work.id);
  const binding = await f.store.getWork(f.work.id);
  const candidate = await f.store.createCandidate({
    workId: f.work.id,
    repo: f.work.repo,
    project: f.work.project,
    generation: binding.generation,
    revision: binding.draftRevision,
    runId: randomUUID(),
    baselineFingerprint: binding.baselineFingerprint,
    baselineModeFingerprint: binding.baselineModeFingerprint,
    baselineCommit: null,
    snapshotFingerprint: binding.baselineFingerprint,
    snapshotModeFingerprint: binding.draftRevision,
    runtimeFingerprint: sha("d"),
    origin: "manual",
  });
  await f.store.transitionCandidate(candidate.candidate.id, {
    from: ["queued_validation"],
    state: "validating",
  });
  await f.store.transitionCandidate(candidate.candidate.id, {
    from: ["validating"],
    state: "verified",
    patch: {
      result: {
        status: "passed",
        absoluteSource: f.canonical,
        env: { DUMMY_KEY: "private" },
        validation: [{ name: "runtime", status: "passed", durationMs: 2 }],
      },
    },
  });
  f.workService.manager = {
    observe: async () => ({
      state: "ready",
      activeAgents: ["agent-one"],
      activeTerminals: 1,
      endpoint: "http://private:6767",
      env: { DUMMY_KEY: "private" },
    }),
  };
  const status = await f.workService.status(f.work.id);
  assert.equal(status.candidate.state, "verified");
  assert.equal(status.native.activeTerminals, 1);
  assert.doesNotMatch(
    JSON.stringify(status),
    /runId|baselineFingerprint|absoluteSource|endpoint|DUMMY_KEY|private/,
  );
});

test("Live preview selects only this work's stable Paseo draft and leaves the canonical preview selection explicit", async (t) => {
  const f = await fixture(t);
  const { draft } = await f.workService.prepare(f.work.id);
  const live = new LivePreviewSessions({
    ...f,
    sourceResolver: async () => ({ projectDir: draft.projectRoot }),
    bundleFactory: async () => ({ close: async () => {} }),
  });
  t.after(() => live.close());
  assert.equal((await live.source(f.work, null)).projectDir, f.canonical);
  assert.equal((await live.source(f.work, null, "paseo")).source, "paseo");
  const link = await live.start({
    work: f.work,
    source: "paseo",
    mediaMode: "original",
  });
  assert.equal(link.source, "paseo");
  assert.equal(link.mediaMode, "original");
  live.sourceResolver = async () => ({ projectDir: f.canonical });
  await assert.rejects(
    live.source(f.work, null, "paseo"),
    /Invalid Paseo draft source/,
  );
  await assert.rejects(
    live.start({ work: f.work, source: "paseo", task: randomUUID() }),
    /Invalid live preview source/,
  );
});

test("Native checkout previews isolate agents, re-resolve moved worktrees and freeze their exact source identity", async (t) => {
  const f = await fixture(t);
  const { draft } = await f.workService.prepare(f.work.id);
  const treeRoot = path.join(
    f.data,
    "paseo",
    f.work.id,
    "home/.paseo/worktrees",
  );
  const first = path.join(treeRoot, "first/projects/fixture"),
    second = path.join(treeRoot, "second/projects/fixture");
  for (const dir of [first, second]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(
      path.join(draft.projectRoot, "project.ts"),
      path.join(dir, "project.ts"),
    );
    await fs.writeFile(
      path.join(dir, "scene.ts"),
      "export const checkout=" +
        JSON.stringify(dir === first ? "first" : "second") +
        ";",
    );
  }
  let selected = first;
  const live = new LivePreviewSessions({
    ...f,
    maxSessions: 8,
    sourceResolver: async (_work, { agentId }) => ({
      projectDir: agentId ? selected : draft.projectRoot,
      agentId,
    }),
    bundleFactory: async () => ({ close: async () => {} }),
  });
  t.after(() => live.close());
  const main = await live.start({ work: f.work, source: "paseo" });
  const one = await live.start({
    work: f.work,
    source: "paseo",
    paseoAgent: "native-one",
  });
  const two = await live.start({
    work: f.work,
    source: "paseo",
    paseoAgent: "native-two",
  });
  assert.notEqual(main.sessionId, one.sessionId);
  assert.notEqual(one.sessionId, two.sessionId);
  assert.equal(
    (
      await live.start({
        work: f.work,
        source: "paseo",
        paseoAgent: "native-one",
      })
    ).sessionId,
    one.sessionId,
  );
  assert.equal(one.paseoAgent, "native-one");
  const session = live.sessions.get(one.sessionId),
    sourceRevision = sha("f");
  session.sourceSnapshots.set(sourceRevision, {
    codeDir: first,
    entries: [],
    manifest: { revision: 1 },
  });
  const frozen = await live.freezeReference({
    sessionId: one.sessionId,
    sourceRevision,
    repo: f.work.repo,
    project: f.work.project,
  });
  assert.equal(frozen.paseoAgent, "native-one");
  assert.equal(frozen.task, null);
  assert.match(
    await fs.readFile(path.join(frozen.dir, "scene.ts"), "utf8"),
    /first/,
  );
  const reference = await freezeReviewReference({
    db: f.db,
    repos: f.repos,
    data: f.data,
    repo: f.work.repo,
    project: f.work.project,
    livePreview: live,
    context: { time: 0.5, liveSessionId: one.sessionId, sourceRevision },
  });
  assert.equal(reference.paseoAgent, "native-one");
  selected = second;
  assert.notEqual(
    (
      await live.start({
        work: f.work,
        source: "paseo",
        paseoAgent: "native-one",
      })
    ).sessionId,
    one.sessionId,
  );
  selected = f.canonical;
  await assert.rejects(
    live.start({ work: f.work, source: "paseo", paseoAgent: "native-one" }),
    /Invalid Paseo draft source/,
  );
  await assert.rejects(
    live.start({ work: f.work, paseoAgent: "native-one" }),
    /Invalid live preview source/,
  );
  live.sourceResolver = async () => ({ projectDir: first, agentId: "foreign" });
  await assert.rejects(
    live.start({ work: f.work, source: "paseo", paseoAgent: "native-one" }),
    /source identity/,
  );
});
