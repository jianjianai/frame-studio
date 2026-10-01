/** Test-only native Codex app-server protocol; does not call any paid provider. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const project = process.env.FRAME_PROJECT;
const capture = process.env.FRAME_FAKE_CAPTURE;
if (!capture || !/^[a-z][a-z0-9-]*$/.test(project || ""))
  throw Error("Missing owned fake-provider scope");
let buffer = "",
  threadId = "owned-" + randomUUID(),
  cwd = process.cwd(),
  turns = [];
const record = (value) =>
  fs.appendFileSync(capture, JSON.stringify(value) + "\n");
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => write({ method, params });
const respond = (message, result) => write({ id: message.id, result });
record({
  kind: "launch",
  pid: process.pid,
  cwd,
  project,
  frameCredentialInjected: !!process.env.FRAME_AGENT_TOKEN,
  apiCredentialInjected: !!process.env.OPENAI_API_KEY,
  hasMasterKey: !!process.env.FRAME_MASTER_KEY,
  hasDatabaseUrl: !!process.env.DATABASE_URL,
  hasTestDatabaseUrl: !!process.env.FRAME_TEST_DATABASE_URL,
});
async function turn(params, turnId) {
  const prompt = JSON.stringify(params.input || []);
  const itemId = "owned-item-" + randomUUID();
  notify("turn/started", {
    threadId,
    turn: { id: turnId, status: "inProgress", items: [] },
  });
  try {
    const projectDir = fs.realpathSync(path.join(cwd, "projects", project));
    const scene = path.join(projectDir, "scene.ts");
    const context = await execute(
      process.execPath,
      ["scripts/work-tool.mjs", "context"],
      {
        cwd,
        env: process.env,
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const parsed = JSON.parse(context.stdout);
    const assets = await execute(
      process.execPath,
      ["scripts/work-tool.mjs", "assets"],
      {
        cwd,
        env: process.env,
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const frameAssets = JSON.parse(assets.stdout);
    const before = fs.readFileSync(scene, "utf8");
    const marker = "\n// FRAME_NATIVE_WORKFLOW_APPLIED " + turnId + "\n";
    fs.writeFileSync(scene, before + marker);
    const preview = await execute(
      process.execPath,
      ["scripts/work-tool.mjs", "preview"],
      {
        cwd,
        env: process.env,
        encoding: "utf8",
        timeout: 40000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    record({
      kind: "accepted-turn",
      threadId,
      turnId,
      cwd,
      project,
      prompt,
      frameAssets,
      framePreview: JSON.parse(preview.stdout),
      frameContext: parsed,
      scenePath: scene,
      marker: marker.trim(),
    });
    const text = "FRAME_NATIVE_WORKFLOW_COMPLETE";
    notify("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId,
      delta: text,
    });
    const item = { id: itemId, type: "agentMessage", text };
    notify("item/completed", { threadId, turnId, item });
    const complete = {
      id: turnId,
      status: "completed",
      error: null,
      items: [item],
    };
    turns.push(complete);
    notify("turn/completed", { threadId, turn: complete });
  } catch (error) {
    record({
      kind: "owned-turn-error",
      name: error.name,
      message: error.message,
    });
    notify("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status: "failed",
        error: { message: "Owned native fixture failed" },
        items: [],
      },
    });
  }
}
async function handle(message) {
  if (message.id === undefined) return;
  const { method, params = {} } = message;
  if (method === "initialize")
    return respond(message, { userAgent: "FRAME-owned-native-fixture" });
  if (method === "model/list")
    return respond(message, {
      data: [
        {
          id: "owned-model",
          model: "owned-model",
          displayName: "Owned fixture model",
          isDefault: true,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
        },
      ],
      nextCursor: null,
    });
  if (method === "config/read" || method === "getUserSavedConfig")
    return respond(message, { config: {} });
  if (method === "skills/list" || method === "collaborationMode/list")
    return respond(message, { data: [] });
  if (method === "account/read")
    return respond(message, {
      account: { type: "apiKey" },
      requiresOpenaiAuth: false,
    });
  if (method === "thread/start" || method === "thread/resume") {
    cwd = params.cwd || cwd;
    threadId = params.threadId || threadId;
    record({
      kind: "thread",
      method,
      threadId,
      cwd,
      provider: params.modelProvider,
      envKeyConfigured: !!params.config?.model_providers?.paseo?.env_key,
    });
    return respond(message, {
      thread: {
        id: threadId,
        cwd,
        turns,
        status: { type: "idle" },
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        preview: "Owned fixture",
        modelProvider: "openai",
      },
    });
  }
  if (method === "thread/read")
    return respond(message, {
      thread: { id: params.threadId || threadId, cwd, turns },
    });
  if (method === "thread/list")
    return respond(message, { data: [], nextCursor: null });
  if (method === "turn/start") {
    const turnId = "owned-turn-" + randomUUID();
    respond(message, {
      turn: { id: turnId, status: "inProgress", items: [] },
    });
    setTimeout(() => void turn(params, turnId), 40);
    return;
  }
  if (method === "turn/interrupt") return respond(message, {});
  respond(message, {});
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim())
      void handle(JSON.parse(line)).catch((error) => {
        record({
          kind: "protocol-error",
          name: error.name,
          message: error.message,
        });
        process.exitCode = 1;
      });
  }
});
