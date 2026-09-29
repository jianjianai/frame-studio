import path from "node:path";
import { problem } from "./security.mjs";
import { snapshotVersion, versionTree } from "./version-review.mjs";
import { readProject } from "../scripts/project-metadata.mjs";

/** Resolve a viewer's reference against server records, never trust a client-supplied commit for another work. */
export async function freezeReviewReference({ db, repos, repo, project, context }) {
  if (!context || (context.time === undefined && context.start === undefined && !context.shotId)) return null;
  if (!context.previewTask && !context.sourceCommit) return { status: "unversioned" };
  let preview;
  if (context.previewTask) {
    preview = await db.one("SELECT * FROM tasks WHERE id=$1 AND repo=$2 AND project=$3 AND kind='build' AND state='succeeded'", [context.previewTask, repo, project]);
    if (!preview) throw problem(400, "引用的预览不属于当前作品或尚未完成");
  }
  const sourceCommit = preview?.source_commit || context.sourceCommit;
  if (!sourceCommit) throw problem(409, "这个旧预览没有源码版本记录，请更新预览后重新引用");
  if (context.sourceCommit && context.sourceCommit !== sourceCommit)
    throw Object.assign(problem(409, "引用的预览与源码版本不匹配，请重新选择片段"), { code: "REVIEW_REFERENCE_MISMATCH", recovery: "refresh-preview" });
  await versionTree(repos, { repo, project }, sourceCommit);
  return {
    status: "versioned", sourceCommit,
    ...(preview ? { previewTask: preview.id, fingerprint: preview.fingerprint || null, runtimeFingerprint: preview.result?.runtimeFingerprint || null } : {}),
    ...(context.shotId ? { shotId: context.shotId } : {}),
  };
}

/** Keep old timecodes attached to old source. The AI receives both versions and must compare, not silently reinterpret. */
export async function prepareReviewReference({ repos, task, run, sourceCommit, fingerprint }) {
  const reference = task.review_reference;
  if (!reference || reference.status !== "versioned")
    return reference ? { ...reference, disposition: "unversioned", executionCommit: sourceCommit } : null;
  const current = reference.sourceCommit === sourceCommit || (reference.fingerprint && reference.fingerprint === fingerprint);
  const folder = current ? path.join(run, "projects", task.project) : path.join(run, "review", "reference", "projects", task.project);
  if (!current) await snapshotVersion(repos, task, reference.sourceCommit, folder);
  const meta = readProject(path.join(folder, "project.ts")).meta;
  const context = task.input.context || {};
  if ((context.time ?? 0) > meta.duration || (context.end ?? 0) > meta.duration)
    throw Object.assign(problem(400, "引用时间超出了所选版本的片长"), { code: "REVIEW_RANGE_INVALID", recovery: "select-range" });
  if (reference.shotId && !meta.beats?.some(beat => beat.id === reference.shotId))
    throw problem(400, "引用镜头不存在于所选版本");
  return { ...reference, executionCommit: sourceCommit, disposition: current ? "current" : "compare-to-latest",
    path: current ? `projects/${task.project}` : `review/reference/projects/${task.project}` };
}
