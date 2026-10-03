import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FrameFreezeInputSchema,
  FrameFreezeResponseSchema,
} from "../integrations/paseo/frame-plugin/shared/bridge.mjs";
import { confinedAsync, exists, treeHash } from "./project-files.mjs";
import { hash, problem } from "./security.mjs";
import { freezePaseoExecution } from "./paseo-selection.mjs";
import { freezeReviewReference } from "./review-reference.mjs";
import { exportPaseoReference } from "./paseo-references.mjs";
import { publicText } from "./public-data.mjs";

const uuid = z.string().uuid();
const projectId = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(64);
/** Same identity for different object key insertion orders; reject non-JSON requests. */
export function paseoIntentHash(value) {
  const parsed = z.json().parse(
    JSON.parse(
      JSON.stringify(value, (_key, item) => {
        if (typeof item === "number" && !Number.isFinite(item))
          throw Error("Frozen intent must contain finite JSON numbers");
        if (
          typeof item === "bigint" ||
          typeof item === "function" ||
          typeof item === "symbol"
        )
          throw Error("Frozen intent must contain JSON values");
        return item;
      }),
    ),
  );
  return hash(
    JSON.stringify(parsed, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
          )
        : item,
    ),
  );
}

async function workspaceRecord({ data, work, source, signal }) {
  uuid.parse(work.id);
  projectId.parse(work.project);
  signal?.throwIfAborted();
  const projectRoot = path.resolve(source);
  if (!(await exists(path.join(projectRoot, "project.ts"))))
    throw problem(409, "作品工作区尚未准备完成");
  const base = await confinedAsync(data, "paseo/" + work.id);
  const marker = await confinedAsync(base, "workspace.json");
  const record = await fs.readFile(marker, "utf8").then(JSON.parse).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (record && (record.version !== 2 || record.workId !== work.id || record.project !== work.project || record.projectRoot !== projectRoot))
    throw problem(409, "作品工作区身份发生变化，请先检查保留的源码");
  return { base, marker, projectRoot, record };
}
const workspaceDTO = ({ base, projectRoot, record }) => ({ base,
  workspaceRoot: path.dirname(path.dirname(projectRoot)), projectRoot, migration: record.migration });

/** Read an existing workspace without advisory locks, directory writes or revision scans. */
export async function readPaseoWorkspace(options) {
  const stored = await workspaceRecord(options);
  return stored.record ? workspaceDTO(stored) : null;
}

/** The repository checkout is the only editable source. Paseo owns private runtime state only. */
export async function preparePaseoWorkspace(options) {
  const { work, signal } = options;
  const stored = await workspaceRecord(options), { base, marker, projectRoot } = stored;
  let { record } = stored;
  if (!record) {
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    // Existing source is never overwritten. Differing historical drafts remain recoverable and visible.
    const legacy = await confinedAsync(base, "draft/projects/" + work.project);
    let migration = null;
    if (await exists(legacy)) {
      const [canonicalRevision, legacyRevision] = await Promise.all([
        treeHash(projectRoot, { includeExecutableMode: true }),
        treeHash(legacy, { includeExecutableMode: true }),
      ]);
      migration = { state: canonicalRevision === legacyRevision ? "identical" : "pending",
        canonicalRevision, legacyRevision, retained: "paseo/" + work.id + "/draft/projects/" + work.project };
    }
    const trees = await confinedAsync(base, "home/.paseo/worktrees");
    if (await exists(trees)) {
      const entries = await fs.readdir(trees);
      if (entries.length) migration = { ...migration, state: "pending", retainedWorktrees: entries.length };
    }
    record = { version: 2, workId: work.id, project: work.project, projectRoot, migration };
    const temporary = marker + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, marker);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  signal?.throwIfAborted();
  return workspaceDTO({ base, projectRoot, record });
}

export function paseoPublicValidation(report) {
  if (!report) return null;
  return { id: report.id, state: report.state, revision: report.revision,
    runtimeFingerprint: report.runtimeFingerprint,
    error: report.error ? publicText(report.error, { limit: 2000 }) : null,
    created: report.created, updated: report.updated,
    checks: (report.result?.validation || []).map(({ name, status, durationMs }) => ({ name, status,
      ...(Number.isFinite(durationMs) ? { durationMs } : {}) })) };
}
export function paseoPublicNative(native) {
  return {
    state: native?.state || "cold",
    activeAgents: (native?.activeAgents || []).filter(
      (id) => typeof id === "string",
    ),
    activeTerminals: Math.max(0, Number(native?.activeTerminals || 0)),
    pendingPermissions: Math.max(0, Number(native?.pendingPermissions || 0)),
    scheduled: Math.max(0, Number(native?.scheduled || 0)),
    incomplete: !!native?.incomplete,
    ...(native?.checkedAt ? { checkedAt: native.checkedAt } : {}),
  };
}

const publicReview = (reference) =>
  reference &&
  Object.fromEntries(
    [
      "status",
      "mode",
      "sourceRevision",
      "compiledRevision",
      "sourceCommit",
      "liveSessionId",
      "fingerprint",
      "shotId",
    ]
      .filter((key) => reference[key] !== undefined)
      .map((key) => [key, reference[key]]),
  );

/** Freeze only FRAME context; native Paseo still owns delivery, streams and model execution. */
export async function freezePaseoSubmission({
  work,
  submission,
  db,
  repos,
  data,
  livePreview,
  connections,
  secrets,
  store,
  authorizeAgent,
  resolveSelection,
}) {
  const request = FrameFreezeInputSchema.parse(submission);
  const intentHash = paseoIntentHash(request);
  const key = {
    workId: work.id,
    agentId: request.agentId,
    messageId: request.messageId,
  };
  const previous = await store.getMessageById({
    workId: work.id,
    messageId: request.messageId,
  });
  if (previous && previous.agentId !== request.agentId)
    throw problem(409, "Paseo message ID belongs to another agent");
  if (previous) {
    if (previous.intentHash !== intentHash)
      throw problem(
        409,
        "Paseo message ID already has a different frozen intent",
      );
    await exportPaseoReference({
      data,
      work,
      agentId: request.agentId,
      messageId: request.messageId,
      intentHash,
      reference: previous.reviewReference,
      materials: previous.reviewReference?.materials || [],
      repos,
    });
    return previous.envelope;
  }
  if (!authorizeAgent)
    throw problem(503, "Paseo agent ownership verification unavailable");
  const agent = await authorizeAgent(work, request.agentId);
  if (!agent || agent.id !== request.agentId)
    throw problem(404, "Paseo agent does not belong to this work");
  const profile = request.profileId || agent.provider;
  if (profile !== agent.provider)
    throw problem(409, "Paseo provider selection changed before submit");
  if (
    request.model !== null &&
    agent.model !== undefined &&
    request.model !== agent.model
  )
    throw problem(409, "Paseo model selection changed before submit");
  let execution;
  if (resolveSelection)
    execution = await resolveSelection({ work, agent, request });
  else {
    const match = /^frame-([0-9a-f-]{36})$/i.exec(profile || "");
    if (match) {
      uuid.parse(match[1]);
      const config = await connections.resolve(match[1]);
      execution = await freezePaseoExecution({ db, connections, secrets,
        connection: match[1], config, model: request.model ?? agent.model });
    } else
      execution = {
        schema: 1,
        provider: profile,
        model: request.model ?? agent.model ?? "",
        authMode: "paseo",
      };
  }
  execution = {
    ...execution,
    nativeSelection: {
      provider: agent.provider,
      model: agent.model ?? null,
    },
  };
  const reviewReference = await freezeReviewReference({
    db,
    repos,
    repo: work.repo,
    project: work.project,
    context: request.context,
    livePreview,
    data,
  });
  const materials = [];
  for (const id of request.context?.assets || []) {
    const asset = await db.one(
      "SELECT a.name,a.sha,a.bytes,a.mime FROM assets a JOIN asset_repos r ON r.asset=a.id WHERE a.id=$1 AND r.repo=$2 AND NOT a.deleted",
      [id, work.repo],
    );
    if (!asset)
      throw problem(
        400,
        "Referenced asset does not belong to this work repository or was deleted",
      );
    const paths = await db.all(
      "SELECT path FROM asset_refs WHERE asset=$1 AND repo=$2 AND project=$3 ORDER BY path",
      [id, work.repo, work.project],
    );
    materials.push({
      id,
      name: asset.name,
      sha256: asset.sha,
      bytes: String(asset.bytes),
      mimeType: asset.mime,
      paths: paths.map((row) => row.path),
    });
  }
  await exportPaseoReference({
    data,
    work,
    agentId: request.agentId,
    messageId: request.messageId,
    intentHash,
    reference: reviewReference,
    repos,
    materials,
  });
  const reference = publicReview(reviewReference) || { status: "unversioned" };
  const context = request.context;
  const attachment = context
    ? {
        type: "text",
        mimeType: "text/plain",
        title: "FRAME work reference",
        text: [
          "FRAME work: " + work.project + " (" + work.id + ").",
          "The following reference was frozen when this message was submitted. Compare it with current source; do not reinterpret old timecodes against a newer workspace revision.",
          JSON.stringify({ context, reference, materials }),
          "Frozen source: /frame-references/messages/" +
            request.messageId +
            "/source; manifest: /frame-references/messages/" +
            request.messageId +
            "/manifest.json.",
          "Use $FRAME_REFERENCE_ROOT/messages/" +
            request.messageId +
            "/source on local environments. The manifest records exact material SHA-256 and project paths; large media is retained by FRAME and is not copied into this code-only folder.",
          "Use node scripts/work-tool.mjs context and capabilities for current authoritative entrypoints. Compare frozen source with projects/" +
            work.project +
            "/ and only edit this current project.",
        ].join("\n"),
      }
    : undefined;
  const envelope = FrameFreezeResponseSchema.parse(
    JSON.parse(
      JSON.stringify({
        version: 1,
        ...key,
        intentHash,
        context,
        reviewReference: reference,
        attachment,
      }),
    ),
  );
  const saved = await store.freezeMessage({
    ...key,
    intentHash,
    envelope,
    reviewReference: {
      ...(reviewReference || { status: "unversioned" }),
      materials,
    },
    execution,
  });
  const message = saved.message || saved;
  if (message.intentHash !== intentHash)
    throw problem(
      409,
      "Paseo message ID already has a different frozen intent",
    );
  return message.envelope;
}

export class PaseoWork {
  constructor(options) {
    Object.assign(this, options);
    this.preparing = new Map();
  }
  async resolve(workId, { signal, binding } = {}) {
    signal?.throwIfAborted();
    const [work, current] = await Promise.all([
      this.works.get(workId, { active: true }), binding ? Promise.resolve(binding) : this.store.getWork(workId),
    ]);
    if (!current) return null;
    if (current.repo !== work.repo || current.project !== work.project)
      throw problem(409, "Paseo work identity changed");
    const { dir } = await this.repos.project(work.repo, work.project);
    const workspace = await readPaseoWorkspace({ data: this.data, work, source: dir, signal });
    return workspace ? { work, workspace, binding: current } : null;
  }
  async prepare(workId, { signal } = {}) {
    const existing = await this.resolve(workId, { signal });
    if (existing) return existing;
    if (this.preparing.has(workId)) return this.preparing.get(workId);
    const prepare = async () => {
      const work = await this.works.get(workId, { active: true });
      const { dir } = await this.repos.project(work.repo, work.project);
      const workspace = await preparePaseoWorkspace({ data: this.data, work, source: dir, signal });
      let binding = await this.store.getWork(workId);
      if (!binding) binding = await this.store.ensureWork({ workId, repo: work.repo, project: work.project,
        revision: await treeHash(dir, { includeExecutableMode: true }) });
      if (binding.repo !== work.repo || binding.project !== work.project)
        throw problem(409, "Paseo work identity changed");
      return { work, workspace, binding };
    };
    const operation = this.db?.lock ? this.db.lock("paseo-workspace:" + workId, prepare) : prepare();
    this.preparing.set(workId, operation);
    try { return await operation; }
    finally { if (this.preparing.get(workId) === operation) this.preparing.delete(workId); }
  }
  async freeze(workId, submission) {
    const work = await this.works.get(workId, { active: true });
    return freezePaseoSubmission({ ...this, work, submission });
  }
  async status(workId) {
    await this.works.get(workId, { active: true });
    const [native, validations, prepared] = await Promise.all([
      this.manager.observe(workId),
      this.store.listValidations(workId, { limit: 1 }), this.prepare(workId),
    ]);
    const binding = prepared.binding, validation = paseoPublicValidation(validations[0]);
    if (validation && (validation.revision !== binding.revision ||
      binding.runtimeFingerprint && validation.runtimeFingerprint !== binding.runtimeFingerprint)) validation.state = "stale";
    return { version: 2, workId, native: paseoPublicNative(native),
      sourceRevision: binding?.revision || null, updated: binding?.updated || null, generation: String(binding?.generation || "0"),
      validation, migration: prepared.workspace.migration };
  }
}
