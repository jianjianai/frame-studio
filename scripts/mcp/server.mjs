import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { validProjectId } from "../project-metadata.mjs";
import { FrameError, fail, safePath } from "./workspace.mjs";
import { ProjectService as Workspace } from "../project-service.mjs";
import { Jobs } from "./jobs.mjs";
import { compareReviews, recordReview } from "../production-media.mjs";
import { runProcess } from "../project-execution.mjs";
import { inspectProjectScope } from "../project-scope-report.mjs";
import { imageResult } from "./image-result.mjs";

const project = z.string().refine(validProjectId, "Invalid project id");
const filePath = z.string().min(1).max(512);
const jobId = z.string().uuid();
const width = z.number().int().min(320).max(3840).multipleOf(32);
const seconds = z.number().finite().nonnegative();
const imageOptions = {
  presentation: z.enum(["native", "image-only", "metadata"]).default("native"),
  maxWidth: z.number().int().min(320).max(2048).default(1600),
};
const refs = {
  rules: "AGENTS.md",
  standard: "docs/NEW-PROJECT-STANDARD.md",
  authoring: "docs/AUTHORING.md",
  workflow: "docs/AI-WORKFLOW.md",
  production: "docs/AI-PRODUCTION.md",
  audio: "docs/AUDIO.md",
  "scene-types": "src/engine/types.ts",
  mcp: "docs/MCP.md",
};
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
  decorateResult = (value) => value,
}) {
  const workspace = new Workspace(root, {
    projects,
    readOnly,
    sessionId: jobManager?.workspace.sessionId,
  });
  const jobs = jobManager ?? new Jobs(workspace, { timeoutMs });
  const writeTools = new Set();
  const reference = (name) => {
    const file = safePath(workspace.root, refs[name]);
    if (fs.statSync(file).size > 1024 * 1024)
      fail("TOO_LARGE", "Reference exceeds 1 MiB.");
    return {
      name,
      uri: "frame://reference/" + name,
      path: refs[name],
      content: fs.readFileSync(file, "utf8"),
    };
  };
  const server = new McpServer(
    { name: "frame-animation", version: "1.0.0" },
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
    server.registerTool(
      name,
      {
        description,
        inputSchema: z.strictObject(shape),
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
              error: {
                code:
                  error instanceof FrameError ? error.code : "OPERATION_FAILED",
                message: error.message,
                ...(error.details ? { details: error.details } : {}),
              },
            },
            true,
          );
        }
      },
    );
  };
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
    { project },
    ({ project: id }) =>
      jsonResult({
        ...workspace.context(id),
        activeOperation: jobs.operation(id),
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
    ({ project: id, ...options }) =>
      jsonResult(workspace.listFiles(id, options)),
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
    ({ project: id, ...options }) => jsonResult(workspace.search(id, options)),
  );
  register(
    "frame_patch_files",
    "Apply exact text replacements to hashed files. Match count must agree. Creates a checkpoint; strict validation failure rolls back.",
    {
      project,
      changes: z
        .array(
          z.strictObject({
            path: filePath,
            expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
            replacements: z
              .array(
                z.strictObject({
                  find: z.string().min(1),
                  replace: z.string(),
                  count: z.number().int().min(1).max(1000).optional(),
                }),
              )
              .min(1)
              .max(50),
          }),
        )
        .min(1)
        .max(20),
      dryRun: z.boolean().default(false),
    },
    ({ project: id, changes, dryRun }) =>
      jsonResult(workspace.patch(id, changes, { dryRun })),
    { write: true, destructive: true },
  );
  register(
    "frame_checkpoint",
    "Save the current editable project text as a recoverable checkpoint.",
    { project, label: z.string().max(200).optional() },
    ({ project: id, label }) => jsonResult(workspace.checkpoint(id, label)),
    { write: true },
  );
  register(
    "frame_history",
    "List checkpoints and current input fingerprint, including binary assets.",
    { project },
    ({ project: id }) => jsonResult(workspace.history(id)),
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
    ({ project: id, checkpoint, expectedFingerprint, dryRun }) =>
      jsonResult(
        workspace.restore(id, checkpoint, expectedFingerprint, dryRun),
      ),
    { write: true, destructive: true },
  );
  register(
    "frame_edit_files",
    "Batch create/replace/delete text files inside one project. Pass the last full-file SHA-256; null means new file. content:null deletes. Strict validation failure rolls back the batch. dryRun checks paths/hashes only.",
    {
      project,
      changes: z
        .array(
          z.strictObject({
            path: filePath,
            expectedSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
            content: z.string().max(1048576).nullable(),
          }),
        )
        .min(1)
        .max(20),
      dryRun: z.boolean().default(false),
    },
    ({ project: id, changes, dryRun }) =>
      jsonResult(workspace.edit(id, changes, { dryRun })),
    { write: true, destructive: true },
  );
  register(
    "frame_create_project",
    "Create a complete animation with the existing scaffold; never overwrite. Read the returned project context before editing.",
    {
      project,
      title: z.string().trim().min(1).max(200),
      renderer: z.enum(["canvas", "pixi", "three"]).default("canvas"),
      duration: z.number().finite().positive().max(3600).default(12),
      fps: z.number().int().min(12).max(60).default(30),
      audio: z.enum(["silent", "generated"]).default("silent"),
    },
    ({ project: id, title, renderer, duration, fps, audio }) => {
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
          title,
          "--renderer",
          renderer,
          "--duration",
          String(duration),
          "--fps",
          String(fps),
          "--audio",
          audio,
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
    ({ project: id, action }) => jsonResult(jobs.start(id, action, {})),
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
    ({ project: id, ...options }) =>
      jsonResult(jobs.start(id, "review", options)),
    { write: true, openWorld: true },
  );
  register(
    "frame_verify_delivery",
    "Fully decode and count frames of an existing project media file, analyze audio, extract final frames and check input provenance asynchronously.",
    { project, path: filePath },
    ({ project: id, path }) => {
      workspace.file(id, path);
      return jsonResult(
        jobs.start(id, "verify", { file: "projects/" + id + "/" + path }),
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
    ({ project: id, ...options }) =>
      jsonResult(jobs.start(id, "export", options)),
    { write: true, openWorld: true },
  );
  register(
    "frame_narrate",
    "Build content-keyed sentence audio, measured subtitles and timeline from a project-local JSON plan. Provider calls occur only if that plan explicitly configures a local provider module.",
    { project, input: filePath },
    ({ project: id, input }) => {
      workspace.file(id, input);
      return jsonResult(jobs.start(id, "narrate", { input }));
    },
    { write: true, openWorld: true },
  );
  register(
    "frame_check_playback",
    "Validate cold seek readiness, timed playback, paused clock and reverse seek at 2x in an isolated project server. Does not assert artistic quality.",
    {
      project,
      start: seconds.default(0),
      duration: z.number().positive().max(3600).default(2),
    },
    ({ project: id, ...options }) =>
      jsonResult(jobs.start(id, "playback", options)),
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
    ({ project: id, base }) => {
      const structure = workspace.check(id);
      let scope;
      try {
        scope = inspectProjectScope(workspace.root, id, { base });
      } catch (error) {
        fail("SCOPE_CHECK_FAILED", "Git scope inspection could not run.", {
          structure,
          reason: error.message,
        });
      }
      return jsonResult({
        status: "completed",
        passed: structure.passed && scope.passed,
        projectPassed: structure.passed,
        scopeVerified: scope.passed,
        structure,
        scope,
        nextAction: !structure.passed
          ? "Fix the structural errors before rendering."
          : scope.nextAction,
      });
    },
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
    ({ project: id, mode, ...options }) => {
      if (
        (mode === "frame" && options.times !== undefined) ||
        (mode === "storyboard" && options.time !== undefined)
      )
        fail("INVALID_OPTIONS", "Use time for frame or times for storyboard.");
      return jsonResult(jobs.start(id, mode, options));
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
    ({ project: id, ...options }) =>
      jsonResult(jobs.start(id, "render", options)),
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
      const { info, bytes } = jobs.artifact(id, jobId, name, {
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
    (uri, variables) => {
      const { info, bytes } = jobs.artifact(
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
  return { server, workspace, jobs, writeTools, close: () => jobs.close() };
}
