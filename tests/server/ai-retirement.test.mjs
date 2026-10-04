import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { database } from "../../server/db.mjs";
import { vault } from "../../server/security.mjs";
import { retiredSchema } from "../../server/ai-retirement-schema.mjs";
import { prepareAiRetirement, verifyAiRetirement, retireAiTables } from "../../server/ai-retirement.mjs";

async function fixture(t, dialect) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "frame-ai-retire-"));
  let db, admin, schema;
  t.after(async () => { await db?.pool.end();
    if (admin) { await admin.query('DROP DATABASE "' + schema + '"'); await admin.end(); }
    await fs.rm(data, { recursive: true, force: true }); });
  if (dialect === "sqlite") db = await sqliteDatabase(path.join(data, "fixture.sqlite"));
  else {
    const url = new URL(process.env.FRAME_TEST_DATABASE_URL); assert.match(url.pathname, /frame_test/);
    const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
    admin = new pg.Client({ connectionString: adminUrl.href }); await admin.connect();
    schema = "frame_test_ai_retire_" + randomUUID().replaceAll("-", ""); await admin.query('CREATE DATABASE "' + schema + '"');
    url.pathname = "/" + schema;
    db = await database(url.href, "fixture-retirement-password");
  }
  const repo = randomUUID(), work = randomUUID(), report = randomUUID(), api = randomUUID(), official = randomUUID();
  const secrets = vault("aa".repeat(32));
  await db.pool.query("INSERT INTO repos(id,name) VALUES($1,'Fixture')", [repo]);
  await db.pool.query("INSERT INTO works(id,repo,project,title) VALUES($1,$2,'fixture','Fixture')", [work,repo]);
  await db.pool.query(`CREATE TABLE connections(id text PRIMARY KEY,name text,tool text,mode text,config text,state text);
    CREATE TABLE paseo_schema_migrations(id text PRIMARY KEY,checksum text);
    CREATE TABLE paseo_work_bindings(work_id text PRIMARY KEY,repo text,project text,revision text,generation bigint,requested boolean,state text,runtime_fingerprint text,created text,updated text,touched text);
    CREATE TABLE paseo_validations(id text PRIMARY KEY,work_id text,revision text,generation bigint,runtime_fingerprint text,state text,result ${dialect === "sqlite" ? "json" : "jsonb"},error text,created text,updated text);
    CREATE TABLE paseo_message_contexts(work_id text,thread_id text,message_id text);
    CREATE TABLE paseo_message_assets(asset text);`);
  for (const item of retiredSchema) await db.pool.query("INSERT INTO paseo_schema_migrations VALUES($1,$2)", [item.id,item.checksum]);
  for (const [id,name,tool,mode,config] of [[api,"Claude Custom","claude","api",{apiKey:"private-retirement-fixture",baseUrl:"http://native.fixture",model:"model-local"}],
    [official,"Official without source credential","codex","official",{}]])
    await db.pool.query("INSERT INTO connections VALUES($1,$2,$3,$4,$5,'ready')", [id,name,tool,mode,secrets.encrypt(config)]);
  const date = "2026-10-04T00:00:00.000Z", revision = "a".repeat(64), fingerprint = "b".repeat(64);
  await db.pool.query("INSERT INTO paseo_work_bindings VALUES($1,$2,'fixture',$3,7,false,'stopped',$4,$5,$5,$5)", [work,repo,revision,fingerprint,date]);
  await db.pool.query("INSERT INTO paseo_validations VALUES($1,$2,$3,7,$4,'passed',$5,NULL,$6,$6)",
    [report,work,revision,fingerprint,{validation:[{name:"runtime",status:"passed"}],status:"passed",modeFingerprint:revision},date]);
  return {db,data,secrets,repo,work,report,api,official};
}
function nativeConfig(settings) {
  return { settings: structuredClone(settings), environment: { environmentId: "fixture" },
    providers: Object.entries(settings.providerInstances).map(([instanceId,item]) => ({
      instanceId, driver: item.driver, enabled: item.enabled, installed: item.enabled,
      version: item.enabled ? "fixture" : null, status: item.enabled ? "ready" : "disabled",
      auth: { status: item.driver === "claudeAgent" ? "authenticated" : "unauthenticated" },
    })) };
}
for (const dialect of ["sqlite","postgres"]) {
  const options = { skip: dialect === "postgres" && !process.env.FRAME_TEST_DATABASE_URL };
  test(`${dialect}: provider import preserves API credential and absent official authentication; reports survive receipt-checked retirement`, options, async t => {
    const f = await fixture(t,dialect);
    const prepared = await prepareAiRetirement(f); assert.deepEqual(prepared, {phase:"prepared",profiles:2,reports:1,temporaryConnections:0});
    assert.equal((await f.db.one("SELECT generation FROM ai_validations WHERE id=$1", [f.report])).generation.toString(), "7");
    const config = JSON.parse(await fs.readFile(path.join(f.data,"ai/t3/userdata/settings.json"),"utf8"));
    assert.equal(config.providerInstances["frame_"+f.api].driver,"claudeAgent");
    const claude = JSON.parse(await fs.readFile(path.join(f.data,"ai/cli/frame_"+f.api,"settings.json"),"utf8"));
    assert.equal(claude.env.ANTHROPIC_API_KEY,"private-retirement-fixture");
    const proof = JSON.parse(await fs.readFile(path.join(f.data,"ai/shared/retirement.json"),"utf8"));
    assert.equal(proof.profiles.find(item=>item.instanceId==="frame_"+f.official).sourceAuth,"absent");
    await assert.rejects(retireAiTables(f), /Verify migrated/);
    const native = nativeConfig(config);
    await assert.rejects(verifyAiRetirement({...f,client:{config:async()=>({...native,providers:[]})}}), /live T3 registry/);
    await verifyAiRetirement({...f,client:{config:async()=>native}});
    assert.equal((await retireAiTables(f)).phase,"retired");
    assert.equal((await f.db.all("SELECT * FROM ai_validations")).length,1);
    assert.equal((await f.db.all("SELECT * FROM works")).length,1);
    assert.equal((await retireAiTables(f)).phase,"retired");
  });
  test(`${dialect}: verification rejects changed native settings, registration and unavailable enabled binary before table deletion`, options, async t => {
    const f = await fixture(t,dialect); await prepareAiRetirement(f);
    const settings = JSON.parse(await fs.readFile(path.join(f.data,"ai/t3/userdata/settings.json"),"utf8"));
    const instanceId = "frame_" + f.api;
    const cases = [
      ["home mismatch", value => { value.settings.providerInstances[instanceId].config.homePath += "-different"; }],
      ["missing settings", value => { delete value.settings.providerInstances[instanceId]; }],
      ["settings driver mismatch", value => { value.settings.providerInstances[instanceId].driver = "codex"; }],
      ["settings enabled mismatch", value => { value.settings.providerInstances[instanceId].enabled = false; }],
      ["registry driver mismatch", value => { value.providers.find(item => item.instanceId === instanceId).driver = "codex"; }],
      ["registry enabled mismatch", value => { value.providers.find(item => item.instanceId === instanceId).enabled = false; }],
      ["enabled binary unavailable", value => { value.providers.find(item => item.instanceId === instanceId).installed = false; }],
      ["enabled binary unreported", value => { delete value.providers.find(item => item.instanceId === instanceId).installed; }],
    ];
    for (const [label, change] of cases) {
      const config = nativeConfig(settings); change(config);
      await assert.rejects(verifyAiRetirement({...f,client:{config:async()=>config}}), /live T3 registry/, label);
      assert.equal((await f.db.all("SELECT * FROM connections")).length,2,label);
      assert.equal(JSON.parse(await fs.readFile(path.join(f.data,"ai/shared/retirement.json"),"utf8")).phase,"prepared",label);
    }
  });
  test(`${dialect}: disabled official profile without installed binary or login survives verified retirement`, options, async t => {
    const f = await fixture(t,dialect);
    await f.db.pool.query("UPDATE connections SET state='deleted' WHERE id=$1", [f.official]);
    await prepareAiRetirement(f);
    const settings = JSON.parse(await fs.readFile(path.join(f.data,"ai/t3/userdata/settings.json"),"utf8"));
    const config = nativeConfig(settings), official = config.providers.find(item => item.instanceId === "frame_" + f.official);
    assert.equal(official.enabled,false); assert.equal(official.installed,false); assert.equal(official.status,"disabled");
    assert.equal(official.auth.status,"unauthenticated");
    await assert.rejects(fs.access(path.join(f.data,"ai/cli/frame_"+f.official,"auth.json")), {code:"ENOENT"});
    assert.equal((await verifyAiRetirement({...f,client:{config:async()=>config}})).phase,"verified");
    assert.equal((await retireAiTables(f)).phase,"retired");
    assert.equal((await f.db.all("SELECT * FROM ai_validations")).length,1);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.data,"ai/t3/userdata/settings.json"),"utf8")).providerInstances["frame_"+f.official].enabled,false);
  });
  test(`${dialect}: preparation refuses retained history and credential changes block table deletion`, options, async t => {
    const f=await fixture(t,dialect);
    await f.db.pool.query("INSERT INTO paseo_message_contexts VALUES($1,'native-old',$2)",[f.work,randomUUID()]);
    await assert.rejects(prepareAiRetirement(f), /Retained native history/);
    assert.equal((await f.db.all("SELECT * FROM connections")).length,2);
    await f.db.pool.query("DELETE FROM paseo_message_contexts"); await prepareAiRetirement(f);
    await fs.writeFile(path.join(f.data,"ai/cli/frame_"+f.api,"settings.json"),"{}");
    await assert.rejects(verifyAiRetirement({...f,client:{config:async()=>{throw Error("must not contact native with changed source");}}}), /credential changed/);
    assert.equal((await f.db.all("SELECT * FROM connections")).length,2);
  });
}
