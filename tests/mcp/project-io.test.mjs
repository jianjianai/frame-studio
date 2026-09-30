import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { fixture, repo, memoryClient, call } from "./helpers.mjs";
import { ProjectService } from "../../scripts/project-service.mjs";
import { Workspace } from "../../scripts/mcp/workspace.mjs";
import {
  inputManifest,
  inputDigestMetrics,
  captureInputAsync,
} from "../../scripts/production-input.mjs";
import {
  projectOperationAsync,
  projectIoMetrics,
  releaseExitedWorkerLock,
} from "../../scripts/project-io.mjs";

const workerBytes = () =>
  projectIoMetrics()
    .flatMap((pool) => pool.workers)
    .reduce((sum, worker) => sum + (worker.hashedBytes ?? 0), 0);

test("input digests reuse verified bytes but reject modified, replaced and linked files", () => {
  const f = fixture();
  try {
    const asset = f.file("public/large.bin");
    fs.writeFileSync(asset, Buffer.alloc(8 * 1024 * 1024, 1));
    const first = inputManifest(f.root, "test-film");
    const afterCold = inputDigestMetrics();
    assert.equal(
      inputManifest(f.root, "test-film").fingerprint,
      first.fingerprint,
    );
    assert.equal(inputDigestMetrics().hashedBytes, afterCold.hashedBytes);
    const time = fs.statSync(asset);
    fs.writeFileSync(asset, Buffer.alloc(8 * 1024 * 1024, 2));
    fs.utimesSync(asset, time.atime, time.mtime);
    const changed = inputManifest(f.root, "test-film").fingerprint;
    assert.notEqual(changed, first.fingerprint);
    const replacement = asset + ".tmp";
    fs.writeFileSync(replacement, Buffer.alloc(8 * 1024 * 1024, 3));
    fs.renameSync(replacement, asset);
    assert.notEqual(inputManifest(f.root, "test-film").fingerprint, changed);
    fs.linkSync(asset, asset + ".link");
    assert.throws(() => inputManifest(f.root, "test-film"), /links/);
    fs.unlinkSync(asset + ".link");
    fs.unlinkSync(asset);
    fs.symlinkSync(path.join(f.root, "src/engine/types.ts"), asset);
    assert.throws(() => inputManifest(f.root, "test-film"), /links/);
    fs.unlinkSync(asset);
    const beforeShared = inputManifest(f.root, "test-film").fingerprint;
    fs.appendFileSync(
      path.join(f.root, "src/engine/types.ts"),
      "\n// shared update",
    );
    assert.notEqual(
      inputManifest(f.root, "test-film").fingerprint,
      beforeShared,
    );
  } finally {
    f.close();
  }
});

test("worker edits keep API timers responsive and hash unchanged media once", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      f.file("public/large.bin"),
      Buffer.alloc(64 * 1024 * 1024, 7),
    );
    const workspace = new ProjectService(f.root);
    const source = workspace.textFile("test-film", "scene.ts");
    const parentBefore = inputDigestMetrics().hashedBytes;
    const workerBefore = workerBytes();
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 0);
    const result = await projectOperationAsync(workspace, "edit", "test-film", [
      {
        path: "scene.ts",
        expectedSha256: source.sha256,
        content: source.text + "\n// worker edit\n",
      },
    ]);
    clearTimeout(timer);
    assert.equal(timerFired, true);
    assert.ok(result.checkpoint);
    assert.equal(inputDigestMetrics().hashedBytes, parentBefore);
    const coldBytes = workerBytes() - workerBefore;
    assert.ok(coldBytes >= 64 * 1024 * 1024);
    assert.ok(coldBytes < 64 * 1024 * 1024 + 512 * 1024, String(coldBytes));
    const warmBefore = workerBytes();
    const current = workspace.textFile("test-film", "scene.ts");
    await projectOperationAsync(workspace, "patch", "test-film", [
      {
        path: "scene.ts",
        expectedSha256: current.sha256,
        replacements: [{ find: "// worker edit", replace: "// warm edit" }],
      },
    ]);
    assert.ok(workerBytes() - warmBefore < 512 * 1024);
    await assert.rejects(
      () =>
        projectOperationAsync(workspace, "edit", "test-film", [
          {
            path: "scene.ts",
            expectedSha256: source.sha256,
            content: source.text,
          },
        ]),
      { code: "VERSION_CONFLICT" },
    );
    const history = await projectOperationAsync(
      workspace,
      "history",
      "test-film",
    );
    await assert.rejects(
      () =>
        projectOperationAsync(
          workspace,
          "restore",
          "test-film",
          result.checkpoint,
          "0".repeat(64),
          false,
        ),
      { code: "VERSION_CONFLICT" },
    );
    assert.equal(history.checkpoints.length, 2);
    assert.equal(workspace.operation("test-film").busy, false);
  } finally {
    f.close();
  }
});

test("history reads metadata after lazy migration and detects changed legacy bodies", () => {
  const f = fixture();
  try {
    const workspace = new ProjectService(f.root);
    const checkpoint = workspace.checkpoint("test-film", "first");
    const name = f.file(
      ".history/checkpoints/" + checkpoint.checkpoint + ".json",
    );
    fs.rmSync(f.file(".history/checkpoint-metadata"), { recursive: true });
    const body = JSON.parse(fs.readFileSync(name, "utf8"));
    // Legacy listing preserves the body identity, even if its filename differs.
    body.checkpoint = randomUUID();
    body.files["large.txt"] = {
      content: "x".repeat(1024 * 1024),
      sha256: "a".repeat(64),
    };
    fs.writeFileSync(name, JSON.stringify(body));
    assert.equal(
      workspace.history("test-film").checkpoints[0].checkpoint,
      body.checkpoint,
    );
    const originalRead = fs.readFileSync;
    let bodyReads = 0;
    fs.readFileSync = function (file, ...args) {
      if (String(file) === name) bodyReads++;
      return originalRead.call(this, file, ...args);
    };
    try {
      assert.equal(
        workspace.history("test-film").checkpoints[0].label,
        "first",
      );
      assert.equal(bodyReads, 0);
      body.label = "external change";
      fs.writeFileSync(name, JSON.stringify(body));
      assert.equal(
        workspace.history("test-film").checkpoints[0].label,
        body.label,
      );
      assert.equal(bodyReads, 1);
    } finally {
      fs.readFileSync = originalRead;
    }
  } finally {
    f.close();
  }
});

test("async capture freezes independent bytes and matches the source manifest", async () => {
  const f = fixture();
  let snapshot;
  try {
    fs.mkdirSync(path.join(f.root, "node_modules"));
    fs.writeFileSync(f.file("public/asset.bin"), Buffer.from([1, 2, 3]));
    const manifest = inputManifest(f.root, "test-film");
    snapshot = await captureInputAsync(f.root, "test-film");
    assert.deepEqual(snapshot.manifest, manifest);
    fs.writeFileSync(f.file("public/asset.bin"), Buffer.from([4, 5, 6]));
    assert.deepEqual(
      fs.readFileSync(
        path.join(snapshot.root, "projects/test-film/public/asset.bin"),
      ),
      Buffer.from([1, 2, 3]),
    );
    assert.notEqual(
      inputManifest(f.root, "test-film").fingerprint,
      manifest.fingerprint,
    );
  } finally {
    snapshot?.close();
    f.close();
  }
});

test("terminated-worker fencing removes only its exact lock and keeps rollback journals", async () => {
  const f = fixture();
  try {
    const ownerWorkerId = randomUUID();
    const thread = new Worker(
      `
      import fs from "node:fs";
      import { parentPort, workerData } from "node:worker_threads";
      const { Workspace } = await import(workerData.workspaceUrl);
      const workspace = new Workspace(workerData.root, { ioWorkerId: workerData.ownerWorkerId });
      workspace.lock("test-film", "edit");
      fs.mkdirSync(workspace.file("test-film", ".cache/mcp/transaction-owned", true));
      parentPort.postMessage("locked");
    `,
      {
        eval: true,
        type: "module",
        workerData: {
          root: f.root,
          ownerWorkerId,
          workspaceUrl: new URL(
            "../../scripts/mcp/workspace.mjs",
            import.meta.url,
          ).href,
        },
      },
    );
    const ownerThreadId = thread.threadId;
    await new Promise((resolve, reject) => {
      thread.once("message", resolve);
      thread.once("error", reject);
    });
    await thread.terminate();
    const workspace = new Workspace(f.root);
    const request = {
      root: f.root,
      operation: "edit",
      arguments: ["test-film"],
    };
    releaseExitedWorkerLock(request, randomUUID(), ownerThreadId);
    assert.equal(workspace.operation("test-film").busy, true);
    releaseExitedWorkerLock(request, ownerWorkerId, ownerThreadId);
    assert.equal(workspace.operation("test-film").busy, false);
    assert.equal(workspace.operation("test-film").status, "recovery_required");
    assert.throws(() => workspace.lock("test-film", "edit"), {
      code: "RECOVERY_REQUIRED",
    });
    assert.ok(fs.existsSync(f.file(".cache/mcp/transaction-owned")));
  } finally {
    f.close();
  }
});

test("local MCP async edit returns completed checkpoints and preserves project allowlists", async () => {
  const f = fixture();
  let local;
  try {
    local = await memoryClient(f.root, { projects: ["test-film"] });
    const source = await call(local.client, "frame_read_file", {
      project: "test-film",
      path: "scene.ts",
    });
    const edited = await call(local.client, "frame_edit_files", {
      project: "test-film",
      changes: [
        {
          path: "scene.ts",
          expectedSha256: source.sha256,
          content: source.content + "\n// MCP worker\n",
        },
      ],
    });
    assert.ok(edited.checkpoint);
    const history = await call(local.client, "frame_history", {
      project: "test-film",
    });
    assert.equal(history.checkpoints.length, 1);
    const denied = await local.client.callTool({
      name: "frame_history",
      arguments: { project: "other-film" },
    });
    assert.equal(denied.isError, true);
  } finally {
    await local?.close();
    f.close();
  }
});
