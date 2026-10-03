import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { Connections } from "../../server/connections.mjs";
import { createApp } from "../../server/app.mjs";
import { vault } from "../../server/security.mjs";

async function fixture(t, { appOwnsDatabase = false } = {}) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "frame-provider-retirement-"));
  const db = await sqliteDatabase(path.join(data, "fixture.sqlite"));
  const key = "91".repeat(32), secrets = vault(key);
  const connections = new Connections(db, data, secrets);
  t.after(async () => {
    connections.close();
    if (!appOwnsDatabase) await db.pool.end();
    await fs.rm(data, { recursive: true, force: true });
  });
  return { db, data, key, secrets, connections };
}

test("retired singleton credentials migrate independently and reuse a stored provider without overwriting user preferences", async t => {
  const f = await fixture(t);
  const codex = { apiKey: "owned-legacy-codex-secret", baseUrl: "https://owned.invalid/v1/", model: "old-model" };
  const claude = { apiKey: "owned-legacy-claude-secret", baseUrl: "https://owned-claude.invalid", model: "claude-model" };
  await f.db.setting("codex", { encrypted: f.secrets.encrypt(codex) });
  await f.db.setting("claude", { encrypted: f.secrets.encrypt(claude) });
  await f.db.setting("github", { encrypted: f.secrets.encrypt({ token: "owned-github-token" }) });
  const existing = await f.connections.save({ name: "User profile", tool: "codex", mode: "api", ...codex, model: "user-model", enabled: false });
  await f.connections.migrate();
  const rows = await f.db.all("SELECT * FROM connections ORDER BY tool");
  assert.equal(rows.length, 2);
  const saved = rows.find(row => row.id === existing.id);
  assert.equal(saved.name, "User profile");
  assert.equal(f.secrets.decrypt(saved.config).model, "user-model");
  assert.equal(f.secrets.decrypt(saved.config).enabled, false);
  assert.equal(f.secrets.decrypt(rows.find(row => row.tool === "claude").config).apiKey, claude.apiKey);
  assert.equal(await f.db.setting("codex"), undefined);
  assert.equal(await f.db.setting("claude"), undefined);
  assert.ok(await f.db.setting("github"));
  await f.connections.migrate();
  assert.equal((await f.db.all("SELECT id FROM connections")).length, 2);
});

test("failed credential persistence retains the singleton and a lost save response is safely resumable", async t => {
  const f = await fixture(t);
  const value = { encrypted: f.secrets.encrypt({ apiKey: "owned-unmigrated-secret", model: "owned-model" }) };
  await f.db.setting("codex", value);
  const save = f.connections.save.bind(f.connections);
  f.connections.save = async () => { throw Error("Owned persistence failure"); };
  await assert.rejects(f.connections.migrate(), /persistence failure/);
  assert.deepEqual(await f.db.setting("codex"), value);
  f.connections.save = async input => { await save(input); throw Error("Owned lost save response"); };
  await assert.rejects(f.connections.migrate(), /lost save response/);
  assert.deepEqual(await f.db.setting("codex"), value);
  f.connections.save = save;
  await f.connections.migrate();
  assert.equal(await f.db.setting("codex"), undefined);
  assert.equal((await f.db.all("SELECT id FROM connections")).length, 1);
});

test("platform rejects the retired AI settings API and retains GitHub compatibility", async t => {
  const f = await fixture(t, { appOwnsDatabase: true });
  const { app, actions } = await createApp({ db: f.db, data: f.data, masterKey: f.key, scheduler: false, localMode: true });
  try {
    for (const provider of ["codex", "claude"]) {
      await assert.rejects(actions.call("settings_save", { provider, secret: "owned-retired-api-secret" }), error => error.name === "ZodError");
      assert.equal(await f.db.setting(provider), undefined);
    }
    await actions.call("settings_save", { provider: "github", secret: "owned-github-compatible" });
    const settings = await actions.call("settings_get");
    assert.equal(settings.github.configured, true);
    assert.equal(settings.codex, undefined);
    assert.equal(settings.claude, undefined);
    assert.equal(f.secrets.decrypt((await f.db.setting("github")).encrypted).token, "owned-github-compatible");
  } finally {
    await app.close();
  }
});
