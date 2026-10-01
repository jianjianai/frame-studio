import test from "node:test";
import { insertLegacyChat, legacyAgentTask } from "./legacy-agent-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  modelIdSchema,
  providerModelsSchema,
  providerModels,
  providerAvailable,
} from "../../src/contracts/ai-models.mjs";
import {
  discoverModels as discoverProviderModels,
  recordConnectionTest,
} from "../../server/provider-catalog.mjs";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";

const discoverModels = (config, fetcher) =>
  discoverProviderModels(config, fetcher, async () => ({}));

const models = [
  { id: "model-small", name: "快速模型", enabled: true },
  { id: "model-large", name: "主力模型", enabled: true },
];
test("provider model catalog validates identity, limits, defaults and legacy connections", () => {
  assert.deepEqual(providerModels({ model: "legacy" }), [
    { id: "legacy", name: "legacy", enabled: true },
  ]);
  assert.equal(providerModels({ mode: "official", models }).at(0).id, "");
  assert.equal(providerModels({ mode: "api", models }).length, 2);
  assert.equal(
    providerModelsSchema.safeParse([models[0], models[0]]).success,
    false,
  );
  assert.equal(
    providerModelsSchema.safeParse(
      Array.from({ length: 201 }, (_, i) => ({
        id: String(i),
        name: String(i),
      })),
    ).success,
    false,
  );
  assert.equal(modelIdSchema.safeParse("bad\nmodel").success, false);
  assert.equal(
    modelIdSchema.safeParse("--model").success,
    false,
    "model IDs cannot be interpreted as CLI flags",
  );
  assert.equal(providerAvailable({ configured: true, enabled: false }), false);
  assert.equal(
    providerAvailable({ configured: true, state: "expired" }),
    false,
  );
  assert.equal(providerAvailable({ configured: true, state: "ready" }), true);
});

test("model discovery is bounded, deduplicated, protocol-aware and never follows credential redirects", async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push({ url, options });
    return new Response(
      JSON.stringify({
        data: [
          { id: "one", display_name: "Model One" },
          { id: "one" },
          { id: "two" },
          { id: "bad\u0000id" },
        ],
      }),
    );
  };
  const config = {
    mode: "api",
    tool: "codex",
    apiKey: "fixture-only-key",
    baseUrl: "https://provider.invalid/v1/",
  };
  const result = await discoverModels(config, fetcher);
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["one", "two"],
  );
  assert.equal(result.models[0].name, "Model One");
  assert.equal(seen[0].url, "https://provider.invalid/v1/models");
  assert.equal(seen[0].options.redirect, "error");
  assert.equal(
    seen[0].options.headers.Authorization,
    "Bearer fixture-only-key",
  );
  await discoverModels(
    { ...config, tool: "claude", baseUrl: "https://provider.invalid" },
    fetcher,
  );
  assert.equal(seen[1].url, "https://provider.invalid/v1/models");
  assert.equal(seen[1].options.headers["x-api-key"], "fixture-only-key");
  await assert.rejects(
    discoverModels({ ...config, mode: "official" }, fetcher),
    /手动/,
  );
  await assert.rejects(
    discoverModels(
      config,
      async () =>
        new Response("failure-with-sensitive-details", { status: 401 }),
    ),
    /HTTP 401/,
  );
  await assert.rejects(
    discoverModels(config, async () => {
      throw Error("fixture-only-key");
    }),
    (error) =>
      !error.message.includes("fixture-only-key") && /失败/.test(error.message),
  );
  await assert.rejects(
    discoverModels(
      config,
      async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    ),
    /过大/,
  );
  await assert.rejects(
    discoverModels(config, async () => new Response("{}")),
    /标准模型目录/,
  );
  const capped = await discoverModels(
    config,
    async () =>
      new Response(
        JSON.stringify({
          data: Array.from({ length: 1005 }, (_, i) => ({ id: `m-${i}` })),
        }),
      ),
  );
  assert.equal(capped.models.length, 1000);
  assert.equal(capped.truncated, true);
});

test("late provider tests cannot overwrite changed credentials", async () => {
  let writes = 0;
  const connections = {
    db: {
      one: async () => ({
        config: { apiKey: "new-key", baseUrl: "https://new.invalid" },
      }),
      pool: {
        query: async () => {
          writes++;
        },
      },
    },
    secrets: { decrypt: (value) => value, encrypt: (value) => value },
  };
  await recordConnectionTest(
    connections,
    "id",
    { apiKey: "old-key", baseUrl: "https://new.invalid" },
    { ok: true },
  );
  assert.equal(writes, 0);
});

const url = process.env.FRAME_TEST_DATABASE_URL;
test(
  "provider multi-model configuration, frozen requests, live subscriptions and credential-safe tests",
  { skip: !url, timeout: 60000 },
  async () => {
    assert.match(new URL(url).pathname, /frame_test/);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-ai-models-"));
    const db = await database(url, "test-password-at-least-14");
    await db.pool.query("TRUNCATE repos,connections RESTART IDENTITY CASCADE");
    const origin = "http://frame.test";
    const { app, actions, tasks } = await createApp({
      db,
      data,
      masterKey: "22".repeat(32),
      scheduler: false,
      origin,
    });
    const call = (name, args = {}) => actions.call(name, args);
    const requests = [];
    const provider = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({
        path: request.url,
        body: body ? JSON.parse(body) : null,
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url.endsWith("/models")
            ? { data: models.map((model) => ({ id: model.id })) }
            : { output: [{ content: [{ text: "READY" }] }] },
        ),
      );
    });
    let ws;
    try {
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
      const input = {
        name: "团队提供商",
        tool: "codex",
        mode: "api",
        baseUrl,
        model: models[0].id,
        models,
        apiKey: "fixture-not-a-real-secret",
        publicCatalog: false,
      };
      let connection = await call("connections_save", input);
      assert.equal(connection.models.length, 2);
      assert(connection.revision);
      assert.equal(JSON.stringify(connection).includes(input.apiKey), false);
      assert.equal(connection.config, undefined);
      await assert.rejects(
        call("connections_save", {
          ...input,
          id: connection.id,
          model: "not-listed",
        }),
        /默认模型/,
      );
      await assert.rejects(
        call("connections_save", {
          ...input,
          id: connection.id,
          models: [models[0], models[0]],
        }),
        /重复/,
      );
      await assert.rejects(
        call("connections_save", {
          ...input,
          baseUrl: baseUrl + "?key=hidden",
        }),
        /URL/,
      );
      await assert.rejects(
        call("connections_save", {
          ...input,
          id: connection.id,
          tool: "claude",
        }),
        /another connection/,
      );
      const stale = connection.revision;
      connection = await call("connections_save", {
        ...input,
        id: connection.id,
        name: "团队已重命名",
        expectedRevision: stale,
      });
      await assert.rejects(
        call("connections_save", {
          ...input,
          id: connection.id,
          expectedRevision: stale,
        }),
        /其他位置更新/,
      );
      const repo = await call("repositories_add", { name: "AI 模型测试仓库" });
      const work = await call("works_create", {
        repo: repo.id,
        title: "模型测试",
      });
      const chat = await insertLegacyChat(db, work, {
        id: work.id,
        connection: connection.id,
        title: "多模型同一提供商",
      });
      const args = {
        id: work.id,
        chat: chat.id,
        prompt: "调整动作",
        model: models[1].id,
        requestKey: randomUUID(),
        context: { time: 2 },
      };
      const first = await legacyAgentTask(tasks, work, args);
      assert.equal(first.input.model, models[1].id);
      assert.equal(first.input.connection, connection.id);
      const second = await legacyAgentTask(tasks, work, {
        ...args,
        model: models[0].id,
        requestKey: randomUUID(),
      });
      assert.equal(second.chat, first.chat);
      assert.equal(second.input.model, models[0].id);
      await call("connections_save", {
        ...input,
        id: connection.id,
        name: connection.name,
        model: models[1].id,
      });
      assert.equal((await tasks.get(first.id)).input.model, models[1].id);
      assert.equal((await tasks.get(second.id)).input.model, models[0].id);
      await assert.rejects(
        legacyAgentTask(tasks, work, {
          ...args,
          requestKey: randomUUID(),
          model: "foreign-model",
        }),
        /不属于/,
      );
      await call("connections_enabled", { id: connection.id, enabled: false });
      await assert.rejects(
        legacyAgentTask(tasks, work, { ...args, requestKey: randomUUID() }),
        /停用/,
      );
      assert.equal(
        (await legacyAgentTask(tasks, work, args)).id,
        first.id,
        "lost acknowledgement remains recoverable after provider disable",
      );
      await assert.rejects(
        legacyAgentTask(tasks, work, { ...args, prompt: "different" }),
        /request key/,
      );
      await assert.rejects(
        legacyAgentTask(tasks, work, { ...args, model: models[0].id }),
        /request key/,
      );
      await call("connections_enabled", { id: connection.id, enabled: true });
      const tested = await call("connections_test", {
        id: connection.id,
        model: models[0].id,
      });
      assert.equal(tested.ok, true);
      assert.equal(requests.at(-1).body.model, models[0].id);
      connection = (await call("connections_list")).find(
        (row) => row.id === connection.id,
      );
      assert.equal(
        connection.model,
        models[1].id,
        "testing another model must not change provider default",
      );
      assert.equal(connection.lastTest.model, models[0].id);
      assert.equal(connection.lastTest.ok, true);
      assert.equal(JSON.stringify(connection).includes(input.apiKey), false);
      const discovered = await call("connections_discover", {
        id: connection.id,
      });
      assert.equal(discovered.models.length, 2);
      assert.equal(requests.at(-1).path, "/v1/models");
      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { origin },
        payload: { password: "test-password-at-least-14" },
      });
      assert.equal(login.statusCode, 200);
      const cookie = login.headers["set-cookie"].split(";")[0];
      await app.listen({ port: 0, host: "127.0.0.1" });
      ws = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/api/ws`, {
        headers: { origin, cookie },
      });
      await once(ws, "open");
      let incoming = once(ws, "message");
      ws.send(
        JSON.stringify({
          type: "subscribe",
          id: "model-catalog",
          name: "connections_list",
          args: {},
        }),
      );
      let update = JSON.parse(String((await incoming)[0]));
      assert.equal(update.error, undefined);
      assert.equal(update.result[0].enabled, true);
      incoming = once(ws, "message");
      await call("connections_enabled", { id: connection.id, enabled: false });
      update = JSON.parse(String((await incoming)[0]));
      assert.equal(
        update.result[0].enabled,
        false,
        "catalog changes reach subscribed composers without polling",
      );
      assert.equal(JSON.stringify(update).includes(input.apiKey), false);
    } finally {
      ws?.terminate();
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
