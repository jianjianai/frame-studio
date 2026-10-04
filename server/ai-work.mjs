import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FrameFreezeInputSchema, FrameFreezeResponseSchema } from "../integrations/t3-code/shared/bridge.mjs";
import { exists, treeHash } from "./project-files.mjs";
import { hash, problem } from "./security.mjs";
import { freezeReviewReference } from "./review-reference.mjs";
import { exportAiReference } from "./ai-references.mjs";
import { publicText } from "./public-data.mjs";
import { linkSharedRuntime, sharedRuntimeNames } from "../scripts/shared-runtime.mjs";
import { command } from "./process.mjs";

const coreRoot = fileURLToPath(new URL("../", import.meta.url));
/** Install only shared core links. The existing source tree and Git index stay authoritative. */
export async function prepareAiRuntime({ db, workspaceRoot, repo, runCommand = command,
  core = process.env.FRAME_SHARED_RUNTIME_ROOT || coreRoot }) {
  return db.lock("git-layout:" + repo, async () => {
    const common = (await runCommand("git", ["rev-parse", "--git-common-dir"], { cwd: workspaceRoot, timeout: 10000 })).trim();
    const gitCommon = path.resolve(workspaceRoot, common);
    linkSharedRuntime(workspaceRoot, core, { mutableIndex: true });
    const excludes = path.join(gitCommon, "info/exclude");
    await fs.mkdir(path.dirname(excludes), { recursive: true });
    const previous = await fs.readFile(excludes, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return ""; });
    const existing = new Set(previous.split(/\r?\n/)), required = [];
    for (const name of sharedRuntimeNames) if (await exists(path.join(core, name)) && !existing.has("/" + name)) required.push("/" + name);
    if (required.length) await fs.appendFile(excludes, (previous && !previous.endsWith("\n") ? "\n" : "") + required.join("\n") + "\n");
    return { gitCommon };
  });
}

/** Stable identity for JSON intents, independent of object insertion order. */
export function aiIntentHash(value) {
  const parsed = z.json().parse(JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item) || ["bigint", "function", "symbol"].includes(typeof item))
      throw Error("Frozen intent must contain finite JSON values");
    return item;
  })));
  return hash(JSON.stringify(parsed, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));
}

/** Canonical source is the existing work checkout, never a native UI worktree or a copied draft. */
export async function prepareAiWorkspace({ data, work, source, signal }) {
  signal?.throwIfAborted();
  const projectRoot = path.resolve(source);
  if (!(await exists(path.join(projectRoot, "project.ts")))) throw problem(409, "作品工作区尚未准备完成");
  return { base: path.join(data, "ai", work.id), workspaceRoot: path.dirname(path.dirname(projectRoot)), projectRoot };
}
export const aiPublicValidation = report => report && ({ id: report.id, state: report.state,
  revision: report.revision, runtimeFingerprint: report.runtimeFingerprint,
  error: report.error ? publicText(report.error, { limit: 2000 }) : null,
  created: report.created, updated: report.updated,
  checks: (report.result?.validation || []).map(({ name, status, durationMs }) => ({ name, status,
    ...(Number.isFinite(durationMs) ? { durationMs } : {}) })) });
export const aiPublicNative = native => ({ state: native?.state || "cold",
  activeThreads: (native?.activeThreads || []).filter(id => typeof id === "string"),
  activeTerminals: Math.max(0, Number(native?.activeTerminals || 0)),
  pendingPermissions: Math.max(0, Number(native?.pendingPermissions || 0)),
  incomplete: !!native?.incomplete, ...(native?.checkedAt ? { checkedAt: native.checkedAt } : {}) });
const publicReview = reference => reference && Object.fromEntries([
  "status", "mode", "sourceRevision", "compiledRevision", "sourceCommit", "liveSessionId", "fingerprint", "shotId",
].filter(key => reference[key] !== undefined).map(key => [key, reference[key]]));

/** FRAME freezes references before native dispatch; T3 retains its own durable command receipts. */
export async function freezeAiSubmission({ work, submission, db, repos, data, livePreview, store, authorizeThread }) {
  const request = FrameFreezeInputSchema.parse(submission), intentHash = aiIntentHash(request);
  const key = { workId: work.id, threadId: request.threadId, messageId: request.messageId };
  const previous = await store.getMessageById({ workId: work.id, messageId: request.messageId });
  if (!authorizeThread) throw problem(503, "原生聊天所属作品验证暂不可用");
  // Ownership is checked on replay as well: a moved native thread cannot access its old work through a stale iframe.
  const thread = await authorizeThread(work, request.threadId, { nativeProjectId: request.nativeProjectId, cwd: request.cwd });
  if (!thread || thread.id !== request.threadId) throw problem(404, "原生聊天不属于当前作品");
  if (previous) {
    if (previous.threadId !== request.threadId || previous.intentHash !== intentHash)
      throw problem(409, "消息 ID 已冻结为另一个提交，请刷新后重试");
    await exportAiReference({ data, work, ...key, intentHash, reference: previous.reviewReference,
      materials: previous.reviewReference?.materials || [], repos });
    return previous.envelope;
  }
  const context = request.reference || {};
  const reviewReference = await freezeReviewReference({ db, repos, repo: work.repo, project: work.project, context, livePreview, data });
  const materials = [];
  // The bounded selected set is validated again transactionally when its retaining foreign keys are inserted.
  for (const id of context.assets || []) {
    const asset = await db.one("SELECT a.name,a.sha,a.bytes,a.mime FROM assets a JOIN asset_repos r ON r.asset=a.id WHERE a.id=$1 AND r.repo=$2 AND NOT a.deleted", [id, work.repo]);
    if (!asset) throw problem(400, "引用素材已删除或不属于当前作品仓库");
    const paths = await db.all("SELECT path FROM asset_refs WHERE asset=$1 AND repo=$2 AND project=$3 ORDER BY path", [id, work.repo, work.project]);
    materials.push({ id, name: asset.name, sha256: asset.sha, bytes: String(asset.bytes), mimeType: asset.mime, paths: paths.map(row => row.path) });
  }
  await exportAiReference({ data, work, ...key, intentHash, reference: reviewReference, repos, materials });
  const reference = publicReview(reviewReference) || { status: "unversioned" };
  const referenceRoot = path.join(data, "ai", work.id, "references");
  const attachment = Object.keys(context).length ? { type: "text", mimeType: "text/plain", title: "FRAME work reference",
    text: ["FRAME work: " + work.project + " (" + work.id + ").",
      "This reference was frozen at submission. Compare it with current source before interpreting these timecodes.",
      JSON.stringify({ context, reference, materials }),
      "Frozen source: " + referenceRoot + "/messages/" + request.messageId + "/source; manifest: " + referenceRoot + "/messages/" + request.messageId + "/manifest.json.",
      "Use node scripts/work-tool.mjs context and capabilities for the authoritative project entrypoints. Only edit projects/" + work.project + "/.",
    ].join("\n") } : undefined;
  const envelope = FrameFreezeResponseSchema.parse(JSON.parse(JSON.stringify({ version: 1, ...key, intentHash, context,
    reviewReference: reference, attachment })));
  const saved = await store.freezeMessage({ ...key, intentHash, envelope,
    reviewReference: { ...(reviewReference || { status: "unversioned" }), materials },
    execution: { version: 1, nativeSelection: request.selection } });
  return saved.message.envelope;
}

export class AiWork {
  constructor(options) { Object.assign(this, options); this.preparing = new Map(); }
  async resolve(workId, { signal, binding } = {}) {
    signal?.throwIfAborted();
    const [work, current] = await Promise.all([this.works.get(workId, { active: true }), binding ? Promise.resolve(binding) : this.store.getWork(workId)]);
    if (!current) return null;
    if (current.repo !== work.repo || current.project !== work.project) throw problem(409, "作品身份发生变化");
    const { dir } = await this.repos.project(work.repo, work.project);
    return { work, workspace: await prepareAiWorkspace({ data: this.data, work, source: dir, signal }), binding: current };
  }
  async prepare(workId, { signal } = {}) {
    const existing = await this.resolve(workId, { signal });
    if (existing) return existing;
    if (this.preparing.has(workId)) return this.preparing.get(workId);
    const prepare = async () => {
      const work = await this.works.get(workId, { active: true });
      const { dir } = await this.repos.project(work.repo, work.project);
      const workspace = await prepareAiWorkspace({ data: this.data, work, source: dir, signal });
      const binding = await this.store.ensureWork({ workId, repo: work.repo, project: work.project,
        revision: await treeHash(dir, { includeExecutableMode: true }) });
      return { work, workspace, binding };
    };
    const operation = this.db?.lock ? this.db.lock("ai-workspace:" + workId, prepare) : prepare();
    this.preparing.set(workId, operation);
    try { return await operation; } finally { if (this.preparing.get(workId) === operation) this.preparing.delete(workId); }
  }
  async freeze(workId, submission) {
    return freezeAiSubmission({ ...this, work: await this.works.get(workId, { active: true }), submission });
  }
  async status(workId) {
    await this.works.get(workId, { active: true });
    const [native, reports, prepared] = await Promise.all([this.manager.observe(workId), this.store.listValidations(workId, { limit: 1 }), this.prepare(workId)]);
    const { binding } = prepared, validation = aiPublicValidation(reports[0]);
    if (validation && (validation.revision !== binding.revision || binding.runtimeFingerprint && validation.runtimeFingerprint !== binding.runtimeFingerprint)) validation.state = "stale";
    return { version: 2, workId, native: aiPublicNative(native), sourceRevision: binding.revision,
      updated: binding.updated, generation: String(binding.generation || "0"), validation };
  }
}
