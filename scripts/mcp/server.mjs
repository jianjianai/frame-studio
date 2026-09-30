import {exportAudio} from "../audio-export.mjs";
import {inspectAudio} from "../audio-inspect.mjs";
import {transcodeAudio} from "../audio-media.mjs";
import {audioContext} from "../audio-service.mjs";
import {audioEngines,audioProcessors} from "../../src/engine/audio-document.mjs";
import fs from "node:fs";
import { projectCreationShape, creationArguments, projectDefaults, authoringReferences, authoringModes } from "../../src/contracts/authoring.mjs";
import { PLATFORM_VERSION } from "../../src/contracts/version.mjs";
import { audioEditRequestSchema, visualEditRequestSchema } from "../../src/engine/document-edit.mjs";
import { sourceEditRequestSchema, sourcePatchRequestSchema } from "../../src/contracts/source-edit.mjs";
import { readAuthoringReference, referenceCatalog } from "../authoring-reference.mjs";
import { errorRecovery } from "../tool-errors.mjs";
import { rendererIds, adapters } from "../../src/engine/adapters.mjs";
import { probeMedia,transcodeMedia } from "../media-probe.mjs";
import { visualContext } from "../visual-service.mjs";
import { projectOperationAsync } from "../project-io.mjs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { validProjectId } from "../project-metadata.mjs";
import { fail, safePath } from "./workspace.mjs";
import { ProjectService as Workspace } from "../project-service.mjs";
import { Jobs } from "./jobs.mjs";
import { compareReviews, recordReview } from "../production-media.mjs";
import { runProcess } from "../project-execution.mjs";
import { imageResult } from "./image-result.mjs";
import {
  initSpeech,
  speechStatus,
  listSpeechVoices,
  readSpeech,
} from "../speech.mjs";
import {
  AssetTransfers,
  CHUNK_BYTES,
  MAX_ASSET_BYTES,
  decodeChunk,
} from "../asset-transfer.mjs";

const project = z.string().refine(validProjectId, "Invalid project id");
const filePath = z.string().min(1).max(512);
const jobId = z.string().uuid();
const width = z.number().int().min(2).max(3840).multipleOf(2);
const seconds = z.number().finite().nonnegative();
const imageOptions = {
  presentation: z.enum(["native", "image-only", "metadata"]).default("native"),
  maxWidth: z.number().int().min(320).max(2048).default(1600),
};
const refs = Object.fromEntries(Object.entries(authoringReferences).map(([name, value]) => [name, value.path]));
export const jsonResult = (value, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
  ...(isError ? { isError: true } : {}),
});

export function createFrameServer({
  root,
  projects = [],
  readOnly = false,
  timeoutMs = 600000,
  jobManager,
  assetManager,
  decorateResult = (value) => value,
}) {
  const workspace = new Workspace(root, {
    projects,
    readOnly,
    sessionId: jobManager?.workspace.sessionId,
  });
  const jobs = jobManager ?? new Jobs(workspace, { timeoutMs });
  const assets = assetManager ?? new AssetTransfers(workspace);
  const writeTools = new Set();
  const reference = (name) => readAuthoringReference(workspace.root, name);
  const catalog = new Map();
  const server = new McpServer(
    { name: "frame-animation", version: PLATFORM_VERSION },
    {
      instructions:
        "Edit one FRAME animation project at a time. Begin with frame_project_context and its references. Read files for SHA-256 before editing. Changes stay in projects/<id>/. Serialize writes and render/validation jobs in one project; different projects can run concurrently. PROJECT_BUSY includes the active job and available actions: query it, wait, or cancel only your own job. A completed check with passed=false is a report, not a malformed tool call. External workspace changes have unknown authors and do not invalidate a passing structural check. Inspect native PNG images; retry presentation=image-only if the client omits the image. Never claim visual/audio review from a file path or metadata. Rendering executes trusted local project code. Authenticated in-scope operations execute without an additional server approval step; the client controls its own approval policy.",
    },
  );
  const register = (
    name,
    description,
    shape,
    handler,
    { write = false, destructive = false, openWorld = false } = {},
  ) => {
    if (write) writeTools.add(name);
    if (readOnly && write) return;
    const schema = z.strictObject(shape);
    catalog.set(name, {
      name, description, inputSchema: schema,
      annotations: { readOnlyHint: !write, destructiveHint: destructive, idempotentHint: !write, openWorldHint: openWorld },
    });
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: !write,
          destructiveHint: destructive,
          idempotentHint: !write,
          openWorldHint: openWorld,
        },
      },
      async (args) => {
        try {
          return decorateResult(await handler(args));
        } catch (error) {
          if (error.code === "PROJECT_BUSY" && args.project) {
            try {
              error.details = {
                ...error.details,
                activeOperation: jobs.operation(args.project),
              };
            } catch {}
          }
          return jsonResult(
            {
              error: errorRecovery(error),
            },
            true,
          );
        }
      },
    );
  };
  register("frame_media_probe","Read project media dimensions, duration and codecs",{project,src:z.string()},async({project:id,src})=>{workspace.project(id);return jsonResult(await probeMedia(workspace.root,id,src));});
  register("frame_media_transcode","Create a separate VP9/Opus compatible video copy without overwriting source or output",{project,src:z.string(),out:z.string()},async({project:id,...request})=>{workspace.writable();const release=workspace.lock(id,"media-transcode");try{return jsonResult(await transcodeMedia(workspace.root,id,request));}finally{release();}},{write:true});
  register("frame_renderers", "List built-in engines, media sources and their capabilities; no preferred engine", {}, () => jsonResult({adapters}));
  register("frame_audio_export","Export frozen mix and optional channel stems with loudness/true peak report",{project,format:z.enum(["wav","flac","mp3","ogg","m4a"]).default("wav"),stems:z.boolean().default(false),start:z.number().nonnegative().default(0),end:z.number().positive().optional()},async({project:id,...request})=>{workspace.writable();workspace.project(id);const release=workspace.lock(id,"audio-export");try{return jsonResult(await exportAudio(workspace.root,id,request));}finally{release();}},{write:true});
  register("frame_audio_inspect","Read source waveform and sample peak/RMS; not a listening review",{project,src:z.string()},async({project:id,src})=>{workspace.project(id);return jsonResult(await inspectAudio(workspace.root,id,src));});
  register("frame_audio_transcode","Convert a project audio source to a separate WAV FLAC MP3 Ogg or M4A copy",{project,src:z.string(),out:z.string()},async({project:id,...request})=>{workspace.writable();workspace.project(id);const release=workspace.lock(id,"audio-transcode");try{return jsonResult(await transcodeAudio(workspace.root,id,request));}finally{release();}},{write:true});
  register("frame_audio_engines","List audio source frameworks and processor capabilities",{},()=>jsonResult({engines:audioEngines,processors:audioProcessors}));
  register("frame_audio","Read audio document and revision, or an editable legacy migration",{project},({project:id})=>jsonResult(audioContext(workspace,id)));
  register("frame_audio_edit","Edit audio sources tracks clips buses and processors atomically",{project,...audioEditRequestSchema.shape},async({project:id,...request})=>jsonResult(await projectOperationAsync(workspace,"audioEdit",id,request)),{write:true});
  register("frame_composition", "Read authoritative visual.json clips and edit revision", {project}, ({project:id}) => jsonResult(visualContext(workspace,id)));
  register("frame_composition_edit", "Add, trim, split, move, reorder, replace or keyframe visual clips atomically", {project,...visualEditRequestSchema.shape}, async({project:id,...request}) => jsonResult(await projectOperationAsync(workspace,"visualEdit",id,request)), {write:true});
  register(
    "frame_list_projects",
    "Discover allowed projects using static metadata without executing scene code. Broken projects are reported individually.",
    {},
    () => jsonResult(workspace.listProjects()),
  );
  register(
    "frame_read_reference",
    "Read the shared authoring contract, engine types or MCP workflow by a fixed reference name; useful when the client does not expose resources.",
    { name: z.enum(Object.keys(refs)) },
    ({ name }) => jsonResult(reference(name)),
  );
  register(
    "frame_project_context",
    "Read this project's metadata, audio tracks, instructions, README, boundaries and Git baseline before editing.",
    { project, detail: z.boolean().default(false) },
    ({ project: id, detail }) =>
      jsonResult({
        ...workspace.context(id, { detail }),
        activeOperation: jobs.operation(id),
        assetTransfers: assets.capabilities(),
      }),
  );
  register(
    "frame_project_operation",
    "Inspect the current project operation, owning job, liveness and query/cancel/recovery actions without acquiring its lock.",
    { project },
    ({ project: id }) => jsonResult(jobs.operation(id)),
  );
  register(
    "frame_recover_operation",
    "Recover an identified stale lock only after both its owner and worker have exited and no unfinished transaction remains. Obtain lockId with frame_project_operation first.",
    { project, lockId: z.string().uuid() },
    ({ project: id, lockId }) =>
      jsonResult(workspace.recoverOperation(id, lockId)),
    { write: true },
  );
  register(
    "frame_list_files",
    "List project files with pagination. Hidden directories and generated outputs are excluded.",
    {
      project,
      directory: filePath.optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(200),
    },
    async ({ project: id, ...options }) =>
      jsonResult(await projectOperationAsync(workspace, "listFiles", id, options)),
  );
  register(
    "frame_read_file",
    "Read UTF-8 source, metadata, music or documentation. SHA-256 always covers the complete file, even for a line slice.",
    {
      project,
      path: filePath,
      startLine: z.number().int().min(1).default(1),
      lineCount: z.number().int().min(1).max(1000).default(400),
    },
    ({ project: id, path, ...options }) =>
      jsonResult(workspace.readFile(id, path, options)),
  );
  register(
    "frame_search",
    "Search literal text within one project; returns bounded line matches and full file hashes.",
    {
      project,
      query: z.string().min(1).max(1000),
      directory: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async ({ project: id, ...options }) => jsonResult(await projectOperationAsync(workspace, "search", id, options)),
  );
  register(
    "frame_patch_files",
    "Apply exact text replacements to hashed files. Match count must agree. Creates a checkpoint; strict validation failure rolls back.",
    { project, ...sourcePatchRequestSchema.shape },
    async ({ project: id, changes, dryRun }) =>
      jsonResult(await projectOperationAsync(workspace, "patch", id, changes, { dryRun })),
    { write: true, destructive: true },
  );
  register(
    "frame_checkpoint",
    "Save the current editable project text as a recoverable checkpoint.",
    { project, label: z.string().max(200).optional() },
    async ({ project: id, label }) => jsonResult(await projectOperationAsync(workspace, "checkpoint", id, label)),
    { write: true },
  );
  register(
    "frame_history",
    "List checkpoints and current input fingerprint, including binary assets.",
    { project },
    async ({ project: id }) => jsonResult(await projectOperationAsync(workspace, "history", id)),
  );
  register(
    "frame_restore",
    "Preview or apply text restoration. Requires the current fingerprint from history. External version changes are rejected. Binary assets are not reverted.",
    {
      project,
      checkpoint: jobId,
      expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      dryRun: z.boolean().default(true),
    },
    async ({ project: id, checkpoint, expectedFingerprint, dryRun }) =>
      jsonResult(
        await projectOperationAsync(workspace, "restore", id, checkpoint, expectedFingerprint, dryRun),
      ),
    { write: true, destructive: true },
  );
  register(
    "frame_edit_files",
    "Batch create/replace/delete text files inside one project. Pass the last full-file SHA-256; null means new file. content:null deletes. Strict validation failure rolls back the batch. dryRun checks paths/hashes only.",
    { project, ...sourceEditRequestSchema.shape },
    async ({ project: id, changes, dryRun }) =>
      jsonResult(await projectOperationAsync(workspace, "edit", id, changes, { dryRun })),
    { write: true, destructive: true },
  );
  register(
    "frame_create_project",
    "Create a complete animation with the existing scaffold; never overwrite. Read the returned project context before editing.",
    {
      project,
      ...projectCreationShape,
    },
    ({ project: id, ...request }) => {
      const arguments_ = creationArguments(request);
      workspace.writable();
      workspace.project(id, { exists: false });
      safePath(workspace.root, "projects/.cache/new-project-locks", {
        internal: true,
      });
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../new-animation.mjs", import.meta.url)),
          id,
          request.title,
          ...arguments_,
        ],
        {
          cwd: workspace.root,
          encoding: "utf8",
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        },
      );
      if (result.status !== 0)
        fail(
          "CREATE_FAILED",
          result.error?.message ?? result.stderr ?? "Scaffold failed.",
        );
      return jsonResult(workspace.context(id));
    },
    { write: true },
  );
  register(
    "frame_start_validation",
    "Run project-only types/tests/strict checks asynchronously. Does not claim visual or listening acceptance. Read result.json after the job succeeds.",
    {
      project,
      action: z
        .enum(["validate", "typecheck", "test", "test-e2e", "build"])
        .default("validate"),
    },
    async ({ project: id, action }) => jsonResult(await jobs.start(id, action, {})),
    { write: true, openWorld: true },
  );
  register(
    "frame_start_review",
    "Create a versioned review package: clip, timestamped frames, subtitles, mix/stems, measurements and A/B-ready page. Content review stays not_run.",
    {
      project,
      start: seconds,
      end: seconds,
      width: width.default(640),
      fps: z.number().int().min(12).max(60).optional(),
    },
    async ({ project: id, ...options }) =>
      jsonResult(await jobs.start(id, "review", options)),
    { write: true, openWorld: true },
  );
  register(
    "frame_verify_delivery",
    "Fully decode and count frames of an existing project media file, analyze audio, extract final frames and check input provenance asynchronously.",
    { project, path: filePath },
    async ({ project: id, path }) => {
      workspace.file(id, path);
      return jsonResult(
        await jobs.start(id, "verify", { file: "projects/" + id + "/" + path }),
      );
    },
    { write: true, openWorld: true },
  );
  register(
    "frame_compare_reviews",
    "Build a local A/B player for two reviews of the same time range.",
    { project, a: jobId, b: jobId },
    ({ project: id, a, b }) => {
      workspace.writable();
      workspace.project(id);
      return jsonResult(compareReviews(root, id, a, b));
    },
    { write: true },
  );
  register(
    "frame_review_note",
    "Record an actual review observation at an absolute project time, tied to its input version. Set listening only after actual audio review.",
    {
      project,
      reviewId: jobId,
      reviewer: z.string().min(1).max(200),
      time: seconds,
      note: z.string().min(1).max(10000),
      visual: z.boolean().default(false),
      listening: z.boolean().default(false),
    },
    ({ project: id, reviewId, ...note }) => {
      workspace.writable();
      workspace.project(id);
      return jsonResult(recordReview(root, id, reviewId, note));
    },
    { write: true },
  );
  register(
    "frame_review_artifact",
    "Read a review PNG, report or subtitle. WAV is a file link unless inlineAudio is explicitly requested by an audio-capable client.",
    {
      project,
      reviewId: jobId,
      name: z.string().regex(/^[a-zA-Z0-9-]+\.(png|json|srt|wav|mp4|html)$/),
      inlineAudio: z.boolean().default(false),
      ...imageOptions,
    },
    async ({
      project: id,
      reviewId,
      name,
      inlineAudio,
      presentation,
      maxWidth,
    }) => {
      const path = workspace.file(id, `exports/reviews/${reviewId}/${name}`);
      const bytes = fs.statSync(path).size;
      if (/\.(mp4|html)$/.test(name) || (name.endsWith(".wav") && !inlineAudio))
        return jsonResult({ path, bytes });
      if (bytes > (name.endsWith(".png") ? 32 : 6) * 1024 * 1024)
        fail(
          "TOO_LARGE",
          "Generate a smaller review or open the local artifact.",
        );
      const data = fs.readFileSync(path);
      if (name.endsWith(".png"))
        return imageResult(
          data,
          { path, name, bytes, mimeType: "image/png" },
          { presentation, maxWidth },
        );
      if (name.endsWith(".wav"))
        return {
          content: [
            {
              type: "audio",
              mimeType: "audio/wav",
              data: data.toString("base64"),
            },
          ],
        };
      return jsonResult({ name, content: data.toString("utf8") });
    },
  );
  register(
    "frame_import_asset",
    "Import an already staged asset from inside the project, preserving its source/license. Use CLI film import for external files.",
    { project, source: filePath, license: z.string().min(1).max(4000) },
    async ({ project: id, source, license }) => {
      workspace.writable();
      const file = workspace.file(id, source);
      const release = workspace.lock(id, "import");
      try {
        const result = await runProcess(
          process.execPath,
          [
            fileURLToPath(new URL("../import-asset.mjs", import.meta.url)),
            id,
            file,
            "--license",
            license,
          ],
          { root },
        );
        return jsonResult(result, result.status === "failed");
      } finally {
        release();
      }
    },
    { write: true },
  );
  const uploadMetadata = {
    filename: z.string().min(1).max(120),
    license: z.string().min(1).max(4000),
    source: z.string().max(4000).optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    requestId: jobId.optional(),
  };
  register(
    "frame_upload_asset",
    "Upload a small material (up to 1 MiB decoded) as canonical base64, verify and register it without changing its bytes. Reuse requestId to retry without duplication. For large files prefer the authenticated HTTP upload URL or frame_asset_upload chunks; do not invent attachment URLs or base64.",
    {
      project,
      ...uploadMetadata,
      dataBase64: z
        .string()
        .min(1)
        .max(Math.ceil(CHUNK_BYTES / 3) * 4),
    },
    async ({ project: id, ...options }) =>
      jsonResult(await assets.upload(id, options)),
    { write: true },
  );
  register(
    "frame_asset_upload",
    "Resumable material transfer: begin needs filename/bytes/license and optional SHA-256; chunk needs uploadId/offset/dataBase64; status can waitMs up to 20000 for a URL download; complete verifies and registers; abort removes staged bytes; prune removes this authorization's expired receipts. Resume at receivedBytes. HTTP endpoints avoid base64 for large files. Each upload belongs to its creating authorization.",
    {
      project,
      action: z.enum([
        "begin",
        "chunk",
        "status",
        "complete",
        "abort",
        "prune",
      ]),
      uploadId: jobId.optional(),
      filename: uploadMetadata.filename.optional(),
      license: uploadMetadata.license.optional(),
      source: uploadMetadata.source,
      sha256: uploadMetadata.sha256,
      requestId: uploadMetadata.requestId,
      bytes: z.number().int().min(12).max(MAX_ASSET_BYTES).optional(),
      offset: z.number().int().nonnegative().optional(),
      dataBase64: z
        .string()
        .min(1)
        .max(Math.ceil(CHUNK_BYTES / 3) * 4)
        .optional(),
      waitMs: z.number().int().min(0).max(20000).default(0),
    },
    async ({
      project: id,
      action,
      uploadId,
      offset,
      dataBase64,
      waitMs,
      ...options
    }) => {
      if (action === "begin") return jsonResult(assets.begin(id, options));
      if (action === "prune") return jsonResult(await assets.prune(id));
      if (action === "status")
        return jsonResult(await assets.wait(id, uploadId, waitMs));
      if (action === "chunk")
        return jsonResult(
          assets.chunk(
            id,
            uploadId,
            offset,
            decodeChunk(dataBase64),
            options.sha256,
          ),
        );
      if (action === "complete")
        return jsonResult(await assets.complete(id, uploadId));
      return jsonResult(await assets.abort(id, uploadId));
    },
    { write: true },
  );
  register(
    "frame_fetch_asset",
    "Start a background download from a real public HTTPS URL and register the verified material. Returns uploadId; query frame_asset_upload status (waitMs=20000) or abort. URLs may be signed; credentials/query strings are not stored in the catalog. Private networks, credential headers and redirects to private hosts are not allowed. If the client cannot expose an attachment URL, use the upload transport.",
    {
      project,
      url: z.string().min(1).max(8192),
      filename: uploadMetadata.filename,
      license: uploadMetadata.license,
      sha256: uploadMetadata.sha256,
      maxBytes: z
        .number()
        .int()
        .min(12)
        .max(MAX_ASSET_BYTES)
        .default(MAX_ASSET_BYTES),
    },
    ({ project: id, ...options }) => jsonResult(assets.fetch(id, options)),
    { write: true, openWorld: true },
  );
  register(
    "frame_read_asset",
    "Read a registered public/imports material's metadata and authenticated download link. metadataOnly=false returns up to 1 MiB as base64 with chunk SHA-256 and nextOffset for binary clients; this is not a visual/audio review tool.",
    {
      project,
      path: filePath,
      metadataOnly: z.boolean().default(true),
      offset: z.number().int().nonnegative().default(0),
      length: z.number().int().min(1).max(CHUNK_BYTES).default(CHUNK_BYTES),
    },
    ({ project: id, path, ...options }) =>
      jsonResult(assets.read(id, path, options)),
  );
  register(
    "frame_start_export",
    "Formal export with real trial encoding, frozen inputs, verified reusable segments, software H.264/AAC, full decode and manifest. Resume requires identical parameters and inputs.",
    {
      project,
      start: seconds.optional(),
      end: seconds.optional(),
      width: width.default(1920),
      fps: z.number().int().min(12).max(60).optional(),
      segmentSeconds: z.number().min(0.25).max(60).default(10),
      resume: jobId.optional(),
    },
    async ({ project: id, ...options }) =>
      jsonResult(await jobs.start(id, "export", options)),
    { write: true, openWorld: true },
  );
  register(
    "frame_narrate",
    "Synthesize project speech using Edge, OpenAI/compatible, Azure or a custom adapter. Provide either input (project-local JSON plan) or text (one-line audition), never both. Poll frame_job, then use frame_read_speech to hear audio; no automatic provider fallback or metadata rewriting.",
    {
      project,
      input: filePath.optional(),
      text: z.string().min(1).max(4096).optional(),
      provider: z.string().min(1).max(100).optional(),
      speaker: z.string().min(1).max(64).optional(),
      voice: z.string().min(1).max(200).optional(),
    },
    async ({ project: id, ...options }) => {
      if (Boolean(options.input) === (options.text !== undefined))
        fail("INVALID_ARGUMENT", "Provide exactly one of input or text");
      if (options.input) {
        if (options.provider || options.speaker || options.voice)
          fail(
            "INVALID_ARGUMENT",
            "Put provider, speaker and voice in the input plan",
          );
        workspace.file(id, options.input);
      }
      return jsonResult(await jobs.start(id, "narrate", options));
    },
    { write: true, openWorld: true },
  );
  register(
    "frame_speech_status",
    "Inspect per-project speech providers, speaker mappings and credential presence without contacting any speech service. Never returns secret values.",
    { project },
    ({ project: id }) => jsonResult(speechStatus(workspace, id)),
  );
  register(
    "frame_init_speech",
    "Create project speech configuration and a sample narration plan without overwriting existing files. Does not contact providers or incur synthesis charges.",
    {
      project,
      provider: z.enum(["edge", "openai", "azure", "custom"]).default("edge"),
      voice: z.string().min(1).max(200).optional(),
    },
    ({ project: id, ...options }) =>
      jsonResult(initSpeech(workspace, id, options)),
    { write: true },
  );
  register(
    "frame_list_voices",
    "List voices for a project's provider; Edge/Azure query the service, OpenAI returns a documented static list, custom compatible services define their own voices. Supports locale filter and pagination.",
    {
      project,
      provider: z.string().min(1).max(64).optional(),
      locale: z.string().min(2).max(32).optional(),
      limit: z.number().int().min(1).max(200).default(100),
      offset: z.number().int().nonnegative().default(0),
    },
    async ({ project: id, ...options }) =>
      jsonResult(await listSpeechVoices(workspace, id, options)),
    { openWorld: true },
  );
  register(
    "frame_read_speech",
    "Read a versioned narration bundle. inlineAudio=true returns native WAV audio (up to 6 MiB); only an audio-capable client can listen. Default returns metadata/download link, not a listening review.",
    {
      project,
      version: z.string().regex(/^[a-f0-9]{64}$/),
      name: z
        .enum(["voice.wav", "captions.srt", "timeline.json"])
        .default("voice.wav"),
      inlineAudio: z.boolean().default(false),
    },
    ({ project: id, version, ...options }) => {
      const { description, data } = readSpeech(workspace, id, version, options);
      if (data && options.name === "voice.wav")
        return {
          content: [
            {
              type: "audio",
              mimeType: "audio/wav",
              data: data.toString("base64"),
            },
          ],
          structuredContent: description,
        };
      return jsonResult({
        ...description,
        ...(data ? { content: data.toString("utf8") } : {}),
      });
    },
  );
  register(
    "frame_check_playback",
    "Validate cold seek readiness, timed playback, paused clock and reverse seek at 2x in an isolated project server. Does not assert artistic quality.",
    {
      project,
      start: seconds.default(0),
      duration: z.number().positive().max(3600).default(2),
    },
    async ({ project: id, ...options }) =>
      jsonResult(await jobs.start(id, "playback", options)),
    { write: true, openWorld: true },
  );
  register(
    "frame_check_project",
    "Return completed strict structure and Git scope reports, including categorized external changes with unknown authors. passed=false is a normal check result, not a tool error. Does not execute tests or assert visual/audio quality.",
    {
      project,
      base: z
        .string()
        .regex(/^[a-fA-F0-9]{7,40}$/)
        .optional(),
    },
    async ({ project: id, base }) =>
      jsonResult(await projectOperationAsync(workspace, "checkProject", id, { base })),
  );
  register(
    "frame_start_preview",
    "Start an asynchronous PNG frame/storyboard job. Poll frame_job; then frame_read_artifact returns an image to inspect. Executes trusted project code.",
    {
      project,
      mode: z.enum(["frame", "storyboard"]).default("storyboard"),
      time: seconds.optional(),
      times: z.array(seconds).min(1).max(48).optional(),
      width: width.default(640),
      subtitles: z.boolean().default(true),
    },
    async ({ project: id, mode, ...options }) => {
      if (
        (mode === "frame" && options.times !== undefined) ||
        (mode === "storyboard" && options.time !== undefined)
      )
        fail("INVALID_OPTIONS", "Use time for frame or times for storyboard.");
      return jsonResult(await jobs.start(id, mode, options));
    },
    { write: true, openWorld: true },
  );
  register(
    "frame_start_render",
    "Start a verified MP4 export using the existing renderer and audio mix. Requires Chromium, FFmpeg and FFprobe. Prefer a short clip before full export; poll frame_job.",
    {
      project,
      start: seconds.default(0),
      end: seconds.optional(),
      fps: z.number().int().min(12).max(60).optional(),
      width: width.default(1280),
      subtitles: z.boolean().default(true),
    },
    async ({ project: id, ...options }) =>
      jsonResult(await jobs.start(id, "render", options)),
    { write: true, openWorld: true },
  );
  register(
    "frame_job",
    "Read job state, bounded log, source-change status and artifact links. Use waitMs=20000 to wait for this session's running job and reduce repeated polling. Unknown-session jobs are unobserved, never assumed successful.",
    {
      project,
      jobId,
      waitMs: z.number().int().min(0).max(20000).default(0),
    },
    async ({ project: id, jobId, waitMs }) =>
      jsonResult(await jobs.wait(id, jobId, waitMs)),
  );
  register(
    "frame_cancel_job",
    "Cancel only a render process tree owned by this server session. Completed jobs are unchanged.",
    {
      project,
      jobId,
    },
    async ({ project: id, jobId }) => jsonResult(await jobs.cancel(id, jobId)),
    { write: true },
  );
  register(
    "frame_read_artifact",
    "Read a successful job artifact. PNG returns a bounded native image with dimensions/hashes; use presentation=image-only if the client drops mixed content, or metadata for download details. Files remain unchanged; returning an image is not proof the model inspected it.",
    {
      project,
      jobId,
      name: z.string().min(1).max(120),
      ...imageOptions,
    },
    async ({ project: id, jobId, name, presentation, maxWidth }) => {
      const { info, bytes } = await jobs.artifact(id, jobId, name, {
        maxImageBytes: 32 * 1024 * 1024,
      });
      if (info.mimeType === "image/png")
        return imageResult(bytes, info, { presentation, maxWidth });
      const result = jsonResult(info);
      if (info.mimeType === "application/json")
        result.content.push({ type: "text", text: bytes.toString("utf8") });
      else
        result.content.push({
          type: "resource_link",
          uri: info.uri,
          name: info.name,
          mimeType: info.mimeType,
          description:
            "Open the local path in the metadata; binary video is not embedded.",
        });
      return result;
    },
  );
  for (const [name, relative] of Object.entries(refs)) {
    server.registerResource(
      name,
      "frame://reference/" + name,
      { description: relative, mimeType: "text/plain" },
      (uri) => {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: reference(name).content,
            },
          ],
        };
      },
    );
  }
  server.registerResource(
    "artifact",
    new ResourceTemplate("frame://artifacts/{project}/{jobId}/{name}", {
      list: undefined,
    }),
    {
      description:
        "Successful job artifacts; video returns local file metadata.",
    },
    async (uri, variables) => {
      const { info, bytes } = await jobs.artifact(
        String(variables.project),
        String(variables.jobId),
        String(variables.name),
      );
      return {
        contents: [
          info.mimeType === "image/png"
            ? {
                uri: uri.href,
                mimeType: info.mimeType,
                blob: bytes.toString("base64"),
              }
            : {
                uri: uri.href,
                mimeType:
                  info.mimeType === "video/mp4"
                    ? "application/json"
                    : info.mimeType,
                text: bytes?.toString("utf8") ?? JSON.stringify(info),
              },
        ],
      };
    },
  );
  register("frame_help", "Discover available tools with bounded pagination; schemas are read separately with frame_tool_describe.", {
    query: z.string().max(100).default(""), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(30),
  }, ({ query, offset, limit }) => {
    const entries = [...catalog.values()].filter(tool => (tool.name + " " + tool.description).toLowerCase().includes(query.toLowerCase()));
    const tools = entries.slice(offset, offset + limit).map(({ inputSchema, ...tool }) => tool);
    return jsonResult({ schemaVersion: 1, tools, total: entries.length, nextOffset: offset + tools.length < entries.length ? offset + tools.length : null });
  });
  register("frame_tool_describe", "Read the exact input schema and side-effect annotations of an available tool.", { name: z.string().min(1).max(100) }, ({ name }) => {
    const tool = catalog.get(name.startsWith("frame_") ? name : "frame_" + name);
    if (!tool) fail("UNKNOWN_TOOL", "Use frame_help to discover available tools.");
    return jsonResult({ ...tool, inputSchema: z.toJSONSchema(tool.inputSchema, { unrepresentable: "any" }) });
  });
  register("frame_workspace_context", "Start here: local project identities, boundaries, creation defaults, references and tool discovery.", {}, () => {
    const listing = workspace.listProjects();
    return jsonResult({
      schemaVersion: 1, platformVersion: PLATFORM_VERSION, mode: "local", readOnly,
      projects: listing.projects.slice(0, 30), errors: listing.errors.slice(0, 30), total: listing.projects.length,
      moreProjects: listing.projects.length > 30, moreErrors: listing.errors.length > 30,
      allowedProjects: projects, defaults: projectDefaults, interfaces: authoringModes, references: referenceCatalog(),
      workflow: ["frame_project_context", "frame_read_file", "frame_edit_files / frame_patch_files", "frame_check_project", "frame_storyboard / frame_frame", "frame_job"],
      discovery: "frame_help lists available tools; frame_tool_describe returns one exact schema.",
    });
  });
  server.registerPrompt(
    "frame_edit_animation",
    {
      description:
        "A project-scoped, evidence-based animation editing workflow.",
      argsSchema: z.object({ project, request: z.string().min(1).max(8000) }),
    },
    ({ project: id, request }) => {
      workspace.project(id);
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                "Edit FRAME project " +
                id +
                ". Request: " +
                request +
                "\nRead frame_project_context and references first. Read source and hashes, then use a coherent frame_edit_files batch. Keep absolute-time rendering/audio and the project's visual identity unless redesign is requested. Run checks, inspect keyframe/storyboard PNGs, and render a short clip when timing/audio changes. Report separately: implemented, checked, visually/audio reviewed, exported. Keep process records inside this project's records/.",
            },
          },
        ],
      };
    },
  );
  return {
    server,
    workspace,
    jobs,
    assets,
    writeTools,
    close: async () => {
      await assets.close();
      await jobs.close();
    },
  };
}
