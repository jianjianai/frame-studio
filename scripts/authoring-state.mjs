import fs from "node:fs";
import { validateAudioDocument } from "../src/engine/audio-document.mjs";
import { validateVisualDocument } from "../src/engine/visual-document.mjs";
import { createHash } from "node:crypto";
import path from "node:path";
import { AUTHORING_PROTOCOL_VERSION, authoringModes } from "../src/contracts/authoring.mjs";
import { referenceCatalog } from "./authoring-reference.mjs";

const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const fields = (value, names) => Object.fromEntries(names.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
/** Static facts only: never import a scene or evaluate project code for handoff. */
export function authoringState(entry) {
  const meta = entry.meta, scope = { projectId: entry.directory, duration: meta.duration };
  const audio = meta.audioDocument ? validateAudioDocument(meta.audioDocument, scope) : null;
  const visual = meta.visual ? validateVisualDocument(meta.visual, scope) : null;
  const tracks = audio?.tracks ?? meta.audioTracks ?? (meta.audio ? [{ id: "main", kind: "file", src: meta.audio }] : []);
  const revision = (name) => hash(path.join(path.dirname(entry.file), name));
  return {
    authoringProtocol: AUTHORING_PROTOCOL_VERSION,
    entrypoints: {
      metadata: "project.ts", scene: entry.loadPath, audio: entry.audioLoadPath ?? null,
      audioDocument: entry.audioDocumentLoadPath ?? null, visual: entry.visualLoadPath ?? null,
    },
    audioTracks: tracks.slice(0, 128).map(track => audio ? {
      ...fields(track, ["id", "name", "gain", "muted", "pan", "output", "sends"]),
      clips: audio.clips.filter(clip => clip.track === track.id).length,
    } : track),
    authority: {
      metadata: { path: "project.ts", sha256: hash(entry.file) },
      audio: audio ? {
        mode: "document", path: "audio.json", sha256: revision("audio.json"), schemaVersion: audio.schemaVersion,
        tracks: audio.tracks.length, clips: audio.clips.length, sources: audio.sources.length,
        read: "audio get", edit: "audio edit", reference: "audio-v7",
      } : { mode: "legacy", path: "project.ts", tracks: tracks.length, reference: "audio", migration: "audio get" },
      visual: visual ? {
        mode: "document", path: "visual.json", sha256: revision("visual.json"), schemaVersion: visual.schemaVersion,
        clips: visual.clips.length, read: "composition get", edit: "composition edit", reference: "composition",
      } : { mode: "code", path: entry.loadPath, reference: "authoring" },
    },
    references: referenceCatalog(),
    interfaces: authoringModes,
  };
}
