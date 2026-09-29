import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { execFileSync, spawnSync } from "node:child_process";
import { fixture, repo } from "../mcp/helpers.mjs";
import {
  creatorTaskIgnores,
  creatorPrompt,
} from "../../server/creator-workspace.mjs";
import { agentTools } from "../../server/agent-tools.mjs";
import {
  readCreatorContext,
  creatorSampleRange,
  checkCreatorWork,
} from "../../scripts/creator-context.mjs";
import { runWorkTool } from "../../scripts/work-tool.mjs";
import {
  readToolInput,
  callWorkTool,
  workToolHelp,
} from "../../scripts/work-tool-client.mjs";
import { inspectProjectScope } from "../../scripts/project-scope-report.mjs";
import { previewProgress } from "../../scripts/preview-audio.mjs";
import { runtimeIdentity } from "../../scripts/runtime-identity.mjs";
import { createProjectWorkspace } from "../../scripts/project-workspace.mjs";

function initGit(root) {
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    creatorTaskIgnores.join("\n") + "\n",
  );
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-b", "creator-fixture"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@localhost"]);
  // Only this newly-created disposable fixture is staged.
  git([
    "add",
    "--",
    ...fs
      .readdirSync(root)
      .filter((name) => ![".git", "node_modules", "task.json"].includes(name)),
  ]);
  git(["commit", "-qm", "fixture baseline"]);
}

async function httpFixture(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    env: {
      FRAME_AGENT_URL: `http://127.0.0.1:${server.address().port}`,
      FRAME_AGENT_TOKEN: "fixture-secret-token",
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

test("task preview progress is ignored without hiding real outside changes", () => {
  const f = fixture();
  const old = process.env.FRAME_TASK_PROGRESS_FILE;
  try {
    initGit(f.root);
    process.env.FRAME_TASK_PROGRESS_FILE = path.join(f.root, "progress.json");
    previewProgress("构建画面播放器");
    fs.writeFileSync(path.join(f.root, "progress.json.tmp"), "partial");
    assert.equal(inspectProjectScope(f.root, "test-film").passed, true);
    fs.writeFileSync(path.join(f.root, "unexpected.txt"), "outside");
    const result = inspectProjectScope(f.root, "test-film");
    assert.equal(result.passed, false);
    assert.deepEqual(result.externalWorkspaceChanges.shared.paths, [
      "unexpected.txt",
    ]);
    fs.writeFileSync(f.file("progress.json"), "project-owned");
    assert(
      inspectProjectScope(f.root, "test-film").projectChanges.paths.includes(
        "projects/test-film/progress.json",
      ),
    );
  } finally {
    if (old === undefined) delete process.env.FRAME_TASK_PROGRESS_FILE;
    else process.env.FRAME_TASK_PROGRESS_FILE = old;
    f.close();
  }
});

test("context identifies the active work and does not expose task credentials or execute code", () => {
  const f = fixture({ renderer: "canvas" });
  try {
    initGit(f.root);
    fs.writeFileSync(
      path.join(f.root, "task.json"),
      JSON.stringify({
        id: "fixture",
        kind: "agent",
        project: "test-film",
        input: {
          prompt: "private-user-prompt",
          context: { time: 0.5, assets: ["material-1"] },
        },
        apiKey: "DO_NOT_RETURN_THIS",
        previousTurns: [{ secret: "previous-secret" }],
      }),
    );
    fs.writeFileSync(f.file(".env"), "MY_SECRET=hidden");
    const result = readCreatorContext(f.root, {}, {});
    assert.equal(result.project, "test-film");
    assert.equal(result.entrypoints.scene, "./scene");
    assert.equal(result.focus.time, 0.5);
    assert.equal(result.focus.shot.at, 0);
    assert.deepEqual(result.request.assets, ["material-1"]);
    assert.equal(result.platformTools.available, false);
    for (const secret of [
      "DO_NOT_RETURN_THIS",
      "private-user-prompt",
      "previous-secret",
      "MY_SECRET",
    ])
      assert(!JSON.stringify(result).includes(secret));
    assert(!result.source.files.includes(".env"));
    assert.equal(result.acceptance.visual, "not_run");
    assert.throws(
      () => readCreatorContext(f.root, { project: "other-film" }, {}),
      { code: "PROJECT_MISMATCH" },
    );
  } finally {
    f.close();
  }
});

test("broken metadata and asset catalogs still provide repair context", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.file("public/assets.json"), "invalid-json");
    let result = readCreatorContext(f.root, { project: "test-film" }, {});
    assert.equal(result.status, "needs_repair");
    assert(
      result.engineering.issues.some((issue) => issue.code === "ASSET_CATALOG"),
    );
    fs.writeFileSync(f.file("project.ts"), "export default { broken syntax");
    result = readCreatorContext(f.root, { project: "test-film" }, {});
    assert.equal(result.status, "needs_repair");
    assert.equal(result.entrypoints.metadata, "project.ts");
    assert(result.source.files.includes("scene.ts"));
    assert(
      result.engineering.issues.some(
        (issue) => issue.code === "STATIC_METADATA",
      ),
    );
  } finally {
    f.close();
  }
});

test("old review timecodes require an explicit mapping and ranges are not silently stretched", () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      path.join(f.root, "task.json"),
      JSON.stringify({
        project: "test-film",
        input: { context: { start: 80, end: 90 } },
        reviewReference: {
          disposition: "compare-to-latest",
          sourceCommit: "a".repeat(40),
        },
      }),
    );
    const context = readCreatorContext(f.root, {}, {});
    assert.equal(context.focus.mapping, "requires_comparison");
    assert.equal(context.focus.time, null);
    assert.equal(context.focus.shot, null);
    assert.throws(() => creatorSampleRange(context, {}), {
      code: "REVIEW_MAPPING_REQUIRED",
    });
    assert.deepEqual(creatorSampleRange(context, { start: 0, end: 1 }), {
      start: 0,
      end: 1,
      sampled: true,
    });
    assert.throws(() => creatorSampleRange(context, { start: 0, end: 9 }), {
      code: "INVALID_SAMPLE_RANGE",
    });
  } finally {
    f.close();
  }
});

test("work tools expose structured help and reject malformed or ambiguous input without echoing it", async () => {
  assert.deepEqual(await runWorkTool(["help", "--json"]), workToolHelp);
  assert.equal(workToolHelp.remote.assets.offset.includes("integer"), true);
  await assert.rejects(
    readToolInput('{"apiKey":"SUPER_PRIVATE", bad'),
    (error) =>
      error.code === "INVALID_JSON" && !error.message.includes("SUPER_PRIVATE"),
  );
  for (const input of ["null", "[]", "42"])
    await assert.rejects(readToolInput(input), { code: "INVALID_INPUT" });
  assert.deepEqual(
    await readToolInput("-", Readable.from(['{"search":', '"背景"}'])),
    { search: "背景" },
  );
  await assert.rejects(
    readToolInput("-", Readable.from(["x".repeat(300000)])),
    { code: "INPUT_TOO_LARGE" },
  );
  await assert.rejects(runWorkTool(["check", '{"runtime":"true"}']), {
    code: "INVALID_ARGUMENTS",
  });
  await assert.rejects(runWorkTool(["check", '{"start":0}']), {
    code: "INVALID_ARGUMENTS",
  });
  await assert.rejects(runWorkTool(["assets", "{}", "extra"]), {
    code: "INVALID_ARGUMENTS",
  });
  await assert.rejects(callWorkTool("engines", {}, { env: {} }), {
    code: "TASK_REQUIRED",
  });
  const cli = spawnSync(
    process.execPath,
    [path.join(repo, "scripts/work-tool.mjs"), "assets", "not-json"],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, "");
  assert.equal(JSON.parse(cli.stdout).error.code, "INVALID_JSON");
});

test("task assets honor pagination but cannot override the repository", async () => {
  let route;
  const calls = [];
  agentTools({
    app: {
      post(_url, handler) {
        route = handler;
      },
    },
    actions: {
      async call(name, args) {
        calls.push({ name, args });
        return [];
      },
    },
  });
  const request = (args) =>
    route({
      agentTask: { repo: "current-repo" },
      body: { name: "assets", args },
    });
  await request({ limit: 15, offset: 60, search: "背景", repo: "other-repo" });
  assert.deepEqual(calls[0], {
    name: "assets_list",
    args: { limit: 15, offset: 60, search: "背景", repo: "current-repo" },
  });
  await request({});
  assert.equal(calls[1].args.limit, 60);
  for (const args of [
    { limit: 0 },
    { limit: 201 },
    { limit: "20" },
    { offset: -1 },
    { offset: 0.5 },
  ])
    await assert.rejects(request(args), /limit 1\.\.200/);
  assert.equal(calls.length, 2);
  await assert.rejects(request(null), /JSON object/);
  await assert.rejects(request([]), /JSON object/);
});

test("HTTP failures have actionable redacted errors and never replay speech", async () => {
  let requests = 0;
  const f = await httpFixture((req, res) => {
    requests++;
    res.writeHead(503, {
      "content-type": "application/json",
      "retry-after": "10",
    });
    res.end(
      JSON.stringify({
        message: "temporarily unavailable fixture-secret-token",
      }),
    );
  });
  try {
    await assert.rejects(
      callWorkTool("speech", { text: "hello" }, { env: f.env }),
      (error) =>
        error.code === "HTTP_503" &&
        error.outcome === "unknown" &&
        error.retryAfter === "10" &&
        !error.message.includes(f.env.FRAME_AGENT_TOKEN),
    );
    assert.equal(requests, 1);
  } finally {
    await f.close();
  }
});

test("transport handles HTML, redirects, response limits and deadlines without leaking raw responses", async () => {
  let mode = "html",
    requests = 0;
  const f = await httpFixture((req, res) => {
    requests++;
    if (mode === "timeout") return;
    if (mode === "redirect") {
      res.writeHead(302, { location: "/must-not-follow" });
      res.end();
      return;
    }
    if (mode === "large") {
      res.writeHead(200);
      res.end(JSON.stringify({ body: "x".repeat(1000) }));
      return;
    }
    if (mode === "success") {
      res.writeHead(200);
      res.end('[{"id":"asset-61"}]');
      return;
    }
    res.writeHead(502);
    res.end("<html>private-upstream-page</html>");
  });
  try {
    await assert.rejects(
      callWorkTool("engines", {}, { env: f.env }),
      (error) =>
        error.code === "INVALID_API_RESPONSE" &&
        !error.message.includes("private-upstream-page"),
    );
    mode = "redirect";
    await assert.rejects(callWorkTool("engines", {}, { env: f.env }), {
      code: "UNEXPECTED_REDIRECT",
    });
    assert.equal(requests, 2);
    mode = "large";
    await assert.rejects(
      callWorkTool("assets", {}, { env: f.env, maxBytes: 50 }),
      { code: "RESPONSE_TOO_LARGE" },
    );
    mode = "timeout";
    await assert.rejects(
      callWorkTool("speech", {}, { env: f.env, timeoutMs: 50 }),
      { code: "TASK_TIMEOUT", outcome: "unknown" },
    );
    mode = "success";
    assert.deepEqual(
      await callWorkTool("assets", { offset: 60 }, { env: f.env }),
      [{ id: "asset-61" }],
    );
    assert.equal(requests, 5);
  } finally {
    await f.close();
  }
});

test(
  "creator preflight runs real engineering/playback and reports failures without claiming content acceptance",
  { timeout: 120000 },
  async () => {
    const f = fixture({ browser: true });
    try {
      initGit(f.root);
      const result = await checkCreatorWork(
        f.root,
        { project: "test-film", runtime: true, start: 0, end: 0.8 },
        {},
      );
      assert.equal(result.status, "passed", JSON.stringify(result));
      assert.equal(result.stages.playback, "passed");
      assert.equal(result.stages.storyboard, "passed");
      assert.equal(result.stages.tests, "not_run");
      assert(fs.existsSync(result.artifacts.storyboard));
      assert.equal(result.contentReview.listening, "not_run");
      assert.equal(result.stages.media, "not_run");
      assert(JSON.stringify(result).length < 8000);
      const full = JSON.parse(fs.readFileSync(result.report, "utf8"));
      assert(full.input.files.length > 10);
      assert.equal(full.input.fingerprint, result.input.fingerprint);
      fs.appendFileSync(
        f.file("scene.ts"),
        '\nconst invalid: number = "not-a-number"; void invalid;\n',
      );
      const failed = await checkCreatorWork(
        f.root,
        { project: "test-film" },
        {},
      );
      assert.equal(failed.status, "failed");
      assert.equal(failed.stages.engineering, "failed");
      assert.match(failed.diagnostics.types, /TS2322/);
      assert.equal(failed.stages.playback, "not_run");
      assert.notEqual(failed.report, result.report);
    } finally {
      f.close();
    }
  },
);

test("creator prompt routes to project-local commands and distinguishes preview from delivery", () => {
  const prompt = creatorPrompt("test-film");
  assert.match(prompt, /work-tool\.mjs context/);
  assert.match(prompt, /runtime.*true/);
  assert.match(prompt, /film test-e2e test-film/);
  assert.match(prompt, /final encoded deliverable/);
  assert.match(prompt, /not full-film|Do not claim full-film/);
});

test("isolated workspaces honor platform ignores without losing their baseline or exposing secrets", () => {
  const f = fixture({ browser: true });
  try {
    for (const name of [".gitignore", ".npmrc", "pnpm-workspace.yaml"])
      fs.copyFileSync(path.join(repo, name), path.join(f.root, name));
    fs.writeFileSync(f.file(".env"), "PRIVATE_API_KEY=do-not-commit\n");
    const result = createProjectWorkspace(f.root, "test-film");
    assert.equal(result.status, "created");
    const git = (args) =>
      execFileSync("git", args, { cwd: result.directory, encoding: "utf8" });
    assert.match(git(["ls-files"]), /projects\/test-film\/scene.ts/);
    assert.match(git(["ls-files"]), /pnpm-workspace.yaml/);
    assert(!git(["ls-files"]).includes(".env"));
    assert.equal(
      inspectProjectScope(result.directory, "test-film").passed,
      true,
    );
    fs.appendFileSync(
      path.join(result.directory, "projects/test-film/scene.ts"),
      "\n// independent edit\n",
    );
    assert(
      !fs.readFileSync(f.file("scene.ts"), "utf8").includes("independent edit"),
    );
    const scope = inspectProjectScope(result.directory, "test-film");
    assert.equal(scope.passed, true);
    assert.equal(scope.projectChanges.count, 1);
  } finally {
    f.close();
  }
});

test("credentials supplied through request JSON are redacted on both success and failure", async () => {
  const secret = "private-custom-speech-credential";
  let failed = true;
  const f = await httpFixture((_req, res) => {
    res.writeHead(failed ? 400 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Upstream echoed " + secret }));
  });
  try {
    await assert.rejects(
      callWorkTool("engine_add", { apiKey: secret }, { env: f.env }),
      (error) => error.code === "HTTP_400" && !error.message.includes(secret),
    );
    failed = false;
    const result = await callWorkTool(
      "engine_add",
      { apiKey: secret },
      { env: f.env },
    );
    assert(!JSON.stringify(result).includes(secret));
    assert(result.message.includes("[redacted]"));
  } finally {
    await f.close();
  }
});

test("creator task instructions participate in the frozen executor fingerprint", async () => {
  const f = fixture({ browser: true });
  try {
    fs.mkdirSync(path.join(f.root, "server"), { recursive: true });
    const file = path.join(f.root, "server/creator-workspace.mjs");
    fs.copyFileSync(path.join(repo, "server/creator-workspace.mjs"), file);
    const before = await runtimeIdentity(f.root, { refresh: true });
    fs.appendFileSync(file, "\n// changed creator instructions\n");
    const after = await runtimeIdentity(f.root, { refresh: true });
    assert.notEqual(before.fingerprint, after.fingerprint);
    let prior = after;
    for (const name of ["agent-runtime.mjs", "agent-stream.mjs", "agent-public-data.mjs", "agent-file-changes.mjs"]) {
      fs.copyFileSync(path.join(repo, "server", name), path.join(f.root, "server", name));
      const current = await runtimeIdentity(f.root, { refresh: true });
      assert.notEqual(prior.fingerprint, current.fingerprint, name + " must be pinned in the runtime identity");
      prior = current;
    }
  } finally {
    f.close();
  }
});
