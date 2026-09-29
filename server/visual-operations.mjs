import { z } from "zod";
import { probeMedia } from "../scripts/media-probe.mjs";
import { readProject } from "../scripts/project-metadata.mjs";
import { localAsset } from "../scripts/check-projects.mjs";
import { adapters } from "../src/engine/adapters.mjs";
import {
  validateVisualDocument,
  editVisualDocument,
  visualOperationSchema,
} from "../src/engine/visual-document.mjs";
import { confined } from "./security.mjs";
export function visualOperations({ add, db, repos, works, registry }) {
  const uuid = z.string().uuid();
  const invoke = (name, args) =>
    registry[name].fn(registry[name].schema.parse(args));
  async function context(id) {
    const work = await works.get(id, { active: true });
    const location = await repos.project(work.repo, work.project);
    const record = readProject(confined(location.dir, "project.ts"));
    const meta = record.meta;
    let file;
    try {
      if (record.visualLoadPath)
        file = await invoke("project_read", {
          repo: work.repo,
          project: work.project,
          path: "visual.json",
        });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return {
      work,
      location,
      file,
      context: { projectId: work.project, duration: meta.duration },
      result: {
        document: file
          ? validateVisualDocument(JSON.parse(file.content), {
              projectId: work.project,
              duration: meta.duration,
            })
          : null,
        sha256: file?.sha256 ?? null,
        duration: meta.duration,
        fps: meta.fps,
        adapters,
        editable: !!file,
        path: "visual.json",
      },
    };
  }
  add(
    "works_media_probe",
    "Probe a project-owned media source before adding a visual clip",
    { id: uuid, src: z.string() },
    async ({ id, src }) => {
      const { work, location } = await context(id);
      return probeMedia(location.repo.root, work.project, src);
    },
  );
  add(
    "works_composition",
    "Read visual clips and renderer capabilities with an edit revision",
    { id: uuid },
    async ({ id }) => (await context(id)).result,
  );
  add(
    "works_composition_edit",
    "Edit visual clips with stable ids and conflict protection",
    {
      id: uuid,
      expectedSha256: z.string().length(64),
      operations: z.array(visualOperationSchema).min(1).max(100),
    },
    async ({ id, ...request }) => {
      const { work, location, result, context: scope } = await context(id);
      if (!result.document)
        throw new Error("This work has no visual.json composition");
      const document = editVisualDocument(
        result.document,
        request.operations,
        scope,
      );
      for (const clip of document.clips)
        for (const src of clip.source.frames ??
          (clip.source.src ? [clip.source.src] : []))
          localAsset(location.repo.root, src, work.project);
      // The existing shared writer owns locking, compare-and-swap, atomic replacement and preview invalidation.
      const saved = await invoke("project_write", {
        repo: work.repo,
        project: work.project,
        path: "visual.json",
        expectedSha256: request.expectedSha256,
        content: JSON.stringify(document, null, 2) + "\n",
      });
      await db.pool.query("UPDATE works SET updated=now() WHERE id=$1", [id]);
      return { ...result, document, sha256: saved.sha256 };
    },
  );
}
