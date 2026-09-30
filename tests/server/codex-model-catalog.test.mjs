import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverCodexModels } from "../../server/codex-model-catalog.mjs";
import { Connections } from "../../server/connections.mjs";
import { providerModelsSchema } from "../../src/contracts/ai-models.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sqliteDatabase } from "../../server/sqlite.mjs";

test("SQLite sync preserves concurrent config and rejects identity/CAS changes", async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "frame-catalog-cas-"));
  const db = await sqliteDatabase(path.join(data, "frame.sqlite"));
  t.after(async () => {
    await db.pool.end();
    await fs.rm(data, { recursive: true, force: true });
  });
  const connections = new Connections(db, data, {
    encrypt: JSON.stringify,
    decrypt: JSON.parse,
  });
  const read = async (id) =>
    JSON.parse(
      (await db.one("SELECT config FROM connections WHERE id=$1", [id])).config,
    );
  for (const scenario of ["config", "identity", "cas"]) {
    const id = randomUUID();
    await db.pool.query(
      "INSERT INTO connections(id,name,tool,mode,state,config) VALUES($1,'Codex','codex','official','ready',$2)",
      [
        id,
        JSON.stringify({
          model: "saved",
          models: [{ id: "saved", name: "Saved", enabled: true }],
        }),
      ],
    );
    connections.codexCatalogLoader = async () => {
      if (scenario === "identity")
        await db.pool.query(
          "UPDATE connections SET auth_generation=auth_generation+1 WHERE id=$1",
          [id],
        );
      if (scenario === "config") {
        const config = await read(id);
        config.newerSetting = "preserved";
        await db.pool.query("UPDATE connections SET config=$2 WHERE id=$1", [
          id,
          JSON.stringify(config),
        ]);
      }
      return catalog();
    };
    const query = db.pool.query;
    let raced = false;
    if (scenario === "cas")
      db.pool.query = async (sql, args) => {
        if (
          !raced &&
          sql.startsWith("UPDATE connections SET config=$2 WHERE")
        ) {
          raced = true;
          const config = await read(id);
          config.newerSetting = "last-moment";
          await query("UPDATE connections SET config=$2 WHERE id=$1", [
            id,
            JSON.stringify(config),
          ]);
        }
        return query(sql, args);
      };
    try {
      if (scenario === "config") {
        await connections.syncModels(id);
        const config = await read(id);
        assert.equal(config.newerSetting, "preserved");
        assert.equal(config.model, "saved");
        assert.deepEqual(
          config.models.map((model) => model.id),
          ["saved", "native-one"],
        );
      } else {
        await assert.rejects(connections.syncModels(id), { statusCode: 409 });
        const config = await read(id);
        assert.deepEqual(
          config.models.map((model) => model.id),
          ["saved"],
        );
        if (scenario === "cas")
          assert.equal(config.newerSetting, "last-moment");
      }
    } finally {
      db.pool.query = query;
    }
  }
});

const fixture = fileURLToPath(
  new URL("./fixtures/codex-model-catalog.mjs", import.meta.url),
);
const discover = (scenario = "paged", extra = {}) =>
  discoverCodexModels(
    { publicCatalog: false },
    {
      bin: process.execPath,
      env: { ...process.env, FRAME_CATALOG_FIXTURE: scenario },
      spawnProcess: (bin, args, options) => {
        assert.equal(args[0], "app-server");
        assert(args.includes('model_provider="openai"'));
        return spawn(bin, [fixture], options);
      },
      ...extra,
    },
  );
test("native Codex catalog uses account handshake, pagination, model IDs and advertised parameters without inference", async () => {
  const result = await discover();
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["native-one", "native-two"],
  );
  assert.equal(result.defaultModel, "native-one");
  assert.equal(result.pages, 2);
  assert.equal(result.skipped, 2);
  assert.equal(result.truncated, false);
  const metadata = result.models[0].metadata;
  assert.equal(metadata.name, "Native One");
  assert.equal(metadata.contextWindow, 300000);
  assert.equal(metadata.maxOutputTokens, 40000);
  assert.deepEqual(metadata.reasoningEfforts, ["low", "medium", "max"]);
  assert.equal(metadata.defaultReasoningEffort, "medium");
  assert.equal(metadata.reasoning, true);
  assert.equal(metadata.vision, true);
  assert.deepEqual(metadata.inputModalities, ["text", "image"]);
  assert.equal(metadata.sources.defaultReasoningEffort, "api");
  assert(providerModelsSchema.safeParse(result.models).success);
});
test("native catalog rejects wrong login, protocol failures and empty catalogs without exposing upstream secrets", async () => {
  for (const scenario of ["api-account", "error", "invalid", "empty"]) {
    await assert.rejects(discover(scenario), (error) => {
      assert(!error.message.includes("secret-fixture-token"));
      assert.equal(error.expose, true);
      return /登录|工具|目录/.test(error.message);
    });
  }
});
test("native catalog bounds repeated cursors, response bytes and total runtime", async () => {
  const repeated = await discover("cycle");
  assert.equal(repeated.truncated, true);
  assert.equal(repeated.models.length, 1);
  assert(repeated.warnings.length > 0);
  await assert.rejects(discover("oversize"), /过大/);
  await assert.rejects(discover("timeout", { timeout: 100 }), /超时/);
});

function connectionFixture(config = {}) {
  const row = {
    id: "fixture-id",
    name: "Codex",
    tool: "codex",
    mode: "official",
    state: "ready",
    auth_generation: 1,
    config: JSON.stringify({ model: "", models: [], ...config }),
  };
  let writes = 0;
  const db = {
    one: async () => ({ ...row }),
    lock: async (_key, fn) => fn(),
    pool: {
      query: async (_sql, args) => {
        if (
          row.config !== args[2] ||
          row.state !== "ready" ||
          row.auth_generation !== args[3]
        )
          return { rowCount: 0 };
        row.config = args[1];
        writes++;
        return { rowCount: 1 };
      },
    },
  };
  const connections = new Connections(db, "/fixture-data", {
    decrypt: JSON.parse,
    encrypt: JSON.stringify,
  });
  return {
    row,
    connections,
    config: () => JSON.parse(row.config),
    writes: () => writes,
  };
}
const catalog = async () => ({
  models: [
    {
      id: "native-one",
      name: "Native One",
      enabled: true,
      metadata: {
        name: "Native One",
        contextWindow: 300000,
        sources: { name: "api", contextWindow: "api" },
        fetchedAt: "2026-09-30T00:00:00.000Z",
      },
    },
  ],
  warnings: [],
  defaultModel: "native-one",
  fetchedAt: "2026-09-30T00:00:00.000Z",
  truncated: false,
});

test("automatic sync preserves newer config, custom names, disabled models, overrides and the selected default", async () => {
  const f = connectionFixture({
    model: "native-one",
    models: [
      {
        id: "native-one",
        name: "My name",
        enabled: false,
        overrides: { contextWindow: 1234 },
      },
    ],
  });
  f.connections.codexCatalogLoader = async (_config, options) => {
    assert.equal(options.env.CODEX_HOME, "/fixture-data/auth/fixture-id/codex");
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.CODEX_API_KEY, undefined);
    const current = f.config();
    current.newerSetting = "preserved";
    f.row.config = JSON.stringify(current);
    return catalog();
  };
  await f.connections.syncModels(f.row.id);
  assert.equal(f.config().newerSetting, "preserved");
  assert.equal(f.config().model, "native-one");
  assert.equal(f.config().models[0].name, "My name");
  assert.equal(f.config().models[0].enabled, false);
  assert.equal(f.config().models[0].overrides.contextWindow, 1234);
  assert.equal(f.config().models[0].metadata.contextWindow, 300000);
  assert.equal(f.config().modelCatalog.defaultModel, "native-one");
});
test("concurrent sync shares discovery and a failed refresh preserves account and model data", async () => {
  const f = connectionFixture({
    models: [{ id: "saved", name: "Saved", enabled: true }],
  });
  let calls = 0,
    finish;
  f.connections.codexCatalogLoader = () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const first = f.connections.syncModels(f.row.id),
    second = f.connections.syncModels(f.row.id);
  await new Promise((resolve) => setImmediate(resolve));
  finish(await catalog());
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  f.connections.codexCatalogLoader = async () => {
    throw Error("upstream-secret");
  };
  await assert.rejects(f.connections.syncModels(f.row.id), /同步失败/);
  assert.equal(f.row.state, "ready");
  assert.equal(f.config().models.length, 2);
  assert(!f.config().modelCatalog.error.includes("upstream-secret"));
});
test("sync cannot overwrite a changed account and respects the saved catalog capacity", async () => {
  const f = connectionFixture();
  f.connections.codexCatalogLoader = async () => {
    f.row.auth_generation++;
    return catalog();
  };
  await assert.rejects(f.connections.syncModels(f.row.id), /登录状态已改变/);
  assert.equal(f.writes(), 0);
  const full = connectionFixture({
    models: Array.from({ length: 200 }, (_, i) => ({
      id: "saved-" + i,
      name: "Saved",
      enabled: true,
    })),
  });
  full.connections.codexCatalogLoader = catalog;
  const result = await full.connections.syncModels(full.row.id);
  assert.equal(full.config().models.length, 200);
  assert(result.warnings.some((w) => /200/.test(w)));
});
