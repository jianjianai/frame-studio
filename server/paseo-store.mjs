import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { migrate, migrationPlan } from "./migrations.mjs";
import { problem } from "./security.mjs";

const uuid = z.uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z
  .string()
  .regex(/^[a-f0-9]{40}$/)
  .nullable();
const slug = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(64);
const id = z.string().min(1).max(256);
const decimal = z.preprocess(
  (value) =>
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : value,
  z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .refine((value) => BigInt(value) <= 9223372036854775807n),
);
export const paseoRuntimeStates = [
  "cold",
  "starting",
  "ready",
  "stopped",
  "failed",
];
export const paseoCandidateStates = [
  "queued_validation",
  "validating",
  "verified",
  "publishing",
  "applied",
  "invalid",
  "publish_failed",
  "conflict",
  "superseded",
];
const state = z.enum(paseoCandidateStates);
const edges = {
  queued_validation: ["validating", "superseded"],
  validating: ["verified", "invalid", "superseded", "queued_validation"],
  verified: ["publishing", "superseded", "conflict"],
  publishing: ["applied", "publish_failed", "verified"],
  invalid: ["queued_validation", "superseded"],
  publish_failed: ["verified", "superseded", "conflict"],
  conflict: ["superseded"],
  applied: [],
  superseded: [],
};
const planRoot = fileURLToPath(new URL("./paseo-migrations/", import.meta.url));
const json = (value, maximum = 2_100_000) => {
  if (value === undefined || value === null) return null;
  const text = JSON.stringify(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item))
      throw Error("Paseo metadata must contain finite JSON numbers");
    if (
      typeof item === "bigint" ||
      typeof item === "function" ||
      typeof item === "symbol"
    )
      throw Error("Paseo metadata must contain JSON values");
    return item;
  });
  if (typeof text !== "string" || Buffer.byteLength(text) > maximum)
    throw Error("Paseo metadata is too large");
  return z.json().parse(JSON.parse(text));
};
const date = (value) =>
  value == null
    ? null
    : value instanceof Date
      ? value.toISOString()
      : String(value);
const bindingDTO = (row) =>
  row && {
    workId: row.work_id,
    repo: row.repo,
    project: row.project,
    baselineFingerprint: row.baseline_fingerprint,
    baselineModeFingerprint: row.baseline_mode_fingerprint,
    baselineCommit: row.baseline_commit,
    draftRevision: row.draft_revision,
    generation: String(row.generation),
    requested: !!row.requested,
    state: row.state,
    daemonGeneration: String(row.daemon_generation),
    endpoint: row.endpoint,
    container: row.container,
    workspaceId: row.workspace_id,
    serverId: row.server_id,
    runtimeFingerprint: row.runtime_fingerprint,
    image: row.image,
    error: row.error,
    lastObserved: date(row.last_observed),
    nativeSummary:
      typeof row.native_summary === "string"
        ? JSON.parse(row.native_summary)
        : row.native_summary,
    created: date(row.created),
    updated: date(row.updated),
    touched: date(row.touched),
  };
const candidateDTO = (row) =>
  row && {
    id: row.id,
    workId: row.work_id,
    repo: row.repo,
    project: row.project,
    generation: String(row.generation),
    revision: row.revision,
    baselineFingerprint: row.baseline_fingerprint,
    baselineModeFingerprint: row.baseline_mode_fingerprint,
    baselineCommit: row.baseline_commit,
    runId: row.run_id,
    snapshotFingerprint: row.snapshot_fingerprint,
    snapshotModeFingerprint: row.snapshot_mode_fingerprint,
    runtimeFingerprint: row.runtime_fingerprint,
    origin: row.origin,
    state: row.state,
    result:
      typeof row.result === "string" ? JSON.parse(row.result) : row.result,
    error: row.error,
    sourceRevision: row.source_revision,
    commit: row.commit,
    created: date(row.created),
    updated: date(row.updated),
  };
const messageDTO = (row) =>
  row && {
    workId: row.work_id,
    agentId: row.agent_id,
    messageId: row.message_id,
    intentHash: row.intent_hash,
    envelope:
      typeof row.envelope === "string"
        ? JSON.parse(row.envelope)
        : row.envelope,
    reviewReference:
      typeof row.review_reference === "string"
        ? JSON.parse(row.review_reference)
        : row.review_reference,
    execution:
      typeof row.execution === "string"
        ? JSON.parse(row.execution)
        : row.execution,
    created: date(row.created),
  };

const runtimeInput = z.strictObject({
  state: z.enum(paseoRuntimeStates).optional(),
  requested: z.boolean().optional(),
  daemonGeneration: decimal.optional(),
  endpoint: z.url().nullable().optional(),
  container: z.string().max(256).nullable().optional(),
  workspaceId: z.string().max(4096).nullable().optional(),
  serverId: id.nullable().optional(),
  runtimeFingerprint: sha.nullable().optional(),
  image: z.string().max(4096).nullable().optional(),
  error: z.string().max(2000).nullable().optional(),
  lastObserved: z
    .preprocess(date, z.iso.datetime({ offset: true }).nullable())
    .optional(),
  nativeSummary: z.json().nullable().optional(),
});
const runtimeColumns = {
  state: "state",
  requested: "requested",
  daemonGeneration: "daemon_generation",
  endpoint: "endpoint",
  container: "container",
  workspaceId: "workspace_id",
  serverId: "server_id",
  runtimeFingerprint: "runtime_fingerprint",
  image: "image",
  error: "error",
  lastObserved: "last_observed",
  nativeSummary: "native_summary",
};

/** Separate additive ledger lets an 8.1 application reopen the same core database. */
export async function migratePaseo(db, plan = migrationPlan(planRoot)) {
  const options = { ledger: "paseo_schema_migrations" };
  if (db.kind === "sqlite") {
    const { sqliteMigration } = await import("./sqlite.mjs");
    options.dialect = "sqlite";
    options.transformSql = sqliteMigration;
  }
  await migrate(db.pool, plan, options);
}

/** Private DTOs: only the gateway's explicit projections may leave the server. */
export class PaseoStore {
  constructor({ db }) {
    this.db = db;
  }
  async initialize() {
    await migratePaseo(this.db);
    return this;
  }
  async transaction(callback) {
    const client = await this.db.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      throw error;
    } finally {
      client.release(broken);
    }
  }
  async ensureWork(input) {
    const value = z
      .strictObject({
        workId: uuid,
        repo: uuid,
        project: slug,
        baselineFingerprint: sha,
        baselineModeFingerprint: sha,
        baselineCommit: commit.optional(),
        draftRevision: sha,
        runtimeFingerprint: sha.nullable().optional(),
      })
      .parse(input);
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO paseo_work_bindings
        (work_id,repo,project,baseline_fingerprint,baseline_mode_fingerprint,baseline_commit,draft_revision,runtime_fingerprint,requested)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,true) ON CONFLICT(work_id) DO NOTHING`,
        [
          value.workId,
          value.repo,
          value.project,
          value.baselineFingerprint,
          value.baselineModeFingerprint,
          value.baselineCommit ?? null,
          value.draftRevision,
          value.runtimeFingerprint ?? null,
        ],
      );
      const binding = bindingDTO(
        (
          await client.query(
            "SELECT * FROM paseo_work_bindings WHERE work_id=$1",
            [value.workId],
          )
        ).rows[0],
      );
      if (binding.repo !== value.repo || binding.project !== value.project)
        throw problem(
          409,
          "Paseo work identity changed; retained draft requires explicit recovery",
        );
      return binding;
    });
  }
  async getWork(workId) {
    uuid.parse(workId);
    return bindingDTO(
      await this.db.one("SELECT * FROM paseo_work_bindings WHERE work_id=$1", [
        workId,
      ]),
    );
  }
  async listWorks({ states, requested, limit = 500 } = {}) {
    z.number().int().min(1).max(10000).parse(limit);
    const params = [],
      where = [];
    if (states) {
      z.array(z.enum(paseoRuntimeStates)).min(1).parse(states);
      params.push(states);
      where.push("state=ANY($" + params.length + ")");
    }
    if (requested !== undefined) {
      z.boolean().parse(requested);
      params.push(requested);
      where.push("requested=$" + params.length);
    }
    params.push(limit);
    return (
      await this.db.all(
        "SELECT * FROM paseo_work_bindings" +
          (where.length ? " WHERE " + where.join(" AND ") : "") +
          " ORDER BY updated,work_id LIMIT $" +
          params.length,
        params,
      )
    ).map(bindingDTO);
  }
  async requestWork(workId) {
    uuid.parse(workId);
    const row = await this.db.one(
      "UPDATE paseo_work_bindings SET requested=true,touched=now(),state=CASE WHEN state IN ('failed','stopped') THEN 'cold' ELSE state END,error=CASE WHEN state IN ('failed','stopped') THEN NULL ELSE error END,updated=now() WHERE work_id=$1 RETURNING *",
      [workId],
    );
    if (!row) throw problem(404, "Paseo work is not prepared");
    return bindingDTO(row);
  }
  async updateRuntime(workId, patch, { expectedDaemonGeneration } = {}) {
    uuid.parse(workId);
    const value = runtimeInput.parse(patch);
    const entries = Object.entries(value).filter(
      ([, item]) => item !== undefined,
    );
    if (!entries.length) throw Error("Runtime update is empty");
    const params = [workId],
      assignments = [];
    for (const [key, item] of entries) {
      params.push(key === "nativeSummary" ? json(item, 128000) : item);
      assignments.push(runtimeColumns[key] + "=$" + params.length);
    }
    const where = ["work_id=$1"];
    if (expectedDaemonGeneration !== undefined) {
      params.push(decimal.parse(expectedDaemonGeneration));
      where.push("daemon_generation=$" + params.length);
    }
    if (value.daemonGeneration !== undefined) {
      params.push(value.daemonGeneration);
      where.push("daemon_generation<=$" + params.length);
    }
    return (
      bindingDTO(
        await this.db.one(
          "UPDATE paseo_work_bindings SET " +
            assignments.join(",") +
            ",updated=now() WHERE " +
            where.join(" AND ") +
            " RETURNING *",
          params,
        ),
      ) || null
    );
  }
  async markDraft(workId, { revision }) {
    uuid.parse(workId);
    sha.parse(revision);
    return this.transaction(async (client) => {
      await client.query(
        "UPDATE paseo_work_bindings SET draft_revision=$2,generation=generation+1,updated=now() WHERE work_id=$1 AND draft_revision<>$2",
        [workId, revision],
      );
      const binding = bindingDTO(
        (
          await client.query(
            "SELECT * FROM paseo_work_bindings WHERE work_id=$1",
            [workId],
          )
        ).rows[0],
      );
      if (!binding) throw problem(404, "Paseo work is not prepared");
      return { generation: binding.generation, binding };
    });
  }
  async getMessage({ workId, agentId, messageId }) {
    uuid.parse(workId);
    id.parse(agentId);
    uuid.parse(messageId);
    return messageDTO(
      await this.db.one(
        "SELECT * FROM paseo_message_contexts WHERE work_id=$1 AND agent_id=$2 AND message_id=$3",
        [workId, agentId, messageId],
      ),
    );
  }
  async getMessageById({ workId, messageId }) {
    uuid.parse(workId);
    uuid.parse(messageId);
    return messageDTO(
      await this.db.one(
        "SELECT * FROM paseo_message_contexts WHERE work_id=$1 AND message_id=$2",
        [workId, messageId],
      ),
    );
  }
  async freezeMessage(input) {
    const value = z
      .strictObject({
        workId: uuid,
        agentId: id,
        messageId: uuid,
        intentHash: sha,
        envelope: z.json(),
        reviewReference: z.json().nullable().optional(),
        execution: z.json().nullable().optional(),
      })
      .parse(input);
    const envelope = json(value.envelope),
      reference = json(value.reviewReference),
      execution = json(value.execution, 32000);
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO paseo_message_contexts(work_id,agent_id,message_id,intent_hash,envelope,review_reference,execution)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *`,
        [
          value.workId,
          value.agentId,
          value.messageId,
          value.intentHash,
          envelope,
          reference,
          execution,
        ],
      );
      const message = messageDTO(
        inserted.rows[0] ||
          (
            await client.query(
              "SELECT * FROM paseo_message_contexts WHERE work_id=$1 AND message_id=$2",
              [value.workId, value.messageId],
            )
          ).rows[0],
      );
      if (message.agentId !== value.agentId)
        throw problem(409, "Paseo message ID belongs to another agent");
      if (message.intentHash !== value.intentHash)
        throw problem(
          409,
          "Paseo message ID already has a different frozen intent",
        );
      return { created: !!inserted.rowCount, message };
    });
  }
  async createCandidate(input) {
    const value = z
      .strictObject({
        id: uuid.optional(),
        workId: uuid,
        repo: uuid,
        project: slug,
        generation: decimal,
        revision: sha,
        baselineFingerprint: sha,
        baselineModeFingerprint: sha,
        baselineCommit: commit.optional(),
        runId: uuid,
        snapshotFingerprint: sha,
        snapshotModeFingerprint: sha,
        runtimeFingerprint: sha.nullable().optional(),
        origin: z.enum(["manual", "agent", "recovery"]).default("manual"),
      })
      .parse(input);
    if (value.revision !== value.snapshotModeFingerprint)
      throw Error("Candidate revision differs from captured source");
    return this.transaction(async (client) => {
      const binding = bindingDTO(
        (
          await client.query(
            "SELECT * FROM paseo_work_bindings WHERE work_id=$1 FOR UPDATE",
            [value.workId],
          )
        ).rows[0],
      );
      if (
        !binding ||
        binding.repo !== value.repo ||
        binding.project !== value.project ||
        binding.generation !== value.generation ||
        binding.draftRevision !== value.revision ||
        binding.baselineFingerprint !== value.baselineFingerprint ||
        binding.baselineModeFingerprint !== value.baselineModeFingerprint
      )
        throw problem(
          409,
          "Draft or canonical baseline changed before candidate registration",
        );
      const inserted = await client.query(
        `INSERT INTO paseo_candidates
        (id,work_id,repo,project,generation,revision,baseline_fingerprint,baseline_mode_fingerprint,baseline_commit,run_id,
        snapshot_fingerprint,snapshot_mode_fingerprint,runtime_fingerprint,origin)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT(work_id,generation,revision) DO NOTHING RETURNING *`,
        [
          value.id || randomUUID(),
          value.workId,
          value.repo,
          value.project,
          value.generation,
          value.revision,
          value.baselineFingerprint,
          value.baselineModeFingerprint,
          value.baselineCommit ?? null,
          value.runId,
          value.snapshotFingerprint,
          value.snapshotModeFingerprint,
          value.runtimeFingerprint ?? null,
          value.origin,
        ],
      );
      const candidate = candidateDTO(
        inserted.rows[0] ||
          (
            await client.query(
              "SELECT * FROM paseo_candidates WHERE work_id=$1 AND generation=$2 AND revision=$3",
              [value.workId, value.generation, value.revision],
            )
          ).rows[0],
      );
      if (
        candidate.snapshotFingerprint !== value.snapshotFingerprint ||
        candidate.runtimeFingerprint !== (value.runtimeFingerprint ?? null)
      )
        throw problem(
          409,
          "Candidate identity already refers to a different snapshot",
        );
      return { created: !!inserted.rowCount, candidate };
    });
  }
  async getCandidate(candidateId) {
    uuid.parse(candidateId);
    return candidateDTO(
      await this.db.one("SELECT * FROM paseo_candidates WHERE id=$1", [
        candidateId,
      ]),
    );
  }
  async getCandidateByRun(runId) {
    uuid.parse(runId);
    return candidateDTO(
      await this.db.one("SELECT * FROM paseo_candidates WHERE run_id=$1", [
        runId,
      ]),
    );
  }
  async listCandidates(workId, { states, limit = 100 } = {}) {
    uuid.parse(workId);
    z.number().int().min(1).max(1000).parse(limit);
    const params = [workId];
    let filter = "";
    if (states) {
      z.array(state).min(1).parse(states);
      params.push(states);
      filter = " AND state=ANY($2)";
    }
    params.push(limit);
    return (
      await this.db.all(
        "SELECT * FROM paseo_candidates WHERE work_id=$1" +
          filter +
          " ORDER BY generation DESC,created DESC,id DESC LIMIT $" +
          params.length,
        params,
      )
    ).map(candidateDTO);
  }
  async transitionCandidate(candidateId, { from, state: next, patch = {} }) {
    uuid.parse(candidateId);
    z.array(state).min(1).parse(from);
    state.parse(next);
    for (const old of from)
      if (!edges[old].includes(next))
        throw Error(
          "Unsupported Paseo candidate state transition: " +
            old +
            " -> " +
            next,
        );
    const value = z
      .strictObject({
        result: z.json().nullable().optional(),
        error: z.string().max(2000).nullable().optional(),
      })
      .parse(patch);
    const params = [candidateId, from, next],
      assignments = ["state=$3", "updated=now()"];
    for (const [key, item] of Object.entries(value)) {
      params.push(key === "result" ? json(item, 8 * 1024 * 1024) : item);
      assignments.push(key + "=$" + params.length);
    }
    return (
      candidateDTO(
        await this.db.one(
          "UPDATE paseo_candidates SET " +
            assignments.join(",") +
            " WHERE id=$1 AND state=ANY($2) RETURNING *",
          params,
        ),
      ) || null
    );
  }
  async appliedCandidate(
    candidateId,
    { sourceRevision, commit: appliedCommit = null },
  ) {
    uuid.parse(candidateId);
    sha.parse(sourceRevision);
    commit.parse(appliedCommit);
    return this.transaction(async (client) => {
      const candidate = candidateDTO(
        (
          await client.query(
            "SELECT * FROM paseo_candidates WHERE id=$1 FOR UPDATE",
            [candidateId],
          )
        ).rows[0],
      );
      if (!candidate) throw problem(404, "Paseo candidate not found");
      if (candidate.state === "applied") {
        if (
          candidate.sourceRevision !== sourceRevision ||
          candidate.commit !== appliedCommit
        )
          throw problem(409, "Paseo apply receipt changed");
        return candidate;
      }
      if (
        candidate.state !== "publishing" ||
        candidate.snapshotFingerprint !== sourceRevision
      )
        throw problem(
          409,
          "Paseo candidate is not publishing this frozen source",
        );
      const binding = bindingDTO(
        (
          await client.query(
            "SELECT * FROM paseo_work_bindings WHERE work_id=$1 FOR UPDATE",
            [candidate.workId],
          )
        ).rows[0],
      );
      if (
        binding.baselineFingerprint !== candidate.baselineFingerprint ||
        binding.baselineModeFingerprint !== candidate.baselineModeFingerprint
      )
        throw problem(
          409,
          "Paseo canonical baseline changed during publication",
        );
      await client.query(
        "UPDATE paseo_work_bindings SET baseline_fingerprint=$2,baseline_mode_fingerprint=$3,baseline_commit=$4,updated=now() WHERE work_id=$1",
        [
          candidate.workId,
          candidate.snapshotFingerprint,
          candidate.snapshotModeFingerprint,
          appliedCommit,
        ],
      );
      const row = (
        await client.query(
          "UPDATE paseo_candidates SET state='applied',source_revision=$2,\"commit\"=$3,updated=now() WHERE id=$1 RETURNING *",
          [candidateId, sourceRevision, appliedCommit],
        )
      ).rows[0];
      return candidateDTO(row);
    });
  }
}
