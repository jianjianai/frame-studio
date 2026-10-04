import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { migrate, migrationPlan } from "./migrations.mjs";
import { problem } from "./security.mjs";

const uuid = z.uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
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
export const aiRuntimeStates = [
  "cold",
  "starting",
  "ready",
  "stopped",
  "failed",
];
const planRoot = fileURLToPath(new URL("./ai-migrations/", import.meta.url));
const json = (value, maximum = 2_100_000) => {
  if (value === undefined || value === null) return null;
  const text = JSON.stringify(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item))
      throw Error("Ai metadata must contain finite JSON numbers");
    if (
      typeof item === "bigint" ||
      typeof item === "function" ||
      typeof item === "symbol"
    )
      throw Error("Ai metadata must contain JSON values");
    return item;
  });
  if (typeof text !== "string" || Buffer.byteLength(text) > maximum)
    throw Error("Ai metadata is too large");
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
    revision: row.revision,
    generation: String(row.generation),
    requested: !!row.requested,
    state: row.state,
    projectId: row.native_project_id,
    environmentId: row.environment_id,
    cwd: row.cwd,
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
const validationDTO = row => row && ({ id: row.id, workId: row.work_id,
  revision: row.revision, generation: String(row.generation), runtimeFingerprint: row.runtime_fingerprint,
  state: row.state, result: typeof row.result === "string" ? JSON.parse(row.result) : row.result,
  error: row.error, created: date(row.created), updated: date(row.updated) });
const messageDTO = (row) =>
  row && {
    workId: row.work_id,
    threadId: row.thread_id,
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
  state: z.enum(aiRuntimeStates).optional(),
  requested: z.boolean().optional(),
  projectId: uuid.nullable().optional(),
  environmentId: id.nullable().optional(),
  cwd: z.string().max(4096).nullable().optional(),
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
  projectId: "native_project_id",
  environmentId: "environment_id",
  cwd: "cwd",
  runtimeFingerprint: "runtime_fingerprint",
  image: "image",
  error: "error",
  lastObserved: "last_observed",
  nativeSummary: "native_summary",
};

/** Dedicated ledger versions the native-session and sole-workspace metadata. */
export async function migrateAi(db, plan = migrationPlan(planRoot)) {
  const options = { ledger: "ai_schema_migrations" };
  if (db.kind === "sqlite") {
    const { sqliteMigration } = await import("./sqlite.mjs");
    options.dialect = "sqlite";
    options.transformSql = sqliteMigration;
  }
  await migrate(db.pool, plan, options);
}

/** Private DTOs: only the gateway's explicit projections may leave the server. */
export class AiStore {
  constructor({ db }) {
    this.db = db;
  }
  async initialize() {
    await migrateAi(this.db);
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
        revision: sha,
        runtimeFingerprint: sha.nullable().optional(),
      })
      .parse(input);
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO ai_work_bindings
        (work_id,repo,project,revision,runtime_fingerprint,requested)
        VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(work_id) DO NOTHING`,
        [
          value.workId,
          value.repo,
          value.project,
          value.revision,
          value.runtimeFingerprint ?? null,
        ],
      );
      const binding = bindingDTO(
        (
          await client.query(
            "SELECT * FROM ai_work_bindings WHERE work_id=$1",
            [value.workId],
          )
        ).rows[0],
      );
      if (binding.repo !== value.repo || binding.project !== value.project)
        throw problem(
          409,
          "Ai work identity changed; retained workspace requires explicit recovery",
        );
      return binding;
    });
  }
  async getWork(workId) {
    uuid.parse(workId);
    return bindingDTO(
      await this.db.one("SELECT * FROM ai_work_bindings WHERE work_id=$1", [
        workId,
      ]),
    );
  }
  async listWorks({ states, requested, limit = 500 } = {}) {
    z.number().int().min(1).max(10000).parse(limit);
    const params = [],
      where = [];
    if (states) {
      z.array(z.enum(aiRuntimeStates)).min(1).parse(states);
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
        "SELECT * FROM ai_work_bindings" +
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
      "UPDATE ai_work_bindings SET requested=true,touched=now(),state=CASE WHEN state IN ('failed','stopped') THEN 'cold' ELSE state END,error=CASE WHEN state IN ('failed','stopped') THEN NULL ELSE error END,updated=now() WHERE work_id=$1 RETURNING *",
      [workId],
    );
    if (!row) throw problem(404, "Ai work is not prepared");
    return bindingDTO(row);
  }
  async updateRuntime(workId, patch) {
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
    return (
      bindingDTO(
        await this.db.one(
          "UPDATE ai_work_bindings SET " +
            assignments.join(",") +
            ",updated=now() WHERE " +
            where.join(" AND ") + " AND (" + entries.map(([key], index) =>
              runtimeColumns[key] + " IS DISTINCT FROM $" + (index + 2)).join(" OR ") + ")" +
            " RETURNING *",
          params,
        ),
      ) || await this.getWork(workId)
    );
  }
  async markRevision(workId, { revision }) {
    uuid.parse(workId);
    sha.parse(revision);
    return this.transaction(async (client) => {
      await client.query(
        "UPDATE ai_work_bindings SET revision=$2,generation=generation+1,updated=now() WHERE work_id=$1 AND revision<>$2",
        [workId, revision],
      );
      const binding = bindingDTO(
        (
          await client.query(
            "SELECT * FROM ai_work_bindings WHERE work_id=$1",
            [workId],
          )
        ).rows[0],
      );
      if (!binding) throw problem(404, "Ai work is not prepared");
      return { generation: binding.generation, binding };
    });
  }
  async getMessage({ workId, threadId, messageId }) {
    uuid.parse(workId);
    id.parse(threadId);
    uuid.parse(messageId);
    return messageDTO(
      await this.db.one(
        "SELECT * FROM ai_message_contexts WHERE work_id=$1 AND thread_id=$2 AND message_id=$3",
        [workId, threadId, messageId],
      ),
    );
  }
  async getMessageById({ workId, messageId }) {
    uuid.parse(workId);
    uuid.parse(messageId);
    return messageDTO(
      await this.db.one(
        "SELECT * FROM ai_message_contexts WHERE work_id=$1 AND message_id=$2",
        [workId, messageId],
      ),
    );
  }
  async freezeMessage(input) {
    const value = z
      .strictObject({
        workId: uuid,
        threadId: id,
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
        `INSERT INTO ai_message_contexts(work_id,thread_id,message_id,intent_hash,envelope,review_reference,execution)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *`,
        [
          value.workId,
          value.threadId,
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
              "SELECT * FROM ai_message_contexts WHERE work_id=$1 AND message_id=$2",
              [value.workId, value.messageId],
            )
          ).rows[0],
      );
      if (message.threadId !== value.threadId)
        throw problem(409, "Ai message ID belongs to another agent");
      if (message.intentHash !== value.intentHash)
        throw problem(
          409,
          "Ai message ID already has a different frozen intent",
        );
      if (inserted.rowCount) {
        const materials = z.array(z.object({ id: uuid.transform(value => value.toLowerCase()), sha256: sha, bytes: decimal }))
          .max(20).parse(reference?.materials ?? []);
        const unique = new Map();
        for (const material of materials) {
          const previous = unique.get(material.id);
          if (previous && (previous.sha256 !== material.sha256 || previous.bytes !== material.bytes))
            throw problem(409, "引用素材的身份已变化，请重新选择后发送");
          unique.set(material.id, material);
        }
        if (unique.size) {
          // Lock the bounded selected set through pin insertion. A simultaneous trash/delete
          // either happens first and rejects this message, or waits for its retaining FK.
          const rows = (await client.query(
            `SELECT a.id,a.sha,a.bytes FROM assets a
             JOIN asset_repos ar ON ar.asset=a.id
             JOIN ai_work_bindings b ON b.repo=ar.repo
             WHERE b.work_id=$1 AND a.id=ANY($2) AND NOT a.deleted
             ORDER BY a.id` + (this.db.kind === "sqlite" ? "" : " FOR UPDATE OF a"),
            [value.workId, [...unique.keys()].sort()],
          )).rows;
          if (rows.length !== unique.size || rows.some(asset => {
            const material = unique.get(asset.id);
            return !material || asset.sha !== material.sha256 || decimal.parse(asset.bytes) !== material.bytes;
          })) throw problem(409, "引用素材已删除、更新或不属于当前仓库，请重新选择后发送");
          const params = [value.workId, value.threadId, value.messageId];
          const values = [...unique.keys()].sort().map(asset => {
            params.push(asset);
            return `($1,$2,$3,$${params.length})`;
          });
          await client.query(
            "INSERT INTO ai_message_assets(work_id,thread_id,message_id,asset) VALUES " +
            values.join(",") + " ON CONFLICT DO NOTHING", params,
          );
        }
      }
      return { created: !!inserted.rowCount, message };
    });
  }
  async createValidation({ workId, revision, generation, runtimeFingerprint }) {
    uuid.parse(workId); sha.parse(revision); decimal.parse(generation); sha.parse(runtimeFingerprint);
    const reportId = randomUUID();
    const inserted = await this.db.one(`INSERT INTO ai_validations
      (id,work_id,revision,generation,runtime_fingerprint,state) VALUES($1,$2,$3,$4,$5,'queued')
      ON CONFLICT(work_id,revision,runtime_fingerprint) DO UPDATE SET generation=EXCLUDED.generation,
      state=CASE WHEN ai_validations.state IN ('stale','cancelled') THEN 'queued' ELSE ai_validations.state END,updated=now()
      WHERE ai_validations.generation<EXCLUDED.generation RETURNING *`,
      [reportId, workId, revision, generation, runtimeFingerprint]);
    const report = inserted || await this.db.one("SELECT * FROM ai_validations WHERE work_id=$1 AND revision=$2 AND runtime_fingerprint=$3",
      [workId, revision, runtimeFingerprint]);
    return validationDTO(report);
  }
  async getValidation(reportId) {
    uuid.parse(reportId);
    return validationDTO(await this.db.one("SELECT * FROM ai_validations WHERE id=$1", [reportId]));
  }
  async listValidations(workId, { states, limit = 20 } = {}) {
    uuid.parse(workId); z.number().int().min(1).max(200).parse(limit);
    const params = [workId], filter = [];
    if (states) {
      z.array(z.enum(["queued", "running", "passed", "failed", "stale", "cancelled"])).min(1).parse(states);
      params.push(states); filter.push("state=ANY($" + params.length + ")");
    }
    params.push(limit);
    return (await this.db.all("SELECT * FROM ai_validations WHERE work_id=$1" +
      (filter.length ? " AND " + filter.join(" AND ") : "") + " ORDER BY generation DESC,updated DESC LIMIT $" + params.length, params)).map(validationDTO);
  }
  async updateValidation(reportId, { from, state, result, error }) {
    uuid.parse(reportId);
    const validState = z.enum(["queued", "running", "passed", "failed", "stale", "cancelled"]);
    z.array(validState).min(1).parse(from); validState.parse(state);
    const params = [reportId, state, from], sets = ["state=$2", "updated=now()"];
    if (result !== undefined) { params.push(json(result, 128000)); sets.push("result=$" + params.length); }
    if (error !== undefined) { params.push(error == null ? null : z.string().max(2000).parse(error)); sets.push("error=$" + params.length); }
    return validationDTO(await this.db.one("UPDATE ai_validations SET " + sets.join(",") + " WHERE id=$1 AND state=ANY($3) RETURNING *", params)) || null;
  }
}
