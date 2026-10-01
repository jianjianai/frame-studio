import { z } from "zod";

const identifier = z.string().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const FrameBootstrapSchema = z.strictObject({
  version: z.literal(1),
  workId: z.uuid(),
  userScope: z.string().regex(/^[A-Za-z0-9_-]{12,128}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{24,128}$/),
  basePath: z.string(),
  parentOrigin: z.url(),
  serverId: identifier,
  workspaceId: z.string().min(1).max(4096),
  label: z.string().min(1).max(160),
});
export type FrameBootstrap = z.infer<typeof FrameBootstrapSchema>;

export const FrameReviewContextSchema = z
  .strictObject({
    time: z.number().finite().min(0).max(3600).optional(),
    start: z.number().finite().min(0).max(3600).optional(),
    end: z.number().finite().min(0).max(3600).optional(),
    shotId: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/)
      .optional(),
    assets: z.array(z.uuid()).max(20).optional(),
    previewTask: z.uuid().optional(),
    sourceCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    liveSessionId: z.uuid().optional(),
    sourceRevision: sha256.optional(),
    draftTask: z.uuid().optional(),
  })
  .superRefine((value, context) => {
    const noRange = value.start === undefined && value.end === undefined;
    const completeRange =
      value.start !== undefined && value.end !== undefined && value.end > value.start;
    if (!noRange && !completeRange) {
      context.addIssue({ code: "custom", message: "The range end must follow its start." });
    }
    if (value.liveSessionId !== undefined && value.sourceRevision === undefined) {
      context.addIssue({ code: "custom", message: "A live reference needs its source revision." });
    }
    if (value.sourceRevision !== undefined && value.liveSessionId === undefined) {
      context.addIssue({ code: "custom", message: "A source revision needs its live session." });
    }
    if (
      value.liveSessionId !== undefined &&
      (value.previewTask !== undefined || value.sourceCommit !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A live reference cannot mix snapshot identifiers.",
      });
    }
    if (value.draftTask !== undefined && value.liveSessionId === undefined) {
      context.addIssue({ code: "custom", message: "A draft reference needs its live session." });
    }
  });
export type FrameReviewContext = z.infer<typeof FrameReviewContextSchema>;

export const FrameTextAttachmentSchema = z.strictObject({
  type: z.literal("text"),
  mimeType: z.literal("text/plain"),
  title: z.string().nullable().optional(),
  text: z.string().max(2_000_000),
});
export type FrameTextAttachment = z.infer<typeof FrameTextAttachmentSchema>;

export const FrameFreezeInputSchema = z.strictObject({
  agentId: identifier,
  messageId: z.uuid(),
  prompt: z.string().max(2_000_000),
  profileId: identifier.nullable(),
  model: identifier.nullable(),
  context: FrameReviewContextSchema,
  activeTurnBehavior: z.enum(["steer", "interrupt"]).optional(),
  attachmentsFingerprint: sha256,
});
export type FrameFreezeInput = z.infer<typeof FrameFreezeInputSchema>;

export const FrameFreezeResponseSchema = z.strictObject({
  version: z.literal(1),
  workId: z.uuid(),
  agentId: identifier,
  messageId: z.uuid(),
  intentHash: sha256,
  context: FrameReviewContextSchema,
  reviewReference: z.strictObject({
    status: z.enum(["versioned", "unversioned"]),
    paseoAgent: z.string().min(1).max(256).optional(),
    mode: z.literal("live").optional(),
    sourceRevision: sha256.optional(),
    sourceCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    liveSessionId: z.uuid().optional(),
    draftTask: z.uuid().optional(),
    fingerprint: sha256.optional(),
    shotId: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/)
      .optional(),
  }),
  attachment: FrameTextAttachmentSchema.optional(),
});
export type FrameFreezeResponse = z.infer<typeof FrameFreezeResponseSchema>;

export const FrameOperationSchema = z.enum([
  "context.read",
  "context.subscribe",
  "context.attach",
  "freeze.submit",
  "message.accepted",
  "preview.open",
  "results.open",
  "dock.close",
]);
export type FrameOperation = z.infer<typeof FrameOperationSchema>;
export const FrameConnectSchema = z.strictObject({
  type: z.literal("frame-paseo-connect"),
  version: z.literal(1),
  workId: z.uuid(),
  nonce: z.string().min(24).max(128),
});
export const FramePortRequestSchema = z.strictObject({
  type: z.literal("request"),
  id: z.uuid(),
  op: FrameOperationSchema,
  payload: z.unknown(),
});
export type FramePortRequest = z.infer<typeof FramePortRequestSchema>;
export const FramePortMessageSchema = z.union([
  z.strictObject({
    type: z.literal("connected"),
    version: z.literal(1),
    workId: z.uuid(),
    nonce: z.string(),
  }),
  z.strictObject({
    type: z.literal("response"),
    id: z.uuid(),
    ok: z.literal(true),
    payload: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("response"),
    id: z.uuid(),
    ok: z.literal(false),
    error: z.strictObject({ code: identifier, message: z.string().max(4096) }),
  }),
  z.strictObject({
    type: z.literal("event"),
    event: z.enum(["context.changed", "context.attach", "disposed"]),
    payload: z.unknown(),
  }),
]);
export const FrameContextAttachmentSchema = z.strictObject({
  id: identifier,
  identifier,
  title: z.string().min(1).max(512),
  subtitle: z.string().optional(),
  url: z.url(),
  text: z.string().max(2_000_000),
  resourceType: identifier,
});

export type FrameContextAttachment = z.infer<typeof FrameContextAttachmentSchema>;
export const FrameContextAttachmentEventSchema = z.strictObject({
  agentId: identifier,
  item: FrameContextAttachmentSchema,
});
