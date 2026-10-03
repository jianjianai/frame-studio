import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inputManifest, captureInput } from "../../scripts/production-input.mjs";
import { linkSharedRuntime } from "../../scripts/shared-runtime.mjs";

test("controlled runtime links are pinned separately while project captures still own bytes and reject project links", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "frame-shared-input-")), core = path.join(base, "core"), work = path.join(base, "work");
  const previous = { root: process.env.FRAME_SHARED_RUNTIME_ROOT, fingerprint: process.env.FRAME_SHARED_RUNTIME_FINGERPRINT };
  t.after(() => {
    for (const [name, value] of [["FRAME_SHARED_RUNTIME_ROOT", previous.root], ["FRAME_SHARED_RUNTIME_FINGERPRINT", previous.fingerprint]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(work, "projects", "film", "public"), { recursive: true });
  for (const name of ["src", "scripts", "public", "node_modules"]) fs.mkdirSync(path.join(core, name), { recursive: true });
  fs.writeFileSync(path.join(core, "index.html"), "shared entry");
  fs.writeFileSync(path.join(core, "public", "large-font.woff2"), Buffer.alloc(1024 * 1024));
  fs.writeFileSync(path.join(work, "projects", "film", "project.ts"), "frozen project A");
  fs.writeFileSync(path.join(work, "projects", "film", "public", "audio.wav"), "original audio A");
  linkSharedRuntime(work, core);
  process.env.FRAME_SHARED_RUNTIME_ROOT = core;
  process.env.FRAME_SHARED_RUNTIME_FINGERPRINT = "a".repeat(64);
  const before = inputManifest(work, "film");
  assert(before.files.every(file => file.path.startsWith("projects/film/")));
  assert.equal(before.runtimeFingerprint, "a".repeat(64));
  const snapshot = captureInput(work, "film");
  try {
    assert(fs.lstatSync(path.join(snapshot.root, "public")).isSymbolicLink());
    assert(!fs.lstatSync(path.join(snapshot.root, "index.html")).isSymbolicLink());
    fs.writeFileSync(path.join(snapshot.root, "index.html"), "render-owned entry");
    assert.equal(fs.readFileSync(path.join(core, "index.html"), "utf8"), "shared entry");
    fs.writeFileSync(path.join(work, "projects", "film", "public", "audio.wav"), "changed audio B");
    assert.equal(fs.readFileSync(path.join(snapshot.root, "projects", "film", "public", "audio.wav"), "utf8"), "original audio A");
  } finally { snapshot.close(); }
  process.env.FRAME_SHARED_RUNTIME_FINGERPRINT = "b".repeat(64);
  assert.notEqual(inputManifest(work, "film").fingerprint, before.fingerprint);
  fs.symlinkSync(path.join(core, "index.html"), path.join(work, "projects", "film", "unsafe.html"));
  assert.throws(() => inputManifest(work, "film"), /links/);
  fs.unlinkSync(path.join(work, "projects", "film", "unsafe.html"));
  fs.unlinkSync(path.join(work, "public"));
  fs.symlinkSync(os.tmpdir(), path.join(work, "public"));
  assert.throws(() => inputManifest(work, "film"), /outside the pinned core/);
});
