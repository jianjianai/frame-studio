import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import pg from "pg";
import { vault, confined } from "../server/security.mjs";

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--data", "--env"].includes(args[i]) || !args[i + 1]) throw Error("Usage: restore-check.mjs --data <restored data> --env <restored .env>");
  options[args[i].slice(2)] = path.resolve(args[i + 1]);
}
const address = process.env.FRAME_RESTORE_DATABASE_URL;
if (!address || !options.data || !options.env) throw Error("FRAME_RESTORE_DATABASE_URL, --data and --env are required");
let parsed;
try { parsed = new URL(address); } catch { throw Error("Invalid recovery database URL"); }
if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !decodeURIComponent(parsed.pathname).includes("frame_test_restore"))
  throw Error("Only a dedicated frame_test_restore database may be checked");
if (!fs.lstatSync(options.env).isFile() || fs.lstatSync(options.env).isSymbolicLink()) throw Error("Restored environment must be a regular file");
const settings = parseEnv(fs.readFileSync(options.env, "utf8"));
if (!/^[a-fA-F0-9]{64}$/.test(settings.FRAME_MASTER_KEY || "")) throw Error("Restored FRAME_MASTER_KEY is missing or invalid");
const secrets = vault(settings.FRAME_MASTER_KEY);
const client = new pg.Client({ connectionString: address });
let connected = false;
try {
  await client.connect(); connected = true;
  await client.query("BEGIN READ ONLY");
  const versioned = (await client.query("SELECT to_regclass('frame_schema_migrations') AS name")).rows[0].name;
  const migrations = versioned ? (await client.query("SELECT id FROM frame_schema_migrations ORDER BY id")).rows : [];
  let credentials = 0;
  for (const table of ["github_accounts", "engines"]) {
    for (const row of (await client.query(`SELECT config FROM ${table}`)).rows) {
      secrets.decrypt(row.config); credentials++;
    }
  }
  for (const row of (await client.query("SELECT value->>'encrypted' AS config FROM settings WHERE value ? 'encrypted'")).rows) {
    secrets.decrypt(row.config); credentials++;
  }
  const assets = (await client.query("SELECT DISTINCT sha,bytes FROM assets")).rows;
  for (const asset of assets) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha)) throw Error("Invalid restored asset checksum");
    const file = confined(options.data, "blobs/" + asset.sha);
    if (fs.statSync(file).size !== Number(asset.bytes)) throw Error("Restored asset size mismatch");
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== asset.sha) throw Error("Restored asset content mismatch");
  }
  const works = (await client.query("SELECT id,project FROM works")).rows;
  for (const work of works) {
    const file = confined(options.data, `works/${work.id}/projects/${work.project}/project.ts`);
    if (!fs.statSync(file).isFile()) throw Error("Restored work source is missing");
  }
  await client.query("ROLLBACK");
  console.log(JSON.stringify({ passed: true, readOnly: true, schemaVersioned: !!versioned, migrations: migrations.map((row) => row.id), checkedCredentials: credentials, checkedAssets: assets.length, checkedWorks: works.length }));
} catch {
  if (connected) await client.query("ROLLBACK").catch(() => {});
  console.error("Restore verification failed: check the isolated database, master key, work directories and asset hashes. No credentials are printed.");
  process.exitCode = 1;
} finally { await client.end().catch(() => {}); }
