import {inspectAudio} from "../scripts/audio-inspect.mjs";
import {transcodeAudio} from "../scripts/audio-media.mjs";
import {probeMedia} from "../scripts/media-probe.mjs";
import {audioContext,audioEdit} from "../scripts/audio-service.mjs";
import {audioOperationSchema} from "../src/engine/audio-document.mjs";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { checkProjects } from "../scripts/check-projects.mjs";
import { ProjectService } from "../scripts/project-service.mjs";
import { FrameError } from "../scripts/mcp/workspace.mjs";
import { problem } from "./security.mjs";

// A content branch has no private copy of the installed shared engine.
class WorkSource extends ProjectService {
  check(id) {
    this.project(id);
    this.assertTree(id);
    return checkProjects(this.root, {
      ids: [id],
      strict: true,
      sharedEngineRoot: fileURLToPath(
        new URL("../src/engine", import.meta.url),
      ),
    });
  }
}
const filePath = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const changes = z
  .array(
    z.strictObject({
      path: filePath,
      expectedSha256: digest.nullable(),
      content: z
        .string()
        .max(1024 * 1024)
        .nullable(),
    }),
  )
  .min(1)
  .max(20);
const patches = z
  .array(
    z.strictObject({
      path: filePath,
      expectedSha256: digest,
      replacements: z
        .array(
          z.strictObject({
            find: z
              .string()
              .min(1)
              .max(1024 * 1024),
            replace: z.string().max(1024 * 1024),
            count: z.number().int().min(1).max(1000).default(1),
          }),
        )
        .min(1)
        .max(50),
    }),
  )
  .min(1)
  .max(20);

/** Reuse the local CLI/MCP domain; the database lock additionally serializes platform tasks. */
export function workSourceTools({ add, works, repos, db, registry }) {
  const source = async (id, fn, { write = false, dryRun = false } = {}) => {
    const work = await works.get(id, { active: true });
    const run = async () => {
      // The work may have been trashed while this request waited for the lock.
      await works.get(id, { active: true });
      if (write && !dryRun) await repos.writable(work.repo, work.project);
      const { repo } = await repos.project(work.repo, work.project);
      const workspace = new WorkSource(repo.root, {
        projects: [work.project],
        readOnly: !write,
      });
      try {
        // Invalidate before AND after a mutation, including a failed/rolled-back proposal.
        if (write && !dryRun)
          await repos.revisions?.invalidate(work.repo, work.project);
        const value = await fn(workspace, work.project);
        if (write && !dryRun)
          await db.pool.query("UPDATE works SET updated=now() WHERE id=$1", [
            id,
          ]);
        return value;
      } catch (error) {
        if (error instanceof FrameError) {
          const conflict = [
            "VERSION_CONFLICT",
            "PROJECT_BUSY",
            "RECOVERY_REQUIRED",
            "LOCK_CHANGED",
          ].includes(error.code);
          const failure = problem(
            conflict ? 409 : error.code === "TOO_LARGE" ? 413 : 400,
            error.code === "RECOVERY_REQUIRED"
              ? "An interrupted edit needs recovery. Preserve the work and inspect its operation journal."
              : error.message,
          );
          Object.assign(failure, {
            code: error.code,
            recovery: conflict ? "read-current-source" : "correct-input",
          });
          throw failure;
        }
        if (error.code === "ENOENT")
          throw Object.assign(
            problem(404, "Source file or directory not found"),
            { code: "SOURCE_NOT_FOUND" },
          );
        throw error;
      } finally {
        if (write && !dryRun)
          await repos.revisions?.invalidate(work.repo, work.project);
      }
    };
    return db.lock(`${work.repo}:${work.project}`, run);
  };
  const id = z.string().uuid();
  add("works_audio_inspect","Read streamed source waveform and peak/RMS levels",{id,src:z.string()},({id,src})=>source(id,(workspace,project)=>inspectAudio(workspace.root,project,src)));
  add("works_audio_media_probe","Inspect audio streams and codecs",{id,src:z.string()},({id,src})=>source(id,(workspace,project)=>probeMedia(workspace.root,project,src)));
  add("works_audio_transcode","Create a compatible audio copy without replacing source or destination",{id,src:z.string(),out:z.string()},({id,src,out})=>source(id,(workspace,project)=>transcodeAudio(workspace.root,project,{src,out}),{write:true}));
  add("works_audio","Read authoritative audio document and capabilities",{id},({id})=>source(id,(workspace,project)=>audioContext(workspace,project)));
  add("works_audio_edit","Atomically edit multitrack audio with revision protection",{id,expectedSha256:digest.nullable(),projectSha256:digest.optional(),operations:z.array(audioOperationSchema).min(1).max(100),dryRun:z.boolean().default(false)},({id,...request})=>source(id,(workspace,project)=>audioEdit(workspace,project,request),{write:true,dryRun:request.dryRun}));
  add(
    "works_read_lines",
    "Read a UTF-8 line slice; sha256 covers the ENTIRE file, not just the slice. Follow nextLine until null.",
    {
      id,
      path: filePath,
      startLine: z.number().int().min(1).default(1),
      lineCount: z.number().int().min(1).max(1000).default(200),
    },
    (args) => registry.works_read.fn(registry.works_read.schema.parse(args)),
  );
  add(
    "works_edit",
    "Atomically create/replace/delete 1..20 UTF-8 files. null content deletes; null hash creates. Dry-run writes nothing; structural failure rolls back. Keep all related changes in one batch.",
    {
      id,
      changes,
      dryRun: z.boolean().default(false),
    },
    ({ id, changes, dryRun }) =>
      source(
        id,
        (workspace, project) => workspace.edit(project, changes, { dryRun }),
        { write: true, dryRun },
      ),
  );
  add(
    "works_patch_batch",
    "Apply exact replacements to hashed source files, without resending entire files. Each find must match count exactly. Failed validation rolls back the whole batch.",
    {
      id,
      changes: patches,
      dryRun: z.boolean().default(false),
    },
    ({ id, changes, dryRun }) =>
      source(
        id,
        (workspace, project) => workspace.patch(project, changes, { dryRun }),
        { write: true, dryRun },
      ),
  );
}
