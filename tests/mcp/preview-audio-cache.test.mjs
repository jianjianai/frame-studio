import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { audioCacheKeys, restoreAudioTrack } from "../../scripts/preview-audio-cache.mjs";

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
