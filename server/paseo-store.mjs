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
export const paseoRuntimeStates = [
  "cold",
  "starting",
  "ready",
  "stopped",
  "failed",
];
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
    revision: row.revision,
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
const validationDTO = row => row && ({ id: row.id, workId: row.work_id,
  revision: row.revision, generation: String(row.generation), runtimeFingerprint: row.runtime_fingerprint,
  state: row.state, result: typeof row.result === "string" ? JSON.parse(row.result) : row.result,
  error: row.error, created: date(row.created), updated: date(row.updated) });
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

/** Dedicated ledger versions the native-session and sole-workspace metadata. */
export async function migratePaseo(db, plan = migrationPlan(planRoot)) {
  const options = { ledger: "paseo_schema_migrations" };
  if (db.kind === "sqlite") {
    const { sqliteMigration } = await import("./sqlite.mjs");
    options.dialect = "sqlite";
    options.transformSql = sql => {
      if (/CREATE TABLE paseo_message_assets\b/.test(sql)) {
        const ddl = sql.slice(0, sql.indexOf("INSERT INTO paseo_message_assets"));
        return sqliteMigration(ddl) + `
          INSERT INTO paseo_message_assets(work_id,agent_id,message_id,asset)
          SELECT DISTINCT m.work_id,m.agent_id,m.message_id,a.id
          FROM paseo_message_contexts m
          JOIN paseo_work_bindings b ON b.work_id=m.work_id
          JOIN json_each(CASE WHEN json_type(m.review_reference,'$.materials')='array'
            THEN json_extract(m.review_reference,'$.materials') ELSE '[]' END) material
          JOIN assets a ON a.id=lower(json_extract(material.value,'$.id'))
          JOIN asset_repos ar ON ar.asset=a.id AND ar.repo=b.repo
          WHERE a.sha=json_extract(material.value,'$.sha256')
            AND CAST(a.bytes AS TEXT)=CAST(json_extract(material.value,'$.bytes') AS TEXT)
          ON CONFLICT DO NOTHING;`;
      }
      const translated = sqliteMigration(sql);
      // SQLite removes procedural PostgreSQL blocks, so enforce the same destructive-upgrade guard in SQL.
      if (!/\bDROP TABLE paseo_candidates\s*;/i.test(translated)) return translated;
      return `CREATE TEMP TABLE paseo_retirement_guard (
        candidates integer CONSTRAINT "Audit retained Paseo candidates and stop old validation workers before migration" CHECK(candidates=0));
        INSERT INTO paseo_retirement_guard SELECT count(*) FROM paseo_candidates;
        DROP TABLE paseo_retirement_guard;` + translated;
    };
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
        revision: sha,
        runtimeFingerprint: sha.nullable().optional(),
      })
      .parse(input);
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO paseo_work_bindings
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
            "SELECT * FROM paseo_work_bindings WHERE work_id=$1",
            [value.workId],
          )
        ).rows[0],
      );
      if (binding.repo !== value.repo || binding.project !== value.project)
        throw problem(
          409,
          "Paseo work identity changed; retained workspace requires explicit recovery",
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
  async markRevision(workId, { revision }) {
    uuid.parse(workId);
    sha.parse(revision);
    return this.transaction(async (client) => {
      await client.query(
        "UPDATE paseo_work_bindings SET revision=$2,generation=generation+1,updated=now() WHERE work_id=$1 AND revision<>$2",
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
             JOIN paseo_work_bindings b ON b.repo=ar.repo
             WHERE b.work_id=$1 AND a.id=ANY($2) AND NOT a.deleted
             ORDER BY a.id` + (this.db.kind === "sqlite" ? "" : " FOR UPDATE OF a"),
            [value.workId, [...unique.keys()].sort()],
          )).rows;
          if (rows.length !== unique.size || rows.some(asset => {
            const material = unique.get(asset.id);
            return !material || asset.sha !== material.sha256 || decimal.parse(asset.bytes) !== material.bytes;
          })) throw problem(409, "引用素材已删除、更新或不属于当前仓库，请重新选择后发送");
          const params = [value.workId, value.agentId, value.messageId];
          const values = [...unique.keys()].sort().map(asset => {
            params.push(asset);
            return `($1,$2,$3,$${params.length})`;
          });
          await client.query(
            "INSERT INTO paseo_message_assets(work_id,agent_id,message_id,asset) VALUES " +
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
    const inserted = await this.db.one(`INSERT INTO paseo_validations
      (id,work_id,revision,generation,runtime_fingerprint,state) VALUES($1,$2,$3,$4,$5,'queued')
      ON CONFLICT(work_id,revision,runtime_fingerprint) DO UPDATE SET generation=EXCLUDED.generation,
      state=CASE WHEN paseo_validations.state IN ('stale','cancelled') THEN 'queued' ELSE paseo_validations.state END,updated=now()
      WHERE paseo_validations.generation<EXCLUDED.generation RETURNING *`,
      [reportId, workId, revision, generation, runtimeFingerprint]);
    const report = inserted || await this.db.one("SELECT * FROM paseo_validations WHERE work_id=$1 AND revision=$2 AND runtime_fingerprint=$3",
      [workId, revision, runtimeFingerprint]);
    return validationDTO(report);
  }
  async getValidation(reportId) {
    uuid.parse(reportId);
    return validationDTO(await this.db.one("SELECT * FROM paseo_validations WHERE id=$1", [reportId]));
  }
  async listValidations(workId, { states, limit = 20 } = {}) {
    uuid.parse(workId); z.number().int().min(1).max(200).parse(limit);
    const params = [workId], filter = [];
    if (states) {
      z.array(z.enum(["queued", "running", "passed", "failed", "stale", "cancelled"])).min(1).parse(states);
      params.push(states); filter.push("state=ANY($" + params.length + ")");
    }
    params.push(limit);
    return (await this.db.all("SELECT * FROM paseo_validations WHERE work_id=$1" +
      (filter.length ? " AND " + filter.join(" AND ") : "") + " ORDER BY generation DESC,updated DESC LIMIT $" + params.length, params)).map(validationDTO);
  }
  async updateValidation(reportId, { from, state, result, error }) {
    uuid.parse(reportId);
    const validState = z.enum(["queued", "running", "passed", "failed", "stale", "cancelled"]);
    z.array(validState).min(1).parse(from); validState.parse(state);
    const params = [reportId, state, from], sets = ["state=$2", "updated=now()"];
    if (result !== undefined) { params.push(json(result, 128000)); sets.push("result=$" + params.length); }
    if (error !== undefined) { params.push(error == null ? null : z.string().max(2000).parse(error)); sets.push("error=$" + params.length); }
    return validationDTO(await this.db.one("UPDATE paseo_validations SET " + sets.join(",") + " WHERE id=$1 AND state=ANY($3) RETURNING *", params)) || null;
  }
}
