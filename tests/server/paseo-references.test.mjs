import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./paseo-test-fixture.mjs";
import { exportPaseoReference } from "../../server/paseo-references.mjs";
import { treeHash, fileSha256, copyTree } from "../../server/project-files.mjs";
import { command } from "../../server/process.mjs";

async function liveFixture(t) {
  const f = await fixture(t);
  const sessionId = randomUUID(),
    sourceRevision = "a".repeat(64);
  const snapshotPath =
    "live-preview-references/" +
    sessionId +
    "/" +
    sourceRevision +
    "/projects/" +
    f.work.project;
  const snapshot = path.join(f.data, snapshotPath);
  await copyTree(f.canonical, snapshot);
  await fs.writeFile(
    path.join(snapshot, "public/sample.bin"),
    Buffer.alloc(256 * 1024, 7),
  );
  const reference = {
    status: "versioned",
    mode: "live",
    source: "paseo",
    liveSessionId: sessionId,
    sourceRevision,
    snapshotPath,
    fingerprint: await treeHash(snapshot, { includeIgnored: true }),
  };
  const input = {
    ...f,
    work: f.work,
    agentId: "agent-one",
    messageId: randomUUID(),
    intentHash: "b".repeat(64),
    reference,
  };
  return { ...f, snapshot, input };
}

test("Frozen references export exact code and SHA manifest without duplicating large media; identical requests reuse one folder", async (t) => {
  const f = await liveFixture(t);
  const outputs = await Promise.all(
    Array.from({ length: 8 }, () => exportPaseoReference(f.input)),
  );
  assert.ok(outputs.every((output) => output.folder === outputs[0].folder));
  const { folder, manifest } = outputs[0];
  assert.equal(
    await fs.readFile(path.join(folder, "source/scene.ts"), "utf8"),
    await fs.readFile(path.join(f.snapshot, "scene.ts"), "utf8"),
  );
  await assert.rejects(fs.stat(path.join(folder, "source/public/sample.bin")), {
    code: "ENOENT",
  });
  const media = manifest.files.find(
    (entry) => entry.path === "public/sample.bin",
  );
  assert.equal(
    media.sha256,
    await fileSha256(path.join(f.snapshot, "public/sample.bin")),
  );
  assert.equal(media.bytes, String(256 * 1024));
  assert.equal(media.copied, false);
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /snapshotPath|frame-paseo-test-/,
  );
  await assert.rejects(
    exportPaseoReference({ ...f.input, agentId: "foreign-agent" }),
    /different message intent/,
  );
  await assert.rejects(
    exportPaseoReference({ ...f.input, intentHash: "c".repeat(64) }),
    /different message intent/,
  );
  await fs.writeFile(
    path.join(folder, "source/scene.ts"),
    "export const tampered=true;",
  );
  await assert.rejects(exportPaseoReference(f.input), /source was modified/);
});

test("Frozen reference export rejects altered snapshots and never copies code from a different path", async (t) => {
  const f = await liveFixture(t);
  await assert.rejects(
    exportPaseoReference({
      ...f.input,
      reference: { ...f.input.reference, snapshotPath: "repos/foreign" },
    }),
    /Invalid frozen reference/,
  );
  await fs.writeFile(
    path.join(f.snapshot, "scene.ts"),
    "export const newer=true;",
  );
  await assert.rejects(
    exportPaseoReference(f.input),
    /Frozen live source changed/,
  );
  const messages = path.join(f.data, "paseo", f.work.id, "references/messages");
  assert.deepEqual(await fs.readdir(messages), []);
});

test("An immutable Git version exports code blobs and media digests without checking out or copying full audio", async (t) => {
  const f = await fixture(t);
  const gitRoot = path.dirname(path.dirname(f.canonical));
  // The canonical-work fixture already commits its source and media baseline.
  // Reference that real version before making the current work diverge below.
  const commit = await command("git", ["rev-parse", "HEAD"], { cwd: gitRoot });
  const oldCode = await fs.readFile(path.join(f.canonical, "scene.ts"), "utf8");
  const mediaHash = await fileSha256(
    path.join(f.canonical, "public/sample.bin"),
  );
  await fs.writeFile(
    path.join(f.canonical, "scene.ts"),
    "export const current=true;",
  );
  const repos = {
    project: async () => ({ repo: { root: gitRoot } }),
    git: (_root, args) => command("git", args, { cwd: gitRoot }),
  };
  const result = await exportPaseoReference({
    ...f,
    repos,
    work: f.work,
    agentId: "agent-one",
    messageId: randomUUID(),
    intentHash: "b".repeat(64),
    reference: { status: "versioned", sourceCommit: commit },
  });
  assert.equal(
    await fs.readFile(path.join(result.folder, "source/scene.ts"), "utf8"),
    oldCode,
  );
  assert.match(
    await fs.readFile(path.join(f.canonical, "scene.ts"), "utf8"),
    /current/,
  );
  assert.equal(
    result.manifest.files.find((entry) => entry.path === "public/sample.bin")
      .sha256,
    mediaHash,
  );
  await assert.rejects(
    fs.stat(path.join(result.folder, "source/public/sample.bin")),
    { code: "ENOENT" },
  );
});
