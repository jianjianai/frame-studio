import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { audioCacheKeys, restoreAudioTrack } from "../../scripts/preview-audio-cache.mjs";
import { linkSharedRuntime } from "../../scripts/shared-runtime.mjs";

test("audio dependency keys ignore visual edits but include imported score, assets and timing", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-audio-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "projects/film"); fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.writeFileSync(path.join(dir, "project.ts"), 'export default {id:"film",duration:4,audioTracks:[{id:"music",kind:"generated"}],load:()=>import("./scene"),loadAudio:()=>import("./audio")};');
  fs.writeFileSync(path.join(dir, "scene.ts"), "first visual");
  fs.writeFileSync(path.join(dir, "audio.ts"), 'import {score} from "./score"; export {score};');
  fs.writeFileSync(path.join(dir, "score.ts"), "export const score=1;");
  const first = await audioCacheKeys(root, "film");
  fs.writeFileSync(path.join(dir, "scene.ts"), "second visual");
  assert.deepEqual(await audioCacheKeys(root, "film"), first);
  fs.writeFileSync(path.join(dir, "score.ts"), "export const score=2;");
  assert.notDeepEqual(await audioCacheKeys(root, "film"), first);
  assert.equal(await restoreAudioTrack(path.join(root, "missing"), dir, "music", first.music, 4), null);
});

test("audio keys use the verified shared runtime while project media and foreign links remain unsafe", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "frame-shared-audio-cache-")),
    core = path.join(base, "core"), root = path.join(base, "work"), dir = path.join(root, "projects/film");
  const previous = { root: process.env.FRAME_SHARED_RUNTIME_ROOT, fingerprint: process.env.FRAME_SHARED_RUNTIME_FINGERPRINT };
  t.after(() => {
    for (const [name, value] of [["FRAME_SHARED_RUNTIME_ROOT", previous.root], ["FRAME_SHARED_RUNTIME_FINGERPRINT", previous.fingerprint]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  for (const name of ["src/engine", "src/contracts", "scripts", "public"])
    fs.mkdirSync(path.join(core, name), { recursive: true });
  fs.writeFileSync(path.join(core, "public/font.woff2"), "immutable font");
  fs.writeFileSync(path.join(core, "package.json"), "{}");
  fs.writeFileSync(path.join(core, "pnpm-lock.yaml"), "lockfileVersion: 9");
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.writeFileSync(path.join(dir, "project.ts"), 'export default {id:"film",duration:4,audioTracks:[{id:"music",kind:"generated"},{id:"voice",kind:"file",src:"films/film/voice.wav"}],load:()=>import("./scene"),loadAudio:()=>import("./audio")};');
  fs.writeFileSync(path.join(dir, "scene.ts"), "visual A");
  fs.writeFileSync(path.join(dir, "audio.ts"), 'import {score} from "sound-package";export {score};');
  fs.writeFileSync(path.join(dir, "public/voice.wav"), "original audio A");
  linkSharedRuntime(root, core);
  process.env.FRAME_SHARED_RUNTIME_ROOT = core;
  process.env.FRAME_SHARED_RUNTIME_FINGERPRINT = "a".repeat(64);
  const first = await audioCacheKeys(root, "film");
  assert.match(first.music, /^[a-f0-9]{64}$/);
  assert.match(first.voice, /^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(dir, "scene.ts"), "visual B");
  assert.deepEqual(await audioCacheKeys(root, "film"), first);
  process.env.FRAME_SHARED_RUNTIME_FINGERPRINT = "b".repeat(64);
  const nextRuntime = await audioCacheKeys(root, "film");
  assert.notEqual(nextRuntime.music, first.music);
  assert.notEqual(nextRuntime.voice, first.voice);
  fs.writeFileSync(path.join(dir, "public/voice.wav"), "original audio B");
  assert.notEqual((await audioCacheKeys(root, "film")).voice, nextRuntime.voice);
  fs.unlinkSync(path.join(dir, "public/voice.wav"));
  fs.symlinkSync(path.join(core, "public/font.woff2"), path.join(dir, "public/voice.wav"));
  await assert.rejects(audioCacheKeys(root, "film"), /Unsafe audio cache input/);
  fs.unlinkSync(path.join(dir, "public/voice.wav"));
  fs.linkSync(path.join(core, "public/font.woff2"), path.join(dir, "public/voice.wav"));
  await assert.rejects(audioCacheKeys(root, "film"), /Unsafe audio cache input/);
  fs.unlinkSync(path.join(dir, "public/voice.wav"));
  fs.writeFileSync(path.join(dir, "public/voice.wav"), "original audio C");
  fs.unlinkSync(path.join(root, "public"));
  fs.symlinkSync(base, path.join(root, "public"));
  await assert.rejects(audioCacheKeys(root, "film"), /outside the pinned core/);
});
