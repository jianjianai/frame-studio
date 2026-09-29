import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { operations } from "../../server/operations.mjs";
import { hash } from "../../server/security.mjs";
import {
  compactTask,
  describeTool,
  isMcpOperation,
  textToolResult,
  toolAnnotations,
} from "../../server/agent-toolkit.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-toolkit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = { repo: randomUUID(), project: "fixture" };
  const repos = {
    writable: async () => {},
    project: async () => ({ dir }),
    revisions: { invalidate: async () => {} },
  };
  const actions = operations({
    db: { lock: async (_key, fn) => fn() },
    data: dir,
    repos,
    assets: {},
    tasks: {},
    secrets: {},
    connections: {},
    github: {},
    retention: {},
  });
  const call = (name, args = {}) =>
    actions.call("project_" + name, { ...target, ...args });
  return { dir, repos, actions, call };
}

test("UTF-8 slices carry the original complete hash, preserve BOM/CRLF and expose continuation", async (t) => {
  const { dir, call } = fixture(t);
  const text = "\ufefffirst\r\n中文\r\nlast\r\n";
  fs.writeFileSync(path.join(dir, "scene.ts"), text);
  const read = await call("read", {
    path: "scene.ts",
    startLine: 2,
    lineCount: 1,
  });
  assert.equal(read.content, "中文\r");
  assert.equal(read.sha256, hash(Buffer.from(text)));
  assert.equal(read.complete, false);
  assert.equal(read.nextLine, 3);
  assert.equal(read.totalLines, 4);
  const full = await call("read", { path: "scene.ts" });
  assert.equal(full.content, text);
  assert.equal(full.complete, true);
  assert.equal(full.nextLine, null);
  await assert.rejects(call("read", { path: "scene.ts", startLine: 8 }), {
    code: "LINE_OUT_OF_RANGE",
  });
});

test("source errors are actionable: missing, directory, binary, invalid UTF-8 and byte limits", async (t) => {
  const { dir, call } = fixture(t);
  await assert.rejects(call("read", { path: "missing.ts" }), {
    statusCode: 404,
    code: "FILE_NOT_FOUND",
  });
  fs.mkdirSync(path.join(dir, "folder.ts"));
  await assert.rejects(call("read", { path: "folder.ts" }), {
    statusCode: 400,
    code: "NOT_REGULAR_FILE",
  });
  fs.writeFileSync(path.join(dir, "invalid.ts"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(call("read", { path: "invalid.ts" }), {
    code: "NOT_UTF8",
  });
  fs.writeFileSync(path.join(dir, "binary.ts"), Buffer.from([65, 0, 66]));
  await assert.rejects(call("read", { path: "binary.ts" }), {
    code: "NOT_TEXT",
  });
  await assert.rejects(
    call("write", {
      path: "large.ts",
      expectedSha256: null,
      content: "中".repeat(400000),
    }),
    { statusCode: 413 },
  );
  assert(!fs.existsSync(path.join(dir, "large.ts")));
  fs.writeFileSync(path.join(dir, "line.ts"), "x".repeat(128 * 1024 + 1));
  await assert.rejects(call("read", { path: "line.ts", lineCount: 1 }), {
    code: "READ_TOO_LARGE",
  });
  await assert.rejects(call("read", { path: "line.ts/child.ts" }), {
    statusCode: 400,
  });
});

test("file access denies traversal, hidden/generated paths, symlinks and hardlinks", async (t) => {
  const { dir, call } = fixture(t);
  fs.writeFileSync(path.join(dir, "scene.ts"), "source");
  fs.symlinkSync(path.join(dir, "scene.ts"), path.join(dir, "link.ts"));
  for (const name of [
    "../scene.ts",
    "/scene.ts",
    ".env",
    ".cache/private.ts",
    "exports/output.ts",
    "link.ts",
    "node_modules/lib.ts",
  ])
    await assert.rejects(call("read", { path: name }), { statusCode: 400 });
  fs.unlinkSync(path.join(dir, "link.ts"));
  fs.linkSync(path.join(dir, "scene.ts"), path.join(dir, "hard.ts"));
  await assert.rejects(call("read", { path: "hard.ts" }), { statusCode: 400 });
});

test("pagination and literal search have deterministic, lossless cursors and skip binary files", async (t) => {
  const { dir, call } = fixture(t);
  fs.mkdirSync(path.join(dir, "a"));
  fs.mkdirSync(path.join(dir, "exports"));
  fs.writeFileSync(path.join(dir, "a/file.ts"), "NEEDLE\nneedle\nnone");
  fs.writeFileSync(path.join(dir, "a.md"), "needle\n");
  fs.writeFileSync(path.join(dir, "binary.ts"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(dir, "exports/ignored.ts"), "needle");
  fs.writeFileSync(path.join(dir, ".hidden.ts"), "needle");
  const first = await call("files_page", { limit: 1 });
  assert.equal(first.files[0].path, "a.md");
  assert.equal(first.nextOffset, 1);
  assert.equal(first.total, 3);
  const seen = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const result = await call("search", {
      query: "needle",
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...result.matches.map((m) => [m.path, m.line]));
    cursor = result.nextCursor;
    if (!cursor) {
      assert(result.skipped.some((s) => s.reason === "NOT_TEXT"));
      break;
    }
  }
  assert.deepEqual(seen, [
    ["a.md", 1],
    ["a/file.ts", 1],
    ["a/file.ts", 2],
  ]);
  assert.equal(
    (await call("search", { query: "NEEDLE", caseSensitive: true })).matches
      .length,
    1,
  );
  assert.equal(
    (await call("search", { query: ".*" })).matches.length,
    0,
    "query is literal, not a regex",
  );
});

test("search byte budget resumes even when earlier text-looking files are actually binary", async (t) => {
  const { dir, call } = fixture(t);
  for (let i = 0; i < 5; i++)
    fs.writeFileSync(path.join(dir, `${i}.ts`), Buffer.alloc(1024 * 1024));
  fs.writeFileSync(path.join(dir, "z.ts"), "target");
  const first = await call("search", { query: "target" });
  assert.equal(first.scannedBytes, 4 * 1024 * 1024);
  assert(first.hasMore);
  assert.equal(first.nextCursor.path, "4.ts");
  const second = await call("search", {
    query: "target",
    cursor: first.nextCursor,
  });
  assert.equal(second.matches[0].path, "z.ts");
  assert.equal(second.hasMore, false);
});

test("patch checks occurrences and hashes before any write; dry runs do not invalidate revisions", async (t) => {
  const { dir, repos, call } = fixture(t);
  let invalidations = 0;
  repos.revisions.invalidate = async () => {
    invalidations++;
  };
  const content = "one\ntwo\none\n";
  fs.writeFileSync(path.join(dir, "scene.ts"), content, { mode: 0o755 });
  const args = {
    path: "scene.ts",
    expectedSha256: hash(content),
    edits: [{ oldText: "one", newText: "three", expectedMatches: 2 }],
  };
  const dry = await call("patch", { ...args, dryRun: true });
  assert(!dry.applied);
  assert.equal(invalidations, 0);
  assert.equal(fs.readFileSync(path.join(dir, "scene.ts"), "utf8"), content);
  await assert.rejects(
    call("patch", { ...args, edits: [{ oldText: "one", newText: "bad" }] }),
    { code: "PATCH_MATCH_CONFLICT" },
  );
  await assert.rejects(
    call("patch", {
      ...args,
      edits: [...args.edits, { oldText: "absent", newText: "bad" }],
    }),
    { code: "PATCH_MATCH_CONFLICT" },
  );
  assert.equal(fs.readFileSync(path.join(dir, "scene.ts"), "utf8"), content);
  const saved = await call("patch", args);
  assert(saved.applied);
  assert.equal(saved.sha256, dry.sha256);
  assert.equal(
    fs.readFileSync(path.join(dir, "scene.ts"), "utf8"),
    "three\ntwo\nthree\n",
  );
  assert(fs.statSync(path.join(dir, "scene.ts")).mode & 0o100);
  await assert.rejects(call("patch", args), { code: "FILE_CHANGED" });
  assert(!fs.readdirSync(dir).some((name) => name.includes(".frame-")));
});

test("writes recheck a concurrent external change after revision invalidation", async (t) => {
  const { dir, repos, call } = fixture(t);
  fs.writeFileSync(path.join(dir, "scene.ts"), "original");
  repos.revisions.invalidate = async () =>
    fs.writeFileSync(path.join(dir, "scene.ts"), "external");
  await assert.rejects(
    call("write", {
      path: "scene.ts",
      expectedSha256: hash("original"),
      content: "replacement",
    }),
    { code: "FILE_CHANGED" },
  );
  assert.equal(fs.readFileSync(path.join(dir, "scene.ts"), "utf8"), "external");
});

test("all operation schemas are discoverable and public tool annotations remain conservative", (t) => {
  const { actions } = fixture(t);
  for (const [name, op] of Object.entries(actions.registry))
    assert.doesNotThrow(() => describeTool(name, op), name);
  assert(isMcpOperation("workspace_context"));
  assert(isMcpOperation("works_patch"));
  assert(!isMcpOperation("tokens_create"));
  assert.equal(toolAnnotations("works_read").readOnlyHint, true);
  assert.equal(toolAnnotations("works_patch").destructiveHint, true);
  assert.equal(
    toolAnnotations("works_assets").readOnlyHint,
    false,
    "this operation imports project assets",
  );
  assert.equal(toolAnnotations("upload_status").readOnlyHint, true);
  assert.deepEqual(textToolResult([1, 2]).structuredContent, { items: [1, 2] });
  assert.equal(
    textToolResult([1, 2]).content[0].text,
    "[1,2]",
    "legacy text shape is retained",
  );
});

test("task summaries discard build manifests, bound artifacts and retain actionable results", () => {
  const task = {
    id: randomUUID(),
    project: "fixture",
    state: "succeeded",
    kind: "build",
    input: { prompt: "large" },
    result: {
      input: {
        files: Array.from({ length: 1000 }, (_, i) => ({
          path: `engine/${i}`,
          sha256: "f".repeat(64),
        })),
      },
      artifacts: Array.from({ length: 20 }, (_, i) => ({
        name: `${i}.png`,
        path: `projects/fixture/exports/${i}.png`,
        bytes: 3,
      })),
    },
  };
  const compact = compactTask(task, { artifactLimit: 3 });
  assert.equal(compact.result.artifacts.length, 3);
  assert(compact.result.artifactsTruncated);
  assert.equal(compact.result.artifactCount, 20);
  assert(!JSON.stringify(compact).includes("engine/"));
  assert(
    compact.result.artifacts[0].downloadPath.startsWith(
      `/api/tasks/${task.id}/file/`,
    ),
  );
  assert(JSON.stringify(compact).length < JSON.stringify(task).length / 20);
});

test("legacy full-file reads stay complete beyond 400 lines; explicit paging never changes the hash", async (t) => {
  const { dir, call } = fixture(t),
    content = "source line\n".repeat(700);
  fs.writeFileSync(path.join(dir, "scene.ts"), content);
  const full = await call("read", { path: "scene.ts" });
  const page = await call("read", { path: "scene.ts", lineCount: 10 });
  assert.equal(full.content, content);
  assert(full.complete);
  assert(!page.complete);
  assert.equal(page.sha256, full.sha256);
  assert.equal(page.nextLine, 11);
});

test("source deletion is hash-protected, supports dry-run and cannot remove work identity", async (t) => {
  const { dir, call } = fixture(t);
  for (const file of ["scene.ts", "project.ts"])
    fs.writeFileSync(path.join(dir, file), "source");
  const args = { path: "scene.ts", expectedSha256: hash("source") };
  assert(!(await call("delete_file", { ...args, dryRun: true })).deleted);
  assert(fs.existsSync(path.join(dir, "scene.ts")));
  await assert.rejects(
    call("delete_file", { ...args, expectedSha256: hash("stale") }),
    { code: "FILE_CHANGED" },
  );
  await assert.rejects(call("delete_file", { ...args, path: "project.ts" }), {
    code: "PROTECTED_FILE",
  });
  assert((await call("delete_file", args)).deleted);
  assert(!fs.existsSync(path.join(dir, "scene.ts")));
});
