import path from "node:path";
import fs from "node:fs";
import { confinedAsync, copyTree, treeHash } from "./project-files.mjs";
import { problem } from "./security.mjs";
import { snapshotVersion, versionTree } from "./version-review.mjs";
import { readProject } from "../scripts/project-metadata.mjs";

/** Resolve a viewer's reference against server records, never trust a client-supplied commit for another work. */
export async function freezeReviewReference({
  db,
  repos,
  repo,
  project,
  context,
  livePreview,
  data,
}) {
  if (
    !context ||
    (context.time === undefined &&
      context.start === undefined &&
      !context.shotId)
  )
    return null;
  if (context.liveSessionId) {
    if (!livePreview || !data)
      throw problem(503, "Live review references are unavailable");
    let frozen;
    try {
      frozen = await livePreview.freezeReference({
        sessionId: context.liveSessionId,
        sourceRevision: context.sourceRevision,
        repo,
        project,
      });
    } catch (error) {
      if (![404, 410].includes(error.statusCode)) throw error;
      const saved = await savedLiveReviewReference({
        db,
        data,
        repo,
        project,
        context,
      });
      if (!saved) throw error;
      frozen = saved;
    }
    if (context.draftTask && frozen.task !== context.draftTask)
      throw problem(
        400,
        "Live review draft does not belong to this preview session",
      );
    if (!context.draftTask && frozen.source === "task")
      throw problem(400, "Live draft review must identify its task");
    const expected = path.join(
      data,
      "live-preview-references",
      context.liveSessionId,
      context.sourceRevision,
      "projects",
      project,
    );
    if (path.resolve(frozen.dir) !== path.resolve(expected))
      throw problem(500, "Invalid live review snapshot");
    return {
      status: "versioned",
      mode: "live",
      sourceRevision: frozen.sourceRevision,
      source: frozen.source,
      liveSessionId: frozen.sessionId,
      fingerprint: frozen.fingerprint,
      snapshotPath: path.relative(data, frozen.dir).replaceAll("\\", "/"),
      ...(context.draftTask ? { draftTask: context.draftTask } : {}),
      ...(context.shotId ? { shotId: context.shotId } : {}),
    };
  }
  if (!context.previewTask && !context.sourceCommit)
    return { status: "unversioned" };
  let preview;
  if (context.previewTask) {
    preview = await db.one(
      "SELECT * FROM tasks WHERE id=$1 AND repo=$2 AND project=$3 AND kind='build' AND state='succeeded'",
      [context.previewTask, repo, project],
    );
    if (!preview) throw problem(400, "引用的预览不属于当前作品或尚未完成");
  }
  const sourceCommit = preview?.source_commit || context.sourceCommit;
  if (!sourceCommit)
    throw problem(409, "这个旧预览没有源码版本记录，请更新预览后重新引用");
  if (context.sourceCommit && context.sourceCommit !== sourceCommit)
    throw Object.assign(
      problem(409, "引用的预览与源码版本不匹配，请重新选择片段"),
      { code: "REVIEW_REFERENCE_MISMATCH", recovery: "refresh-preview" },
    );
  await versionTree(repos, { repo, project }, sourceCommit);
  return {
    status: "versioned",
    sourceCommit,
    ...(preview
      ? {
          previewTask: preview.id,
          fingerprint: preview.fingerprint || null,
          runtimeFingerprint: preview.result?.runtimeFingerprint || null,
        }
      : {}),
    ...(context.shotId ? { shotId: context.shotId } : {}),
  };
}

/** A persisted task authenticates a frozen reference after its ephemeral session disappears. */
async function savedLiveReviewReference({ db, data, repo, project, context }) {
  const row = await db.one(
    "SELECT review_reference FROM tasks WHERE repo=$1 AND project=$2 AND cleaned IS NULL AND review_reference->>'status'='versioned' AND review_reference->>'mode'='live' AND review_reference->>'liveSessionId'=$3 AND review_reference->>'sourceRevision'=$4 AND (state IN ('queued','running','cancelling','publishing','publish_failed') OR expires>now()) ORDER BY created DESC LIMIT 1",
    [repo, project, context.liveSessionId, context.sourceRevision],
  );
  const reference = row?.review_reference;
  if (!reference) return null;
  if (
    reference.status !== "versioned" ||
    reference.mode !== "live" ||
    reference.liveSessionId !== context.liveSessionId ||
    reference.sourceRevision !== context.sourceRevision ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      reference.liveSessionId,
    ) ||
    !/^[0-9a-f]{64}$/.test(reference.sourceRevision) ||
    !/^[0-9a-f]{64}$/.test(reference.fingerprint || "") ||
    !["work", "task"].includes(reference.source)
  )
    throw problem(400, "Invalid saved live review source");
  if (
    (reference.source === "task" &&
      (!reference.draftTask || !context.draftTask)) ||
    (reference.draftTask || undefined) !== context.draftTask ||
    (reference.source === "work" && reference.draftTask)
  )
    throw problem(
      400,
      "Live review draft does not belong to this preview session",
    );
  const expected =
    "live-preview-references/" +
    reference.liveSessionId +
    "/" +
    reference.sourceRevision +
    "/projects/" +
    project;
  if (reference.snapshotPath !== expected)
    throw problem(400, "Invalid saved live review source");
  const dir = await confinedAsync(data, expected);
  if (
    !fs.existsSync(dir) ||
    (await treeHash(dir, { includeIgnored: true })) !== reference.fingerprint
  )
    throw problem(
      409,
      "Live review snapshot is missing or changed; select the scene again",
    );
  return {
    dir,
    fingerprint: reference.fingerprint,
    sourceRevision: reference.sourceRevision,
    sessionId: reference.liveSessionId,
    source: reference.source,
    task: reference.draftTask || null,
  };
}

/** Keep old timecodes attached to old source. The AI receives both versions and must compare, not silently reinterpret. */
export async function prepareReviewReference({
  repos,
  task,
  run,
  sourceCommit,
  fingerprint,
  data = repos.data,
}) {
  const reference = task.review_reference;
  if (!reference || reference.status !== "versioned")
    return reference
      ? {
          ...reference,
          disposition: "unversioned",
          executionCommit: sourceCommit,
        }
      : null;
  const current =
    (reference.mode !== "live" &&
      reference.sourceCommit &&
      reference.sourceCommit === sourceCommit) ||
    (reference.fingerprint && reference.fingerprint === fingerprint);
  const folder = current
    ? path.join(run, "projects", task.project)
    : path.join(run, "review", "reference", "projects", task.project);
  if (!current) {
    if (reference.mode === "live") {
      const expected =
        "live-preview-references/" +
        reference.liveSessionId +
        "/" +
        reference.sourceRevision +
        "/projects/" +
        task.project;
      if (!data || reference.snapshotPath !== expected)
        throw problem(400, "Invalid live review source");
      const source = await confinedAsync(data, expected);
      if (
        !fs.existsSync(source) ||
        (await treeHash(source, { includeIgnored: true })) !==
          reference.fingerprint
      )
        throw problem(
          409,
          "Live review snapshot is missing or changed; select the scene again",
        );
      await copyTree(source, folder, { includeIgnored: true });
      if (
        (await treeHash(folder, { includeIgnored: true })) !==
        reference.fingerprint
      )
        throw problem(
          409,
          "Live review snapshot changed while preparing the task",
        );
    } else await snapshotVersion(repos, task, reference.sourceCommit, folder);
  }
  const meta = readProject(path.join(folder, "project.ts")).meta;
  const context = task.input.context || {};
  if ((context.time ?? 0) > meta.duration || (context.end ?? 0) > meta.duration)
    throw Object.assign(problem(400, "引用时间超出了所选版本的片长"), {
      code: "REVIEW_RANGE_INVALID",
      recovery: "select-range",
    });
  if (
    reference.shotId &&
    !meta.beats?.some((beat) => beat.id === reference.shotId)
  )
    throw problem(400, "引用镜头不存在于所选版本");
  return {
    ...reference,
    executionCommit: sourceCommit,
    disposition: current ? "current" : "compare-to-latest",
    path: current
      ? `projects/${task.project}`
      : `review/reference/projects/${task.project}`,
  };
}
