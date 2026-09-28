import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Workspace, sha256 } from "../../scripts/mcp/workspace.mjs";
import { fixture, memoryClient, call } from "./helpers.mjs";

function setup(t) {
  const f = fixture();
  t.after(() => f.close());
  const workspace = new Workspace(f.root);
  return { ...f, workspace };
}
test("read slices retain full-file SHA and dryRun writes nothing", (t) => {
  const f = setup(t);
  const text = "\ufeff中文\r\nsecond\r\n";
  fs.writeFileSync(f.file("notes.md"), text);
  const result = f.workspace.readFile("test-film", "notes.md", {
    startLine: 2,
    lineCount: 1,
  });
  assert.equal(result.content, "second\r");
  assert.equal(result.sha256, sha256(Buffer.from(text)));
  f.workspace.edit(
    "test-film",
    [{ path: "notes.md", expectedSha256: result.sha256, content: "new" }],
    { dryRun: true },
  );
  assert.equal(fs.readFileSync(f.file("notes.md"), "utf8"), text);
  assert.equal(fs.existsSync(f.file(".cache")), false);
});
test("coherent edits validate, audit and preserve unrelated work", (t) => {
  const f = setup(t);
  fs.writeFileSync(f.file("unrelated.md"), "keep me");
  const original = f.workspace.readFile("test-film", "scene.ts");
  const result = f.workspace.edit("test-film", [
    {
      path: "scene.ts",
      expectedSha256: original.sha256,
      content: original.content.replace("#e4ead9", "#112233"),
    },
    { path: "production/notes.md", expectedSha256: null, content: "分镜说明" },
  ]);
  assert.equal(result.validation.passed, true);
  assert.ok(fs.existsSync(f.file(result.auditPath)));
  assert.equal(fs.readFileSync(f.file("unrelated.md"), "utf8"), "keep me");
  assert.deepEqual(fs.readdirSync(f.file(".cache/mcp")), []);
  const hash = f.workspace.readFile("test-film", "production/notes.md").sha256;
  f.workspace.edit("test-film", [
    { path: "production/notes.md", expectedSha256: hash, content: null },
  ]);
  assert.equal(fs.existsSync(f.file("production/notes.md")), false);
});
test("one stale hash refuses the entire batch", (t) => {
  const f = setup(t);
  const before = fs.readFileSync(f.file("scene.ts"), "utf8");
  assert.throws(
    () =>
      f.workspace.edit("test-film", [
        { path: "new.md", expectedSha256: null, content: "not written" },
        {
          path: "scene.ts",
          expectedSha256: "0".repeat(64),
          content: "not written",
        },
      ]),
    { code: "VERSION_CONFLICT" },
  );
  assert.equal(fs.existsSync(f.file("new.md")), false);
  assert.equal(fs.readFileSync(f.file("scene.ts"), "utf8"), before);
});
test("failed strict validation restores all bytes and removes created directories", (t) => {
  const f = setup(t);
  const before = fs.readFileSync(f.file("scene.ts"));
  assert.throws(
    () =>
      f.workspace.edit("test-film", [
        {
          path: "new/subdir/note.md",
          expectedSha256: null,
          content: "should disappear",
        },
        {
          path: "scene.ts",
          expectedSha256: sha256(before),
          content: "this is not valid TypeScript !!!",
        },
      ]),
    { code: "VALIDATION_FAILED" },
  );
  assert.deepEqual(fs.readFileSync(f.file("scene.ts")), before);
  assert.equal(fs.existsSync(f.file("new")), false);
  assert.deepEqual(fs.readdirSync(f.file(".cache/mcp")), []);
});
test("deleting project metadata rolls back without losing the project", (t) => {
  const f = setup(t);
  const before = fs.readFileSync(f.file("project.ts"));
  assert.throws(() =>
    f.workspace.edit("test-film", [
      { path: "project.ts", expectedSha256: sha256(before), content: null },
    ]),
  );
  assert.deepEqual(fs.readFileSync(f.file("project.ts")), before);
  assert.deepEqual(fs.readdirSync(f.file(".cache/mcp")), []);
});
test("traversal, Windows aliases, hidden files, hardlinks and junctions are denied", (t) => {
  const f = setup(t);
  for (const relative of [
    "../other/a.ts",
    "C:/a.ts",
    "scene.ts:secret",
    "/tmp/a.ts",
    "a\\b.ts",
    "a//b.ts",
    "AUX.ts",
    "name./a.ts",
    ".env",
    ".cache/x.md",
    "a/%2e%2e/b.ts",
  ]) {
    assert.throws(
      () => f.workspace.readFile("test-film", relative),
      undefined,
      relative,
    );
  }
  fs.linkSync(f.file("scene.ts"), f.file("hard.ts"));
  assert.throws(() => f.workspace.readFile("test-film", "hard.ts"), {
    code: "UNSAFE_LINK",
  });
  fs.unlinkSync(f.file("hard.ts"));
  fs.symlinkSync(
    f.root,
    f.file("escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => f.workspace.readFile("test-film", "escape/anything.ts"), {
    code: "UNSAFE_LINK",
  });
  fs.unlinkSync(f.file("escape"));
});
test("allowlist, read-only, duplicate paths, size limits and project locks are enforced", (t) => {
  const f = setup(t);
  assert.throws(
    () => new Workspace(f.root, { projects: ["other"] }).context("test-film"),
    { code: "PROJECT_DENIED" },
  );
  assert.throws(
    () => new Workspace(f.root, { readOnly: true }).edit("test-film", []),
    { code: "READ_ONLY" },
  );
  assert.throws(
    () =>
      f.workspace.edit("test-film", [
        { path: "note.md", expectedSha256: null, content: "a" },
        { path: "NOTE.md", expectedSha256: null, content: "b" },
      ]),
    { code: "DUPLICATE_PATH" },
  );
  assert.throws(
    () =>
      f.workspace.edit("test-film", [
        { path: "huge.md", expectedSha256: null, content: "汉".repeat(400000) },
      ]),
    { code: "TOO_LARGE" },
  );
  const release = f.workspace.lock("test-film", "another session");
  try {
    assert.throws(
      () =>
        new Workspace(f.root).edit("test-film", [
          { path: "note.md", expectedSha256: null, content: "a" },
        ]),
      { code: "PROJECT_BUSY" },
    );
  } finally {
    release();
  }
});
test("rollback preserves a concurrent external edit and recovery evidence", (t) => {
  const f = setup(t);
  const before = f.workspace.readFile("test-film", "scene.ts");
  f.workspace.check = () => {
    fs.writeFileSync(f.file("scene.ts"), "external edit");
    return { passed: false, errors: 1 };
  };
  assert.throws(
    () =>
      f.workspace.edit("test-film", [
        {
          path: "scene.ts",
          expectedSha256: before.sha256,
          content: before.content + "\n// ours\n",
        },
      ]),
    { code: "RECOVERY_REQUIRED" },
  );
  assert.equal(fs.readFileSync(f.file("scene.ts"), "utf8"), "external edit");
  assert.ok(fs.existsSync(f.file(".cache/mcp/operation.lock")));
  assert.ok(
    fs
      .readdirSync(f.file(".cache/mcp"))
      .some((name) => name.startsWith("transaction-")),
  );
});
test("a leftover transaction without a lock still blocks new writes", (t) => {
  const f = setup(t);
  fs.mkdirSync(f.file(".cache/mcp/transaction-crashed"), { recursive: true });
  assert.throws(
    () =>
      f.workspace.edit("test-film", [
        { path: "notes.md", expectedSha256: null, content: "new" },
      ]),
    { code: "RECOVERY_REQUIRED" },
  );
  assert.equal(fs.existsSync(f.file("notes.md")), false);
  assert.equal(fs.existsSync(f.file(".cache/mcp/transaction-crashed")), true);
});
test("MCP schemas, tool errors, create and independent scope failures are observable", async (t) => {
  const f = setup(t);
  const session = await memoryClient(f.root);
  t.after(() => session.close());
  const { client } = session;
  const tools = (await client.listTools()).tools;
  assert.ok(
    tools.find((tool) => tool.name === "frame_edit_files").annotations
      .destructiveHint,
  );
  const invalid = await client.callTool({
    name: "frame_read_file",
    arguments: { project: "test-film", path: "../scene.ts", unexpected: true },
  });
  assert.equal(invalid.isError, true);
  const stale = await client.callTool({
    name: "frame_edit_files",
    arguments: {
      project: "test-film",
      changes: [{ path: "scene.ts", expectedSha256: null, content: "a" }],
    },
  });
  assert.equal(stale.structuredContent.error.code, "VERSION_CONFLICT");
  const check = await client.callTool({
    name: "frame_check_project",
    arguments: { project: "test-film" },
  });
  assert.equal(check.structuredContent.structure.passed, true);
  assert.equal(check.structuredContent.scope.passed, false);
  assert.notEqual(check.isError, true);
  assert.equal(check.structuredContent.status, "completed");
  const made = await call(client, "frame_create_project", {
    project: "second-film",
    title: "第二部",
    renderer: "canvas",
  });
  assert.equal(made.id, "second-film");
  const duplicate = await client.callTool({
    name: "frame_create_project",
    arguments: { project: "second-film", title: "不能覆盖" },
  });
  assert.equal(duplicate.isError, true);
});
test("read-only server does not advertise write or render tools", async (t) => {
  const f = setup(t);
  const session = await memoryClient(f.root, {
    readOnly: true,
    projects: ["test-film"],
  });
  t.after(() => session.close());
  const tools = (await session.client.listTools()).tools;
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint));
  assert.ok(!tools.some((tool) => tool.name === "frame_start_preview"));
});
