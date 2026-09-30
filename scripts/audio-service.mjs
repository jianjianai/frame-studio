import {
  validateAudioDocument,
  editAudioDocument,
  audioEngines,
  audioProcessors,
  audioAssets,
} from "../src/engine/audio-document.mjs";
import { readProject, sourceFile } from "./project-metadata.mjs";
import { localAsset } from "./check-projects.mjs";
import { fail } from "./mcp/workspace.mjs";
export function legacyAudioDocument(meta) {
  const d = {
    schemaVersion: 1,
    sources: [],
    tracks: [],
    clips: [],
    buses: [],
    master: { gain: 1, processors: [] },
    linkedVideo: true,
  };
  for (const [i, t] of (
    meta.audioTracks ??
    (meta.audio
      ? [{ id: "main", name: "配乐", kind: "file", src: meta.audio }]
      : [])
  ).entries()) {
    const id = "legacy_" + i,
      channel = "track_" + i;
    d.sources.push(
      t.kind === "file"
        ? { id, kind: "file", src: t.src }
        : {
            id,
            kind: "generated",
            module: "legacy",
            trackId: t.id,
            engine: "custom",
          },
    );
    d.tracks.push({ id: channel, name: t.name ?? t.id });
    const available = meta.duration - (t.start ?? 0);
    if (available <= 0) continue;
    d.clips.push({
      id: "clip_" + i,
      track: channel,
      source: id,
      start: t.start ?? 0,
      duration: Math.min(t.duration ?? available, available),
      offset: t.offset ?? 0,
      phase: t.phase ?? 0,
      rate: t.playbackRate ?? 1,
      ...(t.loop ? { loop: t.loop } : {}),
      gain: t.gain ?? 1,
      muted: t.muted ?? false,
    });
  }
  return validateAudioDocument(d, {
    projectId: meta.id,
    duration: meta.duration,
  });
}
export function audioContext(workspace, id) {
  const record = readProject(workspace.file(id, "project.ts")),
    project = workspace.textFile(id, "project.ts");
  const file = record.audioDocumentLoadPath
    ? workspace.textFile(id, "audio.json")
    : null;
  return {
    document: file
      ? validateAudioDocument(JSON.parse(file.text), {
          projectId: id,
          duration: record.meta.duration,
        })
      : legacyAudioDocument(record.meta),
    sha256: file?.sha256 ?? null,
    projectSha256: project.sha256,
    declared: !!file,
    duration: record.meta.duration,
    fps: record.meta.fps,
    engines: audioEngines,
    processors: audioProcessors,
    path: "audio.json",
  };
}
export function audioEdit(
  workspace,
  id,
  { expectedSha256, projectSha256, operations, dryRun = false },
) {
  const current = audioContext(workspace, id);
  if (current.sha256 !== expectedSha256)
    fail("VERSION_CONFLICT", "Audio document changed; read it again");
  if (!current.declared && current.projectSha256 !== projectSha256)
    fail(
      "VERSION_CONFLICT",
      "Project changed; read it again before enabling audio",
    );
  const document = editAudioDocument(current.document, operations, {
    projectId: id,
    duration: current.duration,
  });
  for (const src of audioAssets(document)) localAsset(workspace.root, src, id);
  const changes = [
    {
      path: "audio.json",
      expectedSha256,
      content: JSON.stringify(document, null, 2) + "\n",
    },
  ];
  if (!current.declared) {
    const file = workspace.file(id, "project.ts"),
      text = workspace.textFile(id, "project.ts").text;
    const exported = sourceFile(file).program.body.find(
      (n) => n.type === "ExportDefaultDeclaration",
    ).declaration;
    changes.push({
      path: "project.ts",
      expectedSha256: projectSha256,
      content:
        text.slice(0, exported.start) +
        "{...(" +
        text.slice(exported.start, exported.end) +
        "), loadAudioDocument: () => import('./audio.json')}" +
        text.slice(exported.end),
    });
  }
  const result = workspace.edit(id, changes, { dryRun });
  return {
    ...result,
    ...(dryRun ? { document } : audioContext(workspace, id)),
  };
}
