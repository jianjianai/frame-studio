import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { AiStore } from "./ai-store.mjs";
import { AiClient } from "./ai-client.mjs";
import { retiredSchema } from "./ai-retirement-schema.mjs";
import { vault } from "./security.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomUUID() + ".tmp";
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function table(db, name) {
  return db.kind === "sqlite" ? !!await db.one("SELECT name FROM sqlite_master WHERE type='table' AND name=$1", [name])
    : !!(await db.one("SELECT to_regclass($1) AS name", [name]))?.name;
}
async function fileBytes(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw Error("Native credential file identity is invalid");
  return fs.readFile(file);
}
async function preflight(db) {
  if (await table(db, "work_undos") && await db.one("SELECT id FROM work_undos LIMIT 1"))
    throw Error("Retained legacy undo records require review before retirement");
  if (await db.one("SELECT id FROM tasks WHERE state IN ('queued','running','cancelling','publishing','publish_failed') LIMIT 1"))
    throw Error("Finish active FRAME tasks before retiring AI data");
  if (await table(db, "paseo_work_bindings")) {
    if (await db.one("SELECT work_id FROM paseo_work_bindings WHERE requested OR state IN ('ready','starting') LIMIT 1"))
      throw Error("Stop retired native sessions before migration");
    for (const name of ["paseo_message_contexts", "paseo_message_assets", "paseo_candidates"])
      if (await table(db, name) && Number((await db.one("SELECT count(*) AS n FROM " + name)).n))
        throw Error("Retained native history requires a reviewed history migration; retirement refused");
    if (await db.one("SELECT id FROM paseo_validations WHERE state IN ('queued','running') LIMIT 1"))
      throw Error("Stop retired validation workers before migration");
  }
  if (await table(db, "paseo_schema_migrations")) {
    const ledger = await db.all("SELECT id,checksum FROM paseo_schema_migrations ORDER BY id");
    if (stable(ledger) !== stable(retiredSchema)) throw Error("Retired migration ledger does not match the audited schema");
  }
}
async function snapshot(db) {
  return {
    singletonSettings: await db.all("SELECT key,value FROM settings WHERE key IN ('codex','claude') ORDER BY key"),
    connections: await table(db, "connections") ? await db.all("SELECT * FROM connections ORDER BY id") : [],
    bindings: await table(db, "paseo_work_bindings") ? await db.all("SELECT * FROM paseo_work_bindings ORDER BY work_id") : [],
    reports: await table(db, "paseo_validations") ? await db.all("SELECT * FROM paseo_validations ORDER BY id") : [],
  };
}
const receiptFile = data => path.join(data, "ai/shared/retirement.json");

/** Explicit one-time import. Startup never discards legacy credentials or history. */
export async function prepareAiRetirement({ db, data, secrets, temporaryConnectionIds = [], nativeData = data }) {
  await preflight(db);
  const original = await snapshot(db), sourceDigest = digest(stable(original));
  if (original.singletonSettings.length) throw Error("Retained provider singleton settings require migration before retirement");
  const previous = await fs.readFile(receiptFile(data), "utf8").then(JSON.parse).catch(error => {
    if (error.code !== "ENOENT") throw error; return null;
  });
  if (previous) {
    if (previous.sourceDigest !== sourceDigest) throw Error("Retirement source changed after preparation");
    await verifyFiles(previous); return { phase: previous.phase, profiles: previous.profiles.length, reports: previous.reports.length };
  }
  const temporary = new Set(temporaryConnectionIds), files = [], profiles = [];
  const settingsFile = path.join(data, "ai/t3/userdata/settings.json");
  const settings = await fs.readFile(settingsFile, "utf8").then(JSON.parse).catch(error => {
    if (error.code !== "ENOENT") throw error; return {};
  });
  settings.providerInstances ||= {};
  if (original.connections.length) {
    settings.providers ||= {};
    for (const driver of ["codex", "claudeAgent"])
      settings.providers[driver] = { ...(settings.providers[driver] || {}), enabled: false };
  }
  for (const row of original.connections) {
    if (temporary.has(row.id)) {
      if (row.name !== "V8 final protocol fixture (temporary)" || row.tool !== "codex" || row.mode !== "api")
        throw Error("Temporary provider identity does not match the audited fixture");
      continue;
    }
    const config = secrets.decrypt(row.config), instanceId = "frame_" + row.id;
    const home = path.join(data, "ai/cli", instanceId), nativeHome = path.join(nativeData, "ai/cli", instanceId);
    const native = { driver: row.tool === "claude" ? "claudeAgent" : "codex", displayName: row.name,
      enabled: row.state !== "deleted" && config.enabled !== false,
      config: { binaryPath: row.tool === "claude" ? "claude" : "codex", homePath: nativeHome,
        customModels: (config.models || (config.model ? [{ id: config.model }] : [])).filter(model => model.enabled !== false)
          .map(model => ({ slug: model.id, name: model.name || model.id })) } };
    if (settings.providerInstances[instanceId] && stable(settings.providerInstances[instanceId]) !== stable(native))
      throw Error("Native provider already exists with a different configuration");
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    if (row.mode === "api") {
      if (!config.apiKey) throw Error("Configured API provider lacks its credential");
      if (row.tool === "claude") {
        const target = path.join(home, "settings.json"), value = { env: { ANTHROPIC_API_KEY: config.apiKey,
          ...(config.baseUrl ? { ANTHROPIC_BASE_URL: config.baseUrl } : {}) } };
        await atomicJson(target, value); files.push({ file: target, sha256: digest(await fs.readFile(target)) });
      } else {
        const auth = path.join(home, "auth.json");
        await atomicJson(auth, { OPENAI_API_KEY: config.apiKey }); files.push({ file: auth, sha256: digest(await fs.readFile(auth)) });
        const toml = path.join(home, "config.toml");
        const value = [config.model ? "model = " + JSON.stringify(config.model) : "", "model_provider = \"frame_imported\"",
          "[model_providers.frame_imported]", "name = " + JSON.stringify(row.name),
          "base_url = " + JSON.stringify(config.baseUrl || "https://api.openai.com/v1"),
          "env_key = \"OPENAI_API_KEY\"", "wire_api = \"responses\"", "requires_openai_auth = false", ""].filter(Boolean).join("\n");
        await fs.writeFile(toml, value, { mode: 0o600 }); files.push({ file: toml, sha256: digest(value) });
        native.environment = [{ name: "OPENAI_API_KEY", value: config.apiKey, sensitive: true }];
      }
    } else {
      const name = row.tool === "claude" ? ".credentials.json" : "auth.json";
      const source = path.join(data, "auth", row.id, row.tool, name), target = path.join(home, name);
      let bytes;
      try { bytes = await fileBytes(source); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        // An unconfigured profile has no credential to preserve. A ready login must be proved.
        // Old FRAME state is not evidence of an actual login. Preserve the profile,
        // and let the native CLI report its missing authentication accurately.
      }
      if (bytes) { await fs.writeFile(target, bytes, { mode: 0o600 }); files.push({ file: target, sha256: digest(bytes) }); }
    }
    settings.providerInstances[instanceId] = native;
    if (!settings.defaultModelSelection && native.enabled && row.mode === "api" && config.model)
      settings.defaultModelSelection = { instanceId, model: config.model };
    profiles.push({ instanceId, driver: native.driver, homePath: nativeHome, enabled: native.enabled,
      sourceAuth: row.mode === "api" ? "api-key" : files.some(item => path.dirname(item.file) === home) ? "present" : "absent" });
  }
  if ([...temporary].some(id => !original.connections.some(row => row.id === id))) throw Error("A selected fixture connection no longer exists");
  await atomicJson(settingsFile, settings);
  // Settings may be normalized by T3; CLI credentials are individually checked after native startup.
  const store = await new AiStore({ db }).initialize();
  await store.transaction(async client => {
    for (const row of original.bindings) {
      await client.query(`INSERT INTO ai_work_bindings(work_id,repo,project,revision,generation,requested,state,runtime_fingerprint,created,updated,touched)
        VALUES($1,$2,$3,$4,$5,false,'stopped',$6,$7,$8,$9) ON CONFLICT(work_id) DO NOTHING`,
        [row.work_id,row.repo,row.project,row.revision,row.generation,row.runtime_fingerprint,row.created,row.updated,row.touched]);
    }
    for (const row of original.reports) {
      await client.query(`INSERT INTO ai_validations(id,work_id,revision,generation,runtime_fingerprint,state,result,error,created,updated)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
        [row.id,row.work_id,row.revision,row.generation,row.runtime_fingerprint,row.state,row.result,row.error,row.created,row.updated]);
    }
  });
  const proof = { version: 1, phase: "prepared", sourceDigest, profiles, files,
    reports: original.reports.map(row => ({ id: row.id, digest: digest(stable(row)) })), preparedAt: new Date().toISOString() };
  await verifyReports(db, proof); await atomicJson(receiptFile(data), proof);
  return { phase: "prepared", profiles: profiles.length, reports: proof.reports.length, temporaryConnections: temporary.size };
}
async function verifyFiles(proof) {
  for (const item of proof.files) if (digest(await fileBytes(item.file)) !== item.sha256) throw Error("Migrated native CLI credential changed before retirement");
}
async function verifyReports(db, proof) {
  for (const item of proof.reports) {
    const row = await db.one("SELECT * FROM ai_validations WHERE id=$1", [item.id]);
    if (!row || digest(stable(row)) !== item.digest) throw Error("Validation report did not migrate byte-for-byte");
  }
}
/** The live native registry must expose the exact migrated CLI home before deletion is authorized. */
export async function verifyAiRetirement({ db, data, client = new AiClient({ data }) }) {
  const proof = JSON.parse(await fs.readFile(receiptFile(data), "utf8"));
  await preflight(db); await verifyFiles(proof); await verifyReports(db, proof);
  if (digest(stable(await snapshot(db))) !== proof.sourceDigest) throw Error("Retirement source changed after preparation");
  const config = await client.config();
  for (const profile of proof.profiles) {
    const settings = config.settings?.providerInstances?.[profile.instanceId];
    const native = config.providers?.find(value => value.instanceId === profile.instanceId);
    if (!settings || settings.driver !== profile.driver || settings.enabled !== profile.enabled ||
        settings.config?.homePath !== profile.homePath || !native || native.driver !== profile.driver ||
        native.enabled !== profile.enabled || (profile.enabled && native.installed !== true))
      throw Error("The live T3 registry has not loaded the migrated native provider");
  }
  proof.phase = "verified"; proof.nativeEnvironmentId = config.environment.environmentId; proof.verifiedAt = new Date().toISOString();
  await atomicJson(receiptFile(data), proof);
  return { phase: "verified", profiles: proof.profiles.length, reports: proof.reports.length };
}
/** Run only after prepare and live-native verification. Does not delete source or files. */
export async function retireAiTables({ db, data }) {
  const proof = JSON.parse(await fs.readFile(receiptFile(data), "utf8"));
  if (proof.phase === "retired") return { phase: "retired", reports: proof.reports.length };
  if (proof.phase !== "verified") throw Error("Verify migrated providers in the live T3 registry before retirement");
  await preflight(db); await verifyFiles(proof); await verifyReports(db, proof);
  if (digest(stable(await snapshot(db))) !== proof.sourceDigest) throw Error("Retirement source changed after verification");
  const store = new AiStore({ db });
  await store.transaction(async client => {
    if (db.kind !== "sqlite") {
      const existing = [];
      for (const name of ["connections","paseo_work_bindings","paseo_validations"])
        if ((await client.query("SELECT to_regclass($1) AS name", [name])).rows[0].name) existing.push(name);
      if (existing.length) await client.query("LOCK TABLE " + existing.join(",") + " IN ACCESS EXCLUSIVE MODE");
    }
    for (const name of ["paseo_message_assets","paseo_message_contexts","paseo_validations","paseo_work_bindings","paseo_schema_migrations","connections","work_undos"])
      await client.query("DROP TABLE IF EXISTS " + name);
    if (db.kind !== "sqlite") await client.query("DROP FUNCTION IF EXISTS frame_paseo_change()");
    await client.query("DELETE FROM auth_flows WHERE kind IN ('codex','claude')");
    await client.query("DELETE FROM settings WHERE key IN ('codex','claude')");
  });
  proof.phase = "retired"; proof.retiredAt = new Date().toISOString(); await atomicJson(receiptFile(data), proof);
  return { phase: "retired", profiles: proof.profiles.length, reports: proof.reports.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = { pool, all: async (sql, params) => (await pool.query(sql, params)).rows,
    one: async (sql, params) => (await pool.query(sql, params)).rows[0] };
  const data = process.env.FRAME_DATA || "/data", mode = process.argv[2], client = new AiClient({ data });
  try {
    const value = mode === "prepare" ? await prepareAiRetirement({ db, data, secrets: vault(process.env.FRAME_MASTER_KEY),
      temporaryConnectionIds: process.argv.slice(3).map(id => { if (!/^[0-9a-f-]{36}$/.test(id)) throw Error("Invalid fixture identity"); return id; }) })
      : mode === "verify" ? await verifyAiRetirement({ db, data, client }) : mode === "retire" ? await retireAiTables({ db, data })
        : (() => { throw Error("Use prepare [fixture IDs], verify, or retire"); })();
    console.log(JSON.stringify(value));
  } finally { client.close(); await pool.end(); }
}
