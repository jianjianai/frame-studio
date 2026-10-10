import fs from "node:fs";
import path from "node:path";
import { editVisualDocument, validateVisualDocument } from "../src/engine/visual-document.mjs";
import { editAudioDocument, validateAudioDocument } from "../src/engine/audio-document.mjs";
import { readProjectDir, insertProjectProperty } from "./project-meta.mjs";
import { problem, sha256, writeFileAtomic, shortId } from "./util.mjs";

/**
 * visual.json (layers) and audio.json (multitrack mix) are edited through these
 * helpers by the studio UI and AI tools alike; writes check the expected sha256.
 */
function readJsonFile(file) {
  const text = fs.readFileSync(file, "utf8");
  return { value: JSON.parse(text), sha256: sha256(text) };
}

function save(file, value) {
  const text = JSON.stringify(value, null, 2) + "\n";
  writeFileAtomic(file, text);
  return sha256(text);
}

/** Rule violations in an edit are the caller's mistake (400), not a server failure; ZodErrors are formatted by the caller. */
function asBadRequest(edit) {
  try {
    return edit();
  } catch (error) {
    if (error.name === "ZodError" || error.status) throw error;
    throw problem(400, error.message, "INVALID_CONTENT");
  }
}

export function readVisual(work) {
  const { meta, loads } = readProjectDir(work.dir);
  if (loads.visual !== "./visual.json")
    throw problem(409, "这个作品没有使用 visual.json 图层（project.ts 中没有 loadVisual），画面完全由代码绘制。", "NO_VISUAL_DOCUMENT");
  const file = path.join(work.dir, "visual.json");
  const { value, sha256: hash } = readJsonFile(file);
  return { document: validateVisualDocument(value, { projectId: work.slug, duration: meta.duration }), sha256: hash, duration: meta.duration };
}

export function editVisual(work, { operations, expectedSha256, dryRun = false }) {
  const current = readVisual(work);
  if (expectedSha256 && expectedSha256 !== current.sha256) throw problem(409, "visual.json 已被修改，请重新读取", "CONFLICT", { sha256: current.sha256 });
  const next = asBadRequest(() => editVisualDocument(current.document, operations, { projectId: work.slug, duration: current.duration }));
  if (dryRun) return { document: next, sha256: current.sha256, dryRun: true };
  return { document: next, sha256: save(path.join(work.dir, "visual.json"), next) };
}

export function readAudio(work) {
  const { meta, loads } = readProjectDir(work.dir);
  const file = path.join(work.dir, "audio.json");
  if (loads.audioDocument === "./audio.json") {
    const { value, sha256: hash } = readJsonFile(file);
    return { document: validateAudioDocument(value, { projectId: work.slug, duration: meta.duration }), sha256: hash, declared: true, duration: meta.duration };
  }
  return { document: null, sha256: null, declared: false, duration: meta.duration };
}

/** Make sure project.ts loads audio.json, creating an empty mix the first time. */
export function ensureAudioDocument(work) {
  const current = readAudio(work);
  if (current.declared) return current;
  const document = { schemaVersion: 1, sources: [], tracks: [], clips: [], buses: [], master: { gain: 1, processors: [] }, linkedVideo: true };
  save(path.join(work.dir, "audio.json"), validateAudioDocument(document, { projectId: work.slug, duration: current.duration }));
  const projectFile = path.join(work.dir, "project.ts");
  writeFileAtomic(projectFile, insertProjectProperty(fs.readFileSync(projectFile, "utf8"), "loadAudioDocument", '() => import("./audio.json")'));
  return readAudio(work);
}

export function editAudio(work, { operations, expectedSha256, dryRun = false }) {
  const current = ensureAudioDocument(work);
  if (expectedSha256 && expectedSha256 !== current.sha256) throw problem(409, "audio.json 已被修改，请重新读取", "CONFLICT", { sha256: current.sha256 });
  const next = asBadRequest(() => editAudioDocument(current.document, operations, { projectId: work.slug, duration: current.duration }));
  if (dryRun) return { document: next, sha256: current.sha256, dryRun: true };
  const sha = save(path.join(work.dir, "audio.json"), next);
  ensureGeneratorLoader(work, next);
  return { document: next, sha256: sha };
}

/** Generated sources need `loadAudio` in project.ts; add it when audio.ts exists. Library sound modules do not. */
function ensureGeneratorLoader(work, document) {
  if (!document.sources.some((source) => source.kind === "generated" && !source.module.startsWith("materials/"))) return;
  const entry = ["audio.ts", "audio.tsx", "audio.js"].find((name) => fs.existsSync(path.join(work.dir, name)));
  if (!entry) return;
  const projectFile = path.join(work.dir, "project.ts");
  const code = fs.readFileSync(projectFile, "utf8");
  const next = insertProjectProperty(code, "loadAudio", '() => import("./audio")');
  if (next !== code) writeFileAtomic(projectFile, next);
}

/**
 * Place an audio file (recording, voice-over, imported music) or a sound of a library sound
 * module (`sound: { module: "materials/<library>/<file>.ts", id }`) on a track.
 * Creates the track when `trackName` does not exist yet.
 */
export function placeAudio(work, { src, sound, start = 0, duration, trackName = "录音", name, gain = 1, fadeIn, fadeOut }) {
  const current = ensureAudioDocument(work);
  const doc = current.document;
  let track = doc.tracks.find((item) => item.name === trackName);
  const operations = [];
  if (!track) {
    track = { id: "track_" + shortId(), name: trackName, gain: 1, pan: 0, muted: false, processors: [], output: "master", sends: [] };
    operations.push({ op: "put", collection: "tracks", value: track });
  }
  // One source per sound: placing the same sound again reuses it.
  const existing = sound && doc.sources.find((item) => item.kind === "generated" && item.module === sound.module && item.trackId === sound.id);
  const sourceId = existing?.id ?? "src_" + shortId();
  if (!existing)
    operations.push({ op: "put", collection: "sources", value: sound ? { id: sourceId, kind: "generated", module: sound.module, trackId: sound.id } : { id: sourceId, kind: "file", src } });
  const length = Math.min(duration ?? current.duration - start, current.duration - start);
  if (length <= 0) throw problem(400, `开始时间 ${start} 秒超出了作品时长 ${current.duration} 秒；需要更长的作品时先用 work_update 修改 duration`);
  const clip = { id: "clip_" + shortId(), track: track.id, source: sourceId, name: name || undefined, start, duration: length, gain, ...(fadeIn ? { fadeIn } : {}), ...(fadeOut ? { fadeOut } : {}) };
  operations.push({ op: "put", collection: "clips", value: clip });
  const result = editAudio(work, { operations, expectedSha256: current.sha256 });
  return { ...result, clip, track };
}
