import { adapters } from "../src/engine/adapters.mjs";
import {
  validateVisualDocument,
  editVisualDocument,
} from "../src/engine/visual-document.mjs";
import { readProject } from "./project-metadata.mjs";
import { localAsset } from "./check-projects.mjs";
import { fail } from "./mcp/workspace.mjs";
export function visualContext(workspace, id) {
  const record = readProject(workspace.file(id, "project.ts"));
  const metadata = record.meta;
  const value = record.visualLoadPath
    ? workspace.textFile(id, "visual.json", { missing: true })
    : null;
  return {
    document: value
      ? validateVisualDocument(JSON.parse(value.text), {
          projectId: id,
          duration: metadata.duration,
        })
      : null,
    sha256: value?.sha256 ?? null,
    duration: metadata.duration,
    fps: metadata.fps,
    adapters,
    editable: !!value,
    path: "visual.json",
  };
}
export function visualEdit(
  workspace,
  id,
  { expectedSha256, operations, dryRun = false },
) {
  const current = visualContext(workspace, id);
  if (!current.document)
    fail(
      "NO_VISUAL_DOCUMENT",
      "This work uses a code scene. Add visual.json and wire createCompositionScene before editing clips.",
    );
  if (current.sha256 !== expectedSha256)
    fail(
      "VERSION_CONFLICT",
      "Visual document changed; read the current version first",
    );
  const document = editVisualDocument(current.document, operations, {
    projectId: id,
    duration: current.duration,
  });
  for (const clip of document.clips)
    for (const src of clip.source.frames ??
      (clip.source.src ? [clip.source.src] : []))
      localAsset(workspace.root, src, id);
  const content = JSON.stringify(document, null, 2) + "\n";
  const result = workspace.edit(
    id,
    [{ path: "visual.json", expectedSha256, content }],
    { dryRun },
  );
  return {
    ...result,
    ...(dryRun ? { document } : visualContext(workspace, id)),
  };
}
