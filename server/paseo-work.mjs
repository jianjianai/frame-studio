import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FrameFreezeInputSchema,
  FrameFreezeResponseSchema,
} from "../integrations/paseo/frame-plugin/shared/bridge.mjs";
import { confinedAsync, copyTree, exists, treeHash } from "./project-files.mjs";
import { hash, problem } from "./security.mjs";
import { freezePaseoExecution } from "./paseo-selection.mjs";
import { freezeReviewReference } from "./review-reference.mjs";
import { exportPaseoReference } from "./paseo-references.mjs";
import {
  paseoLegacyChats,
  paseoLegacyHistory,
  paseoLegacyImportDescriptor,
} from "./paseo-history.mjs";
import { publicAgentText } from "./agent-public-data.mjs";

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

export async function paseoPaths(data, workId, project) {
  uuid.parse(workId);
  projectId.parse(project);
  const base = await confinedAsync(data, "paseo/" + workId);
  return {
    base,
    draftRoot: await confinedAsync(data, "paseo/" + workId + "/draft"),
    projectRoot: await confinedAsync(
      data,
      "paseo/" + workId + "/draft/projects/" + project,
    ),
    preparation: await confinedAsync(
      data,
      "paseo/" + workId + "/prepared.json",
    ),
  };
}

async function atomicJson(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
}

/** Only initial preparation writes a draft; reopening never discards agent or terminal edits. */
async function prepareDraft({
  data,
  work,
  source,
  expectedFingerprint,
  signal,
}) {
  const paths = await paseoPaths(data, work.id, work.project);
  signal?.throwIfAborted();
  await fs.mkdir(paths.base, { recursive: true, mode: 0o700 });
  await paseoPaths(data, work.id, work.project); // Recheck after creating ancestors.
  if (await exists(paths.draftRoot)) {
    if (!(await exists(path.join(paths.projectRoot, "project.ts"))))
      throw problem(
        409,
        "Paseo draft preparation is incomplete; retained for recovery",
      );
    if (!(await exists(paths.preparation)))
      throw problem(
        409,
        "Paseo draft has no trusted preparation record; retained for recovery",
      );
    const prepared = JSON.parse(await fs.readFile(paths.preparation, "utf8"));
    if (
      prepared.version !== 1 ||
      prepared.workId !== work.id ||
      prepared.project !== work.project
    )
      throw problem(409, "Paseo draft preparation identity changed");
    return {
      ...paths,
      ...prepared,
      created: false,
      draftRevision: await treeHash(paths.projectRoot, {
        includeExecutableMode: true,
      }),
    };
  }
  const fingerprint = await treeHash(source);
  if (expectedFingerprint && fingerprint !== expectedFingerprint)
    throw problem(409, "Work changed before Paseo draft preparation");
  const modeFingerprint = await treeHash(source, {
    includeExecutableMode: true,
  });
  const stageName = "draft-" + randomUUID() + ".pending";
  const stage = await confinedAsync(data, "paseo/" + work.id + "/" + stageName);
  try {
    await fs.mkdir(path.join(stage, "projects"), {
      recursive: true,
      mode: 0o700,
    });
    await copyTree(source, path.join(stage, "projects", work.project));
    signal?.throwIfAborted();
    if (
      (await treeHash(source)) !== fingerprint ||
      (await treeHash(path.join(stage, "projects", work.project))) !==
        fingerprint ||
      (await treeHash(source, { includeExecutableMode: true })) !==
        modeFingerprint ||
      (await treeHash(path.join(stage, "projects", work.project), {
        includeExecutableMode: true,
      })) !== modeFingerprint
    )
      throw problem(409, "Work changed while preparing Paseo draft");
    const prepared = {
      version: 1,
      workId: work.id,
      project: work.project,
      baselineFingerprint: fingerprint,
      baselineModeFingerprint: modeFingerprint,
    };
    // The record lives outside /workspace and is not writable by the sandbox.
    await atomicJson(paths.preparation, prepared);
    await fs.rename(stage, paths.draftRoot);
    return {
      ...paths,
      ...prepared,
      created: true,
      draftRevision: modeFingerprint,
    };
  } finally {
    // This exact UUID stage is owned by this call; never remove a stable draft.
    await fs.rm(stage, { recursive: true, force: true });
  }
}

const preparations = new Map();
export async function preparePaseoDraft(options) {
  const key = path.resolve(options.data) + ":" + uuid.parse(options.work.id);
  const previous = preparations.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => prepareDraft(options));
  preparations.set(key, pending);
  try {
    return await pending;
  } finally {
    if (preparations.get(key) === pending) preparations.delete(key);
  }
}

export function paseoPublicCandidate(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id,
    state: candidate.state,
    generation: String(candidate.generation),
    revision: candidate.revision,
    error: candidate.error
      ? publicAgentText(candidate.error, { limit: 2000 })
      : null,
    sourceRevision: candidate.sourceRevision || null,
    commit: candidate.commit || null,
    created: candidate.created,
    updated: candidate.updated,
    validation: (candidate.result?.validation || []).map(
      ({ name, status, durationMs }) => ({
        name,
        status,
        ...(Number.isFinite(durationMs) ? { durationMs } : {}),
      }),
    ),
  };
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
      "sourceCommit",
      "liveSessionId",
      "draftTask",
      "fingerprint",
      "shotId",
      "paseoAgent",
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
          "The following reference was frozen when this message was submitted. Compare it with current source; do not reinterpret old timecodes against a newer draft.",
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
  }
  async prepare(workId, { signal } = {}) {
    const prepare = async () => {
      const work = await this.works.get(workId, { active: true });
      const { dir } = await this.repos.project(work.repo, work.project);
      const draft = await preparePaseoDraft({
        data: this.data,
        work,
        source: dir,
        signal,
      });
      const binding = await this.store.ensureWork({
        workId,
        repo: work.repo,
        project: work.project,
        baselineFingerprint: draft.baselineFingerprint,
        baselineModeFingerprint: draft.baselineModeFingerprint,
        draftRevision: draft.draftRevision,
      });
      return { work, draft, binding };
    };
    return this.db?.lock
      ? this.db.lock("paseo-draft:" + workId, prepare)
      : prepare();
  }
  async freeze(workId, submission) {
    const work = await this.works.get(workId, { active: true });
    return freezePaseoSubmission({ ...this, work, submission });
  }
  async legacyChats(workId, options = {}) {
    const work = await this.works.get(workId, { active: true });
    return paseoLegacyChats({ ...this, work, ...options });
  }
  async legacyHistory(workId, chatId, options = {}) {
    const work = await this.works.get(workId, { active: true });
    return paseoLegacyHistory({ ...this, work, chatId, ...options });
  }
  async legacyImportDescriptor(workId, chatId) {
    const work = await this.works.get(workId, { active: true });
    return paseoLegacyImportDescriptor({ ...this, work, chatId });
  }
  async status(workId) {
    await this.works.get(workId, { active: true });
    const [binding, native, candidates] = await Promise.all([
      this.store.getWork(workId),
      this.manager.observe(workId),
      this.store.listCandidates(workId, { limit: 1 }),
    ]);
    return {
      version: 1,
      workId,
      native: paseoPublicNative(native),
      draftRevision: binding?.draftRevision || null,
      generation: String(binding?.generation || "0"),
      candidate: paseoPublicCandidate(candidates[0]),
    };
  }
}
