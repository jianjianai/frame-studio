import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAgentStream } from "../../server/agent-stream.mjs";
import {
  publicAgentData,
  publicAgentText,
} from "../../server/agent-public-data.mjs";
import { createAgentFileInspector } from "../../server/agent-file-changes.mjs";
import {
  createAgentTimeline,
  groupAgentItems,
  effectiveAgentPhase,
  latestAgentFiles,
} from "../../studio/agent/agent-timeline.js";

const rows = (events) =>
  events.map((data, n) => ({ id: String(n + 1), kind: data.type, data }));
test("Codex stream retains item order, public summary only, real command status, files and plan", () => {
  let time = 100;
  const adapter = createAgentStream({ now: () => (time += 10) }),
    events = [];
  const emit = (method, params) =>
    events.push(...adapter.feed({ method, params }));
  emit("item/started", {
    item: { id: "text", type: "agentMessage", text: "" },
  });
  emit("item/agentMessage/delta", { itemId: "text", delta: "开始" });
  emit("item/completed", {
    item: { id: "text", type: "agentMessage", text: "开始检查" },
  });
  emit("item/started", {
    item: {
      id: "reason",
      type: "reasoning",
      summary: [],
      content: ["PRIVATE_REASONING"],
    },
  });
  emit("item/reasoning/textDelta", {
    itemId: "reason",
    delta: "PRIVATE_REASONING",
  });
  emit("item/reasoning/summaryTextDelta", {
    itemId: "reason",
    summaryIndex: 0,
    delta: "检查同步",
  });
  emit("item/completed", {
    item: {
      id: "reason",
      type: "reasoning",
      summary: ["检查同步"],
      encrypted_content: "ENCRYPTED_PRIVATE",
    },
  });
  emit("item/started", {
    item: {
      id: "cmd",
      type: "commandExecution",
      command: "pnpm check",
      cwd: "/workspace",
      status: "inProgress",
    },
  });
  emit("item/commandExecution/outputDelta", {
    itemId: "cmd",
    delta: "checking\n",
  });
  emit("item/completed", {
    item: {
      id: "cmd",
      type: "commandExecution",
      command: "pnpm check",
      aggregatedOutput: "checking\nfailed",
      exitCode: 2,
      durationMs: 25,
      status: "failed",
    },
  });
  emit("turn/plan/updated", {
    turnId: "turn",
    plan: [
      { step: "检查", status: "completed" },
      { step: "修复", status: "inProgress" },
    ],
  });
  emit("item/completed", {
    item: {
      id: "change",
      type: "fileChange",
      status: "completed",
      changes: [
        {
          path: "scene.ts",
          kind: { type: "update" },
          diff: "@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    },
  });
  emit("item/completed", {
    item: { id: "final", type: "agentMessage", text: "已修复" },
  });
  const timeline = createAgentTimeline().update(rows(events));
  assert.deepEqual(
    timeline.items.map((i) => i.id),
    ["text", "reason", "cmd", "plan:turn", "change", "final"],
  );
  assert.equal(timeline.items[0].text, "开始检查");
  assert.equal(timeline.items[1].text, "检查同步");
  assert.equal(timeline.items[2].exitCode, 2);
  assert.equal(timeline.items[2].phase, "failed");
  assert.equal(timeline.items[2].output, "checking\nfailed");
  assert.equal(groupAgentItems(timeline.items).length, 3);
  assert(!JSON.stringify(events).includes("PRIVATE"));
  assert.equal(latestAgentFiles(timeline.items).files[0].path, "scene.ts");
});

test("Claude multi-block content, streaming snapshots and parallel tool results do not overwrite each other", () => {
  const adapter = createAgentStream(),
    events = [];
  const feed = (value) => events.push(...adapter.feed(value));
  feed({
    type: "stream_event",
    event: { type: "message_start", message: { id: "m1" } },
  });
  feed({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  });
  feed({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "先读取" },
    },
  });
  feed({
    type: "assistant",
    message: {
      id: "m1",
      content: [
        { type: "text", text: "先读取文件" },
        {
          type: "thinking",
          thinking: "检查关联引用",
          signature: "MUST_NOT_PERSIST",
        },
        {
          type: "tool_use",
          id: "read-1",
          name: "Read",
          input: { file_path: "scene.ts" },
        },
        {
          type: "tool_use",
          id: "cmd-1",
          name: "Bash",
          input: { command: "echo ready", description: "运行检查" },
        },
        { type: "redacted_thinking", data: "MUST_NOT_PERSIST" },
      ],
    },
  });
  feed({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "read-1", content: "source lines" },
        {
          type: "tool_result",
          tool_use_id: "cmd-1",
          content: "ready",
          is_error: true,
        },
      ],
    },
  });
  feed({
    type: "assistant",
    message: { id: "m2", content: [{ type: "text", text: "已检查" }] },
  });
  feed({
    type: "result",
    result: "已检查",
    usage: { input_tokens: 20, output_tokens: 8 },
  });
  const reducer = createAgentTimeline();
  const first = reducer.update(rows(events).slice(0, 2));
  assert.equal(first.items.length, 1);
  const all = reducer.update(rows(events));
  assert.deepEqual(
    all.items.map((i) => i.id),
    ["m1:0", "m1:1", "read-1", "cmd-1", "m2:0"],
  );
  assert.equal(all.items[0].text, "先读取文件");
  assert.equal(all.items[2].output, "source lines");
  assert.equal(all.items[3].kind, "command");
  assert.equal(all.items[3].phase, "failed");
  assert(!JSON.stringify(events).includes("MUST_NOT_PERSIST"));
  assert.deepEqual(
    reducer.update(rows(events)),
    all,
    "Re-rendering never appends deltas twice",
  );
  assert.equal(all.usage.usage.output_tokens, 8);
});

test("Long output, legacy messages, reset after history reload and incomplete end states stay truthful", () => {
  const reducer = createAgentTimeline();
  const values = rows([
    { type: "delta", text: "old" },
    { type: "message", id: "old", text: "old message" },
    {
      type: "activity",
      id: "tool",
      tool: "command",
      text: "echo 1",
      phase: "running",
    },
    {
      type: "agent-item",
      version: 1,
      id: "cmd",
      kind: "command",
      phase: "running",
      outputDelta: "x".repeat(50000),
      at: 1,
    },
  ]);
  const result = reducer.update(values);
  assert.equal(result.items[0].text, "old message");
  assert.equal(result.items.at(-1).output.length, 32000);
  assert(result.items.at(-1).outputTruncated);
  assert.equal(effectiveAgentPhase(result.items[1], "succeeded"), "ended");
  assert.equal(effectiveAgentPhase(result.items[1], "cancelled"), "cancelled");
  assert.equal(reducer.update(values.slice(0, 2)).items.length, 1);
  assert.equal(
    publicAgentData({
      password: "secret",
      signature: "signed",
      nested: { Authorization: "Bearer abcdefghijklmnop" },
    }).password,
    "[redacted]",
  );
  assert.equal(
    publicAgentText("TOKEN_SECRET_123", {
      env: { API_KEY: "TOKEN_SECRET_123" },
    }),
    "[redacted]",
  );
});

test("Isolated Git file inspection includes command-written, added, deleted, binary and link changes without touching another project", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-agent-diff-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const events = [];
  try {
    fs.mkdirSync(path.join(root, "projects/test-film"), { recursive: true });
    fs.mkdirSync(path.join(root, "projects/other-film"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects/test-film/scene.ts"), "old\n");
    fs.writeFileSync(
      path.join(root, "projects/test-film/removed.txt"),
      "remove\n",
    );
    fs.writeFileSync(
      path.join(root, "projects/other-film/scene.ts"),
      "other\n",
    );
    git("init", "-q");
    git("add", "projects");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@local",
      "commit",
      "-qm",
      "baseline",
    );
    const inspector = createAgentFileInspector({
      cwd: root,
      project: "test-film",
      baseline: git("rev-parse", "HEAD"),
      emit: (event) => events.push(event),
    });
    fs.writeFileSync(
      path.join(root, "projects/test-film/scene.ts"),
      "new\nline\n",
    );
    fs.unlinkSync(path.join(root, "projects/test-film/removed.txt"));
    fs.writeFileSync(
      path.join(root, "projects/test-film/new.txt"),
      "new file\n",
    );
    fs.writeFileSync(
      path.join(root, "projects/test-film/picture.bin"),
      Buffer.from([0, 255, 0, 13]),
    );
    fs.symlinkSync("/etc/passwd", path.join(root, "projects/test-film/link"));
    fs.writeFileSync(
      path.join(root, "projects/other-film/scene.ts"),
      "must not inspect\n",
    );
    await inspector();
    const result = events.at(-1);
    assert.equal(result.files.length, 5);
    assert(result.files.every((f) => f.path.startsWith("projects/test-film/")));
    assert.equal(
      result.files.find((f) => f.path.endsWith("scene.ts")).added,
      2,
    );
    assert.equal(
      result.files.find((f) => f.path.endsWith("removed.txt")).kind,
      "delete",
    );
    assert(result.files.find((f) => f.path.endsWith("picture.bin")).binary);
    assert(!JSON.stringify(result).includes("root:x:"));
    await inspector();
    assert.equal(
      events.length,
      1,
      "Unchanged diffs are not copied for every tool",
    );
    assert.equal(
      git("diff", "--cached", "--name-only"),
      "",
      "Inspection never stages files",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
