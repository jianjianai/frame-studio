import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { fixture, memoryClient } from "./helpers.mjs";
import { inspectProjectScope } from "../../scripts/project-scope-report.mjs";
import { Workspace } from "../../scripts/mcp/workspace.mjs";
import { imageResult } from "../../scripts/mcp/image-result.mjs";

test("scope keeps strict staged/unstaged/untracked boundaries and bounds other-project output", async () => {
  const f = fixture();
  const git = (...args) => {
    const r = spawnSync("git", args, {
      cwd: f.root,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    git("init");
    git("add", "--", "src", "projects");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "baseline",
    );
    const baseline = git("rev-parse", "HEAD");
    assert.equal(inspectProjectScope(f.root, "test-film").passed, true);
    fs.mkdirSync(path.join(f.root, "projects/other-film"));
    for (let i = 0; i < 45; i++)
      fs.writeFileSync(
        path.join(f.root, `projects/other-film/note-${i}.md`),
        "other",
      );
    fs.writeFileSync(path.join(f.root, "shared.md"), "shared");
    git("add", "--", "shared.md");
    let report = inspectProjectScope(f.root, "test-film", { limit: 5 });
    assert.equal(report.passed, false);
    assert.equal(report.attribution, "unknown");
    assert.equal(report.externalWorkspaceChanges.projects[0].count, 45);
    assert.equal(report.externalWorkspaceChanges.projects[0].paths.length, 5);
    assert.equal(report.externalWorkspaceChanges.projects[0].truncated, true);
    assert.deepEqual(report.externalWorkspaceChanges.shared.paths, [
      "shared.md",
    ]);
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "shared change",
    );
    report = inspectProjectScope(f.root, "test-film", { base: baseline });
    assert.equal(report.externalWorkspaceChanges.shared.count, 1);
    const session = await memoryClient(f.root);
    try {
      const result = await session.client.callTool({
        name: "frame_check_project",
        arguments: { project: "test-film" },
      });
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.projectPassed, true);
      assert.equal(result.structuredContent.scopeVerified, false);
    } finally {
      await session.close();
    }
  } finally {
    f.close();
  }
});

test("operation inspection preserves live/foreign/legacy/unfinished locks and recovers only verified stale ownership", () => {
  const f = fixture();
  try {
    const workspace = new Workspace(f.root);
    const other = new Workspace(f.root);
    const release = workspace.lock("test-film", "edit");
    const live = workspace.operation("test-film");
    assert.equal(live.ownerAlive, true);
    assert.equal(live.sameSession, true);
    assert.equal(other.operation("test-film").sameSession, false);
    assert.throws(() => workspace.recoverOperation("test-film", live.lockId), {
      code: "RECOVERY_REFUSED",
    });
    assert.throws(
      () => other.lock("test-film", "edit"),
      (error) =>
        error.code === "PROJECT_BUSY" &&
        error.details.activeOperation.lockId === live.lockId,
    );
    release();
    const lock = f.file(".cache/mcp/operation.lock");
    const exited = spawnSync(process.execPath, ["-e", ""], {
      windowsHide: true,
    });
    const record = {
      version: 2,
      lockId: randomUUID(),
      ownerSession: randomUUID(),
      pid: exited.pid,
      purpose: "edit",
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(lock, JSON.stringify(record));
    assert.equal(workspace.operation("test-film").recoverable, true);
    assert.throws(() => workspace.recoverOperation("test-film", randomUUID()), {
      code: "RECOVERY_REFUSED",
    });
    assert.equal(
      workspace.recoverOperation("test-film", record.lockId).recovered,
      true,
    );
    fs.writeFileSync(
      lock,
      JSON.stringify({ ...record, jobId: randomUUID(), childPid: exited.pid }),
    );
    assert.equal(workspace.operation("test-film").recoverable, false);
    fs.writeFileSync(lock, JSON.stringify(record));
    fs.mkdirSync(f.file(".cache/mcp/transaction-interrupted"));
    assert.equal(workspace.operation("test-film").recoverable, false);
    fs.rmdirSync(f.file(".cache/mcp/transaction-interrupted"));
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: exited.pid, purpose: "legacy" }),
    );
    assert.equal(workspace.operation("test-film").recoverable, false);
    fs.unlinkSync(lock);
    const ownedRelease = workspace.lock("test-film", "edit");
    const replacement = { ...record, lockId: randomUUID() };
    fs.writeFileSync(lock, JSON.stringify(replacement));
    assert.throws(ownedRelease, { code: "LOCK_CHANGED" });
    assert.equal(JSON.parse(fs.readFileSync(lock)).lockId, replacement.lockId);
  } finally {
    f.close();
  }
});

test("image presentations preserve source hashes, bound pixels and offer native-only fallback", async () => {
  const source = await sharp({
    create: { width: 2400, height: 1000, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  const normal = await imageResult(
    source,
    { name: "frame.png" },
    { maxWidth: 640 },
  );
  assert.equal(normal.content[0].type, "image");
  assert.equal(normal.structuredContent.source.width, 2400);
  assert.equal(normal.structuredContent.display.width, 640);
  assert.equal(normal.structuredContent.display.resized, true);
  assert.equal(normal.structuredContent.visualInspection, "not_confirmed");
  const raw = await sharp(Buffer.from(normal.content[0].data, "base64"))
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.deepEqual([...raw.subarray(0, 3)], [0x12, 0x34, 0x56]);
  const imageOnly = await imageResult(
    source,
    {},
    { presentation: "image-only" },
  );
  assert.deepEqual(
    imageOnly.content.map((c) => c.type),
    ["image"],
  );
  assert.equal(imageOnly.structuredContent, undefined);
  const metadata = await imageResult(source, {}, { presentation: "metadata" });
  assert.deepEqual(
    metadata.content.map((c) => c.type),
    ["text"],
  );
  assert.equal(
    metadata.structuredContent.source.sha256,
    normal.structuredContent.source.sha256,
  );
});
