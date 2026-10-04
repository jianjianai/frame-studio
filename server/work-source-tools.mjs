import {inspectAudio} from "../scripts/audio-inspect.mjs";
import {transcodeAudio} from "../scripts/audio-media.mjs";
import {probeMedia} from "../scripts/media-probe.mjs";
import {audioContext} from "../scripts/audio-service.mjs";
import {audioEditRequestSchema,visualEditRequestSchema} from "../src/engine/document-edit.mjs";
import {visualContext} from "../scripts/visual-service.mjs";
import {setTimeout as sleep} from "node:timers/promises";
import { z } from "zod";
import { sourceEditRequestSchema, sourcePatchRequestSchema } from "../src/contracts/source-edit.mjs";
import { fileURLToPath } from "node:url";
import { projectOperationAsync } from "../scripts/project-io.mjs";
import { ProjectService } from "../scripts/project-service.mjs";
import { FrameError } from "../scripts/mcp/workspace.mjs";
import { problem } from "./security.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";

const coreRoot = fileURLToPath(new URL("../", import.meta.url));

const filePath = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const changes = sourceEditRequestSchema.shape.changes;
const patches = sourcePatchRequestSchema.shape.changes;

/** Reuse the local CLI/MCP domain; the database lock additionally serializes platform tasks. */
export function workSourceTools({ add, works, repos, db, registry }) {
  const source = async (id, fn, { write = false, dryRun = false } = {}) => {
    const work = await works.get(id, { active: true });
    const run = async () => {
      // The work may have been trashed while this request waited for the lock.
      await works.get(id, { active: true });
      if (write && !dryRun) await repos.writable(work.repo, work.project);
      const { repo } = await repos.project(work.repo, work.project);
      const core = process.env.FRAME_SHARED_RUNTIME_ROOT || coreRoot;
      const identity = await runtimeIdentity(core);
      const workspace = new ProjectService(repo.root, {
        projects: [work.project],
        readOnly: !write,
        runtime: { root: core, fingerprint: identity.fingerprint },
        checkOptions: { sharedEngineRoot: fileURLToPath(new URL("../src/engine", import.meta.url)) },
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
    // Readers briefly wait for a coherent committed document. Writes keep the
    // existing fail-fast conflict contract and are never replayed automatically.
    const deadline = Date.now() + 3000;
    for (;;) {
      try { return await db.lock(`${work.repo}:${work.project}`, run); }
      catch (error) {
        if (write || error.statusCode !== 409 || error.message !== "Repository is busy" || Date.now() >= deadline) throw error;
        await sleep(50);
      }
    }
  };
  const id = z.string().uuid();
  add("works_media_probe","Read dimensions, duration and codecs of a project-owned media source",{id,src:z.string()},({id,src})=>source(id,(workspace,project)=>probeMedia(workspace.root,project,src)));
  add("works_composition","Read authoritative visual clips and renderer capabilities with an edit revision",{id},({id})=>source(id,(workspace,project)=>visualContext(workspace,project)));
  add("works_composition_edit","Atomically edit visual clips with revision protection and optional dry run",{id,...visualEditRequestSchema.shape},({id,...request})=>source(id,(workspace,project)=>projectOperationAsync(workspace,"visualEdit",project,request),{write:true,dryRun:request.dryRun}));
  add("works_audio_inspect","Read streamed source waveform and peak/RMS levels",{id,src:z.string()},({id,src})=>source(id,(workspace,project)=>inspectAudio(workspace.root,project,src)));
  add("works_audio_media_probe","Inspect audio streams and codecs",{id,src:z.string()},({id,src})=>source(id,(workspace,project)=>probeMedia(workspace.root,project,src)));
  add("works_audio_transcode","Create a compatible audio copy without replacing source or destination",{id,src:z.string(),out:z.string()},({id,src,out})=>source(id,(workspace,project)=>transcodeAudio(workspace.root,project,{src,out}),{write:true}));
  add("works_audio","Read authoritative audio document and capabilities",{id},({id})=>source(id,(workspace,project)=>audioContext(workspace,project)));
  add("works_audio_edit","Atomically edit multitrack audio with revision protection",{id,...audioEditRequestSchema.shape},({id,...request})=>source(id,(workspace,project)=>projectOperationAsync(workspace,"audioEdit",project,request),{write:true,dryRun:request.dryRun}));
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
        (workspace, project) => projectOperationAsync(workspace, "edit", project, changes, { dryRun }),
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
        (workspace, project) => projectOperationAsync(workspace, "patch", project, changes, { dryRun }),
        { write: true, dryRun },
      ),
  );
}
