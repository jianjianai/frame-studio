import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";

const root = path.resolve(import.meta.dirname, "../..");
async function plugin(t, fetcher) {
  const directory = path.join(root, ".cache/paseo-plugin-tests", randomUUID());
  await fs.mkdir(directory, { recursive: true });
  const source = await fs.readFile(
    path.join(root, "integrations/paseo/frame-plugin/index.server.ts"),
    "utf8",
  );
  const backend = await fs.readFile(
    path.join(root, "integrations/paseo/frame-plugin/server/backend.ts"),
    "utf8",
  );
  const file = path.join(directory, "plugin.mjs");
  await fs.writeFile(
    file,
    stripTypeScriptTypes(source).replace(
      'from "./server/backend"',
      'from "./backend.mjs"',
    ),
  );
  await fs.writeFile(
    path.join(directory, "backend.mjs"),
    stripTypeScriptTypes(backend),
  );
  const env = {
    FRAME_PASEO_WORK_ID: randomUUID(),
    FRAME_PASEO_TOKEN: "a".repeat(48),
    FRAME_AGENT_TOKEN: "a".repeat(48),
  };
  env.FRAME_PASEO_URL =
    "http://frame.internal/api/paseo/internal/" + env.FRAME_PASEO_WORK_ID;
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, env);
  globalThis.fetch = fetcher(env);
  t.after(async () => {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(env))
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    await fs.rm(directory, { recursive: true, force: true });
  });
  const before = new Map(),
    events = new Map();
  const server = {
    before(name, callback) {
      before.set(name, callback);
      return () => before.delete(name);
    },
    on(name, callback) {
      events.set(name, callback);
      return () => events.delete(name);
    },
  };
  const contribution = (await import(pathToFileURL(file).href)).default;
  const cleanup = contribution(server);
  return {
    before,
    events,
    cleanup,
    env,
    context: { signal: new AbortController().signal },
  };
}

test("Official FRAME plugin uses create/session_open lifecycle hooks and never persists selected credentials in public config", async (t) => {
  const calls = [];
  let opens = 0;
  const f = await plugin(t, (env) => async (url, options) => {
    calls.push({ url, options });
    assert.equal(
      options.headers.authorization,
      "Bearer " + env.FRAME_PASEO_TOKEN,
    );
    assert.equal(options.redirect, "error");
    if (url.endsWith("/context"))
      return Response.json({
        version: 1,
        workId: env.FRAME_PASEO_WORK_ID,
        project: "fixture",
        instructions: "Authoritative FRAME scoped instructions 绝对时间",
      });
    if (url.endsWith("/session-open")) {
      opens++;
      return Response.json({
        version: 1,
        env: {
          OPENAI_API_KEY: "current-" + opens,
          CODEX_HOME: "/paseo-home/profiles/selected",
        },
      });
    }
    return Response.json({ version: 1, accepted: true });
  });
  const config = {
    provider: "frame-selected",
    cwd: "/workspace",
    systemPrompt: "User native instruction",
  };
  const created = await f.before.get("agent.create")(
    { request: { config } },
    f.context,
  );
  assert.match(
    created.config.systemPrompt,
    /User native instruction[\s\S]*Authoritative FRAME/,
  );
  assert.match(
    created.config.systemPrompt,
    /Managed Git worktrees remain isolated/,
  );
  assert.match(
    created.config.systemPrompt,
    /merge a worktree into the main workspace/,
  );
  assert.equal(created.env, undefined);
  assert.doesNotMatch(JSON.stringify(created), /OPENAI_API_KEY|current-/);
  assert.equal(config.systemPrompt, "User native instruction");
  await f.before.get("agent.create")({ request: { config } }, f.context);
  assert.equal(calls.filter((call) => call.url.endsWith("/context")).length, 1);
  const opening = {
    agentId: "native-agent",
    provider: "frame-selected",
    cwd: "/workspace",
    workspaceId: "workspace-one",
    reason: "create",
    purpose: "interactive",
    env: { OPENAI_API_KEY: "stale", USER_SETTING: "kept" },
  };
  const first = await f.before.get("agent.session_open")(
    { request: opening },
    f.context,
  );
  const second = await f.before.get("agent.session_open")(
    { request: { ...opening, reason: "resume" } },
    f.context,
  );
  assert.equal(first.env.OPENAI_API_KEY, "current-1");
  assert.equal(second.env.OPENAI_API_KEY, "current-2");
  assert.equal(first.env.USER_SETTING, "kept");
  const body = JSON.parse(
    calls.find((call) => call.url.endsWith("/session-open")).options.body,
  );
  assert.equal(body.env, undefined);
  assert.equal(body.version, 1);
  assert.equal(first.env.FRAME_PASEO_WORK_ID, f.env.FRAME_PASEO_WORK_ID);
  await f.events.get("agent.turn_ended")(
    {
      agent: { id: "native-agent", workspaceId: null },
      timeline: [{ secret: "private-user-source" }],
      outcome: { kind: "failed", error: { message: "private-user-source" } },
    },
    f.context,
  );
  const event = JSON.parse(calls.at(-1).options.body);
  assert.deepEqual(event, {
    version: 1,
    type: "agent.turn_ended",
    agentId: "native-agent",
  });
  f.cleanup();
  assert.equal(f.before.size, 0);
  assert.equal(f.events.size, 0);
});

test("Required native session credential failures are visible while passive lifecycle hints remain retryable and non-secret", async (t) => {
  const f = await plugin(
    t,
    () => async () =>
      Response.json({ password: "must-not-leak" }, { status: 401 }),
  );
  const opening = {
    agentId: "native-agent",
    provider: "frame-selected",
    cwd: "/workspace",
    workspaceId: null,
    reason: "resume",
    purpose: "interactive",
    env: {},
  };
  await assert.rejects(
    f.before.get("agent.session_open")({ request: opening }, f.context),
    (error) => {
      assert.match(error.message, /failed \(401\)/);
      assert.doesNotMatch(error.message, /must-not-leak|Bearer|aaaaaaaa/);
      return true;
    },
  );
  await f.events.get("agent.created")(
    { agent: { id: "native-agent", workspaceId: null } },
    f.context,
  );
  f.cleanup();
});
