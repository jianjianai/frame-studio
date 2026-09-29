import { z } from "zod";

export const taskStateSchema = z.enum(["queued", "running", "cancelling", "cancelled", "publishing", "publish_failed", "failed", "succeeded"]);
export const executableTaskKindSchema = z.enum(["new", "validate", "frame", "storyboard", "render", "build", "agent", "tools-update"]);
// Speech auditions are persisted artifacts, not executable queue jobs.
export const taskKindSchema = z.enum([...executableTaskKindSchema.options, "speech-test"]);
export const taskStates = Object.freeze(taskStateSchema.options);
export const taskKinds = Object.freeze(taskKindSchema.options);
export const taskStateLabels = Object.freeze({
  queued: "等待开始", running: "正在制作", cancelling: "正在停止", cancelled: "已停止",
  publishing: "正在保存结果", publish_failed: "结果保存待恢复", failed: "需要处理", succeeded: "已完成",
});
/** @param {{state: string}} task */
export const isActiveTask = (task) => ["queued", "running", "cancelling", "publishing"].includes(task.state);
/** @param {{state: string}} task */
export const isCancellableTask = (task) => ["queued", "running", "cancelling"].includes(task.state);
/** @param {{state: string}} task */
export const hasLiveTaskEvents = (task) => ["running", "cancelling", "publishing"].includes(task.state);

const uuid = z.string().uuid();
export const reviewContextSchema = z.strictObject({
  time: z.number().min(0).max(3600).optional(),
  start: z.number().min(0).max(3600).optional(),
  end: z.number().min(0).max(3600).optional(),
  assets: z.array(uuid).max(20).optional(),
}).refine(a => (a.start === undefined && a.end === undefined) ||
  (a.start !== undefined && a.end !== undefined && a.end > a.start), "Invalid review range");
export const chatSubmissionShape = {
  prompt: z.string().trim().min(1).max(40000), requestKey: uuid.optional(), context: reviewContextSchema.optional(),
};
export const workChatCreateSchema = z.strictObject({
  id: uuid, connection: uuid.optional(), provider: z.enum(["codex", "claude"]).optional(),
  title: z.string().min(1).max(120).default("创作对话"),
}).refine(a => Boolean(a.connection) !== Boolean(a.provider), "Choose exactly one connection or legacy provider");
export const workChatSendSchema = z.strictObject({ id: uuid, chat: uuid, ...chatSubmissionShape });
export const taskSummarySchema = z.looseObject({ id: uuid, state: taskStateSchema, kind: taskKindSchema });
export const taskEventSchema = z.looseObject({
  id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  kind: z.string().min(1), data: z.unknown().optional(),
});
export const taskGetRequestSchema = z.strictObject({ id: uuid, after: z.number().int().nonnegative().default(0) });
export const taskGetResponseSchema = z.looseObject({ task: taskSummarySchema, events: z.array(taskEventSchema) });
export const operationContracts = Object.freeze({
  works_chat_create: { request: workChatCreateSchema, response: z.looseObject({ id: uuid, provider: z.enum(["codex", "claude"]), connection: uuid.nullable().optional() }) },
  works_chat_send: { request: workChatSendSchema, response: taskSummarySchema },
  task_get: { request: taskGetRequestSchema, response: taskGetResponseSchema },
});
/** @param {string} name */
export function operationContract(name) {
  return Object.hasOwn(operationContracts, name)
    ? operationContracts[/** @type {keyof typeof operationContracts} */ (name)] : undefined;
}
/** @param {string} name @param {unknown} value */
export function parseOperationResult(name, value) {
  return operationContract(name)?.response.parse(value) ?? value;
}
export const wireResponseSchema = z.looseObject({
  type: z.enum(["result", "update"]), id: z.string().min(1).max(80),
  result: z.unknown().optional(), error: z.string().optional(), status: z.number().int().optional(),
});
export const playerStateSchema = z.looseObject({
  type: z.literal("frame-player-state"), time: z.number().finite().nonnegative(),
  duration: z.number().positive().max(3600), fps: z.number().int().min(12).max(60),
  playing: z.boolean(), buffering: z.boolean(), rate: z.number().positive(),
  loop: z.boolean(), volume: z.number().min(0).max(4), muted: z.boolean(),
  selection: z.strictObject({ start: z.number().nonnegative().optional(), end: z.number().nonnegative().optional() }).optional(),
});
export const previewMessageSchema = z.discriminatedUnion("type", [
  playerStateSchema,
  z.looseObject({ type: z.literal("frame-preview-loading"), message: z.string().max(4000) }),
  z.looseObject({ type: z.literal("frame-preview-height"), height: z.number().positive().max(50000) }),
]);
export const playerCommandSchema = z.discriminatedUnion("command", [
  z.strictObject({ type: z.literal("frame-player-command"), command: z.literal("export") }),
  z.strictObject({ type: z.literal("frame-player-command"), command: z.literal("pause") }),
  z.strictObject({ type: z.literal("frame-player-command"), command: z.literal("seek"), time: z.number().finite().nonnegative() }),
]);
