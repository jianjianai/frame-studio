import { z } from "zod";
import {
  commitSchema,
  shotIdSchema,
  workResultRequestSchema,
  workResultResponseSchema,
  workUndoRequestSchema,
  workUndoResponseSchema,
} from "./workflow.mjs";
import { modelIdSchema } from "./ai-models.mjs";

export const taskStateSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "publishing",
  "publish_failed",
  "failed",
  "succeeded",
]);
export const executableTaskKindSchema = z.enum([
  "new",
  "validate",
  "frame",
  "storyboard",
  "render",
  "build",
  "agent",
  "tools-update",
]);
// Speech auditions are persisted artifacts, not executable queue jobs.
export const taskKindSchema = z.enum([
  ...executableTaskKindSchema.options,
  "speech-test",
]);
export const taskStates = Object.freeze(taskStateSchema.options);
export const taskKinds = Object.freeze(taskKindSchema.options);
export const taskStateLabels = Object.freeze({
  queued: "等待开始",
  running: "正在制作",
  cancelling: "正在停止",
  cancelled: "已停止",
  publishing: "正在保存结果",
  publish_failed: "结果保存待恢复",
  failed: "需要处理",
  succeeded: "已完成",
});
/** @param {{state: string}} task */
export const isActiveTask = (task) =>
  ["queued", "running", "cancelling", "publishing"].includes(task.state);
/** @param {{state: string}} task */
export const isCancellableTask = (task) =>
  ["queued", "running", "cancelling"].includes(task.state);
/** @param {{state: string}} task */
export const hasLiveTaskEvents = (task) =>
  ["running", "cancelling", "publishing"].includes(task.state);

const uuid = z.string().uuid();
export const reviewContextSchema = z
  .strictObject({
    time: z.number().min(0).max(3600).optional(),
    start: z.number().min(0).max(3600).optional(),
    end: z.number().min(0).max(3600).optional(),
    assets: z.array(uuid).max(20).optional(),
    previewTask: uuid.optional(),
    sourceCommit: commitSchema.optional(),
    shotId: shotIdSchema.optional(),
  })
  .refine(
    (a) =>
      (a.start === undefined && a.end === undefined) ||
      (a.start !== undefined && a.end !== undefined && a.end > a.start),
    "Invalid review range",
  );
export const chatSubmissionShape = {
  prompt: z.string().trim().min(1).max(40000),
  requestKey: uuid.optional(),
  context: reviewContextSchema.optional(),
  model: modelIdSchema.optional(),
};
export const workChatCreateSchema = z
  .strictObject({
    id: uuid,
    connection: uuid.optional(),
    provider: z.enum(["codex", "claude"]).optional(),
    title: z.string().min(1).max(120).default("创作对话"),
  })
  .refine(
    (a) => Boolean(a.connection) !== Boolean(a.provider),
    "Choose exactly one connection or legacy provider",
  );
export const workChatSendSchema = z.strictObject({
  id: uuid,
  chat: uuid,
  ...chatSubmissionShape,
});
export const taskSummarySchema = z.looseObject({
  id: uuid,
  state: taskStateSchema,
  kind: taskKindSchema,
});
export const taskEventSchema = z.looseObject({
  id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  kind: z.string().min(1),
  data: z.unknown().optional(),
});
export const taskGetRequestSchema = z.strictObject({
  id: uuid,
  after: z.number().int().nonnegative().default(0),
});
export const taskGetResponseSchema = z.looseObject({
  task: taskSummarySchema,
  events: z.array(taskEventSchema),
  hasMore: z.boolean().optional(),
});
// Core operations use these exact contracts on both sides of every transport.
export const workIdRequestSchema = z.strictObject({ id: uuid });
export const workPreviewRequestSchema = workIdRequestSchema.extend({
  refresh: z.boolean().default(false),
});
export const workSyncStatusRequestSchema = workIdRequestSchema.extend({
  fetch: z.boolean().default(false),
});
export const workVersionsRequestSchema = workIdRequestSchema.extend({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});
export const workVersionRequestSchema = workIdRequestSchema.extend({
  version: commitSchema,
});
export const workRestoreRequestSchema = workIdRequestSchema.extend({
  version: z.union([uuid, commitSchema]),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const workChatTurnsRequestSchema = workIdRequestSchema.extend({
  chat: uuid,
  before: uuid.optional(),
  limit: z.number().int().min(1).max(100).default(30),
});
export const taskInputSchema = z
  .strictObject({
    title: z.string().max(150).optional(),
    renderer: z.enum(["canvas", "pixi", "three"]).optional(),
    duration: z.number().positive().max(3600).optional(),
    time: z.number().nonnegative().max(3600).optional(),
    width: z.number().int().min(2).max(3840).multipleOf(2).optional(),
    fps: z.number().int().min(1).max(120).optional(),
    subtitles: z.boolean().optional(),
    start: z.number().nonnegative().max(3600).optional(),
    end: z.number().positive().max(3600).optional(),
  })
  .refine(
    (value) =>
      value.start === undefined ||
      value.end === undefined ||
      value.end > value.start,
    "Invalid render range",
  );
export const workTaskRequestSchema = workIdRequestSchema.extend({
  kind: z.enum(["validate", "frame", "storyboard", "render", "build"]),
  input: taskInputSchema.default({}),
  requestKey: uuid.optional(),
});
export const workSummarySchema = z.looseObject({
  id: uuid,
  repo: uuid,
  project: z.string().min(1),
  title: z.string(),
});
const timestampSchema = z.union([z.string(), z.date()]);
const previewStatusSchema = z.looseObject({
  runtimeFingerprint: z.string(),
  sourceRevision: z.string().nullable(),
  previewRevision: z.string().nullable(),
  indexedAt: timestampSchema.nullable(),
  indexingRequired: z.boolean(),
  stale: z.boolean(),
  latest: taskSummarySchema.nullable(),
});
const connectionSummarySchema = z.looseObject({
  id: uuid,
  name: z.string(),
  tool: z.enum(["codex", "claude"]),
  mode: z.enum(["api", "official"]),
  model: z.string(),
  configured: z.boolean(),
});
export const operationContracts = Object.freeze({
  works_open: { request: workIdRequestSchema, response: workSummarySchema },
  works_tasks: {
    request: workIdRequestSchema,
    response: z.array(taskSummarySchema),
  },
  works_queue_status: {
    request: workIdRequestSchema,
    response: z.strictObject({
      now: z.string(),
      controllerReady: z.boolean(),
      concurrency: z.number().int().positive(),
      items: z.array(
        z.looseObject({
          id: uuid,
          code: z.string(),
          reason: z.string(),
          queuedMs: z.number().nonnegative(),
        }),
      ),
    }),
  },
  works_task: { request: workTaskRequestSchema, response: taskSummarySchema },
  works_preview_status: {
    request: workPreviewRequestSchema,
    response: previewStatusSchema,
  },
  works_chat_turns: {
    request: workChatTurnsRequestSchema,
    response: z.array(taskSummarySchema),
  },
  works_exports: {
    request: workIdRequestSchema,
    response: z.array(z.looseObject({ id: uuid, state: taskStateSchema })),
  },
  works_versions: {
    request: workVersionsRequestSchema,
    response: z.array(z.looseObject({ id: z.string(), kind: z.string() })),
  },
  works_version_compare: {
    request: workVersionRequestSchema,
    response: z.looseObject({
      version: commitSchema,
      current: commitSchema,
      files: z.array(z.looseObject({ path: z.string(), status: z.string() })),
      total: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
  },
  works_version_preview: {
    request: workVersionRequestSchema,
    response: taskSummarySchema,
  },
  works_restore: {
    request: workRestoreRequestSchema,
    response: workSummarySchema,
  },
  works_sync_status: {
    request: workSyncStatusRequestSchema,
    response: z.looseObject({}),
  },
  task_cancel: { request: workIdRequestSchema, response: taskSummarySchema },
  task_retry_publish: {
    request: workIdRequestSchema,
    response: taskSummarySchema,
  },
  connections_list: {
    request: z.strictObject({}),
    response: z.array(connectionSummarySchema),
  },
  works_result: {
    request: workResultRequestSchema,
    response: workResultResponseSchema,
  },
  works_undo: {
    request: workUndoRequestSchema,
    response: workUndoResponseSchema,
  },
  works_chat_create: {
    request: workChatCreateSchema,
    response: z.looseObject({
      id: uuid,
      provider: z.enum(["codex", "claude"]),
      connection: uuid.nullable().optional(),
    }),
  },
  works_chat_send: { request: workChatSendSchema, response: taskSummarySchema },
  task_get: { request: taskGetRequestSchema, response: taskGetResponseSchema },
});
/** @param {string} name */
export function operationContract(name) {
  return Object.hasOwn(operationContracts, name)
    ? operationContracts[/** @type {keyof typeof operationContracts} */ (name)]
    : undefined;
}
/** @param {string} name @param {unknown} value */
export function parseOperationResult(name, value) {
  return operationContract(name)?.response.parse(value) ?? value;
}
export const wireResponseSchema = z.looseObject({
  type: z.enum(["result", "update"]),
  id: z.string().min(1).max(80),
  result: z.unknown().optional(),
  error: z.string().optional(),
  status: z.number().int().optional(),
});
export const playerStateSchema = z.looseObject({
  type: z.literal("frame-player-state"),
  time: z.number().finite().nonnegative(),
  duration: z.number().positive().max(3600),
  fps: z.number().int().min(12).max(60),
  playing: z.boolean(),
  buffering: z.boolean(),
  rate: z.number().positive(),
  loop: z.boolean(),
  volume: z.number().min(0).max(4),
  muted: z.boolean(),
  shotId: shotIdSchema.optional(),
  selection: z
    .strictObject({
      start: z.number().nonnegative().optional(),
      end: z.number().nonnegative().optional(),
    })
    .optional(),
});
export const playerViewSchema = z.strictObject({
  timelineVisible: z.boolean().optional(),
  videoRatio: z.number().finite().min(25).max(85).optional(),
  quality: z.enum(["draft", "standard", "high"]).optional(),
});
export const playerExportStateSchema = z.object({
  type: z.literal("frame-export-state"),
  id: z.string().min(1).max(80),
  state: z.enum([
    "queued",
    "running",
    "cancelling",
    "cancelled",
    "succeeded",
    "failed",
  ]),
  progress: z
    .object({
      phase: z.enum(["preparing", "rendering", "finalizing"]).optional(),
      stage: z.string().max(100).optional(),
      completed: z.number().finite().nonnegative().optional(),
      total: z.number().finite().nonnegative().optional(),
    })
    .optional(),
  error: z.string().max(6000).optional(),
  filename: z.string().max(500).optional(),
  bytes: z.number().int().nonnegative().optional(),
  blob: z.unknown().optional(),
});
export const previewMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frame-player-ready") }),
  z.object({
    type: z.literal("frame-player-preferences"),
    preferences: playerViewSchema,
  }),
  z.object({
    type: z.literal("frame-download-error"),
    message: z.string().max(4000),
  }),
  z.strictObject({ type: z.literal("frame-preview-update-request") }),
  playerStateSchema,
  z.looseObject({
    type: z.literal("frame-preview-loading"),
    message: z.string().max(4000),
  }),
  z.looseObject({
    type: z.literal("frame-preview-height"),
    height: z.number().positive().max(50000),
  }),
]);
export const workContextSchema = z.strictObject({
  title: z.string().max(400),
  compact: z.boolean(),
  previewStatus: z.enum(["ready", "stale", "building", "unknown"]),
  updateDisabled: z.boolean(),
});
const playerType = z.literal("frame-player-command");
export const playerCommandSchema = z.discriminatedUnion("command", [
  z.strictObject({
    type: playerType,
    command: z.literal("configure-work"),
    context: workContextSchema,
  }),
  z.strictObject({ type: playerType, command: z.literal("export") }),
  z.strictObject({ type: playerType, command: z.literal("pause") }),
  z.strictObject({
    type: playerType,
    command: z.literal("play"),
    end: z.number().finite().positive().max(3600).optional(),
  }),
  z.strictObject({ type: playerType, command: z.literal("export-cancel") }),
  z.strictObject({ type: playerType, command: z.literal("export-download") }),
  z.strictObject({ type: playerType, command: z.literal("snapshot") }),
  z.strictObject({ type: playerType, command: z.literal("subtitles") }),
  z.strictObject({
    type: playerType,
    command: z.literal("seek"),
    time: z.number().finite().nonnegative(),
    selection: z
      .strictObject({
        start: z.number().finite().nonnegative(),
        end: z.number().finite().nonnegative(),
      })
      .optional(),
  }),
  z.strictObject({
    type: playerType,
    command: z.literal("configure-view"),
    preferences: playerViewSchema,
  }),
  z.strictObject({
    type: playerType,
    command: z.literal("export-start"),
    id: z.string().min(1).max(80),
    options: z.strictObject({
      width: z.number().int().min(2).max(3840).multipleOf(2),
      fps: z.number().int().min(1).max(120),
      subtitles: z.boolean(),
      start: z.number().finite().nonnegative().optional(),
      end: z.number().finite().positive().optional(),
    }),
  }),
]);
