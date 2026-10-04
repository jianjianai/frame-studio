import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "../../server/app.mjs";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { inputManifest, captureInput, captureInputAsync } from "../../scripts/production-input.mjs";
import { ProjectService } from "../../scripts/project-service.mjs";
import { fixture } from "../mcp/helpers.mjs";
import { prepareCanonicalRuntime } from "./ai-test-fixture.mjs";
import { createTestLink } from "../links.mjs";

test("Canonical native runtime pins reach audio/composition editing workers and frozen inputs without changing Git or process environment", async t => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "frame-native-source-edit-")), film = fixture({ renderer: "composition" });
  const db = await sqliteDatabase(path.join(data, "test.sqlite"));
  const services = await createApp({ db, data, masterKey: "62".repeat(32), localMode: true, scheduler: false });
  let snapshot, asyncSnapshot;
  t.after(async () => {
    snapshot?.close(); asyncSnapshot?.close(); await services.app.close();
    film.close(); await fs.rm(data, { recursive: true, force: true });
  });
  const repository = await services.actions.call("repositories_add", { name: "Native source edits" });
  await fs.cp(film.file(""), path.join(data, "repos", repository.id, "projects/test-film"), { recursive: true });
  await services.actions.works.discover(repository.id);
  const work = (await services.actions.call("works_page", { repo: repository.id })).items[0];
  await services.actions.call("works_checkpoint", { id: work.id, name: "Before native source edit" });
  const prepared = await prepareCanonicalRuntime({ db, repos: services.repos, repo: repository.id, project: work.project });
  const environment = [process.env.FRAME_SHARED_RUNTIME_ROOT, process.env.FRAME_SHARED_RUNTIME_FINGERPRINT];
  const workspace = new ProjectService(prepared.root, { runtime: prepared.runtime });
  const manifest = inputManifest(prepared.root, work.project, { runtime: prepared.runtime });
  assert.equal(manifest.runtimeFingerprint, prepared.runtime.fingerprint);
  assert.equal(workspace.fingerprint(work.project), manifest.fingerprint);
  snapshot = captureInput(prepared.root, work.project, { runtime: prepared.runtime });
  asyncSnapshot = await captureInputAsync(prepared.root, work.project, { runtime: prepared.runtime });
  assert.deepEqual(snapshot.manifest, manifest); assert.deepEqual(asyncSnapshot.manifest, manifest);

  const initialAudio = await services.actions.call("works_audio", { id: work.id }), document = structuredClone(initialAudio.document);
  document.master.gain = 0.5;
  const savedAudio = await services.actions.call("works_audio_edit", { id: work.id,
    expectedSha256: initialAudio.sha256, projectSha256: initialAudio.projectSha256, operations: [{ op: "replace", document }] });
  assert.equal(savedAudio.declared, true); assert.equal(savedAudio.document.master.gain, 0.5);
  assert.notEqual(savedAudio.sha256, initialAudio.sha256);
  const initialVisual = await services.actions.call("works_composition", { id: work.id });
  const savedVisual = await services.actions.call("works_composition_edit", { id: work.id,
    expectedSha256: initialVisual.sha256, operations: [{ op: "add", clip: {
      id: "owned-clip", source: { kind: "color", color: "#112233" }, start: 0, duration: 1,
    } }] });
  assert.equal(savedVisual.document.clips.length, 1); assert.notEqual(savedVisual.sha256, initialVisual.sha256);
  await assert.rejects(services.actions.call("works_composition_edit", { id: work.id,
    expectedSha256: initialVisual.sha256, operations: [{ op: "remove", id: "owned-clip" }] }), error => error.statusCode === 409);
  assert.equal(await fs.readFile(path.join(snapshot.root, "projects/test-film/project.ts"), "utf8"),
    await fs.readFile(film.file("project.ts"), "utf8"), "The frozen source remains the original before migration");
  assert.notEqual(workspace.fingerprint(work.project), manifest.fingerprint);
  await prepared.assertGitPreserved();
  assert.deepEqual([process.env.FRAME_SHARED_RUNTIME_ROOT, process.env.FRAME_SHARED_RUNTIME_FINGERPRINT], environment);

  // The descriptor authorizes only the installed core, never a replacement link or a project link.
  const src = path.join(prepared.root, "src"), original = await fs.readlink(src);
  await fs.unlink(src); await fs.symlink(path.join(film.root, "src"), src, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => workspace.fingerprint(work.project), /outside the pinned core/);
  await fs.unlink(src); await fs.symlink(original, src, process.platform === "win32" ? "junction" : "dir");
  const linkedProjectFile = path.join(prepared.dir, "unsafe.html");
  createTestLink(path.join(prepared.runtime.root, "index.html"), linkedProjectFile);
  assert.throws(() => workspace.fingerprint(work.project), /links/);
  await fs.unlink(linkedProjectFile); await prepared.assertGitPreserved();
});
