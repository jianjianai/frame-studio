import { z } from "zod";

export const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const shotIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/);
const uuid = z.string().uuid();
export const workResultRequestSchema = z.strictObject({ id: uuid, task: uuid });
export const workUndoRequestSchema = z.strictObject({
  id: uuid,
  task: uuid,
  requestKey: uuid,
  expectedCommit: commitSchema,
  expectedRevision: revisionSchema,
});
export const reviewReferenceSchema = z.looseObject({
  status: z.enum(["versioned", "unversioned"]),
  previewTask: uuid.optional(),
  sourceCommit: commitSchema.optional(),
  fingerprint: revisionSchema.nullable().optional(),
  runtimeFingerprint: revisionSchema.nullable().optional(),
  disposition: z
    .enum(["current", "compare-to-latest", "unversioned"])
    .optional(),
  executionCommit: commitSchema.nullable().optional(),
  shotId: shotIdSchema.optional(),
});
export const executionSelectionSchema = z.looseObject({
  schema: z.literal(1),
  provider: z.enum(["codex", "claude"]),
  connection: uuid.nullable(),
  connectionName: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  authMode: z.enum(["api", "official"]),
  sessionKey: revisionSchema,
  selectedAt: z.string(),
});
export const validationRecordSchema = z.strictObject({
  check: z.enum(["scope", "structure", "project-tests", "preview-build"]),
  status: z.enum(["passed", "failed"]),
  durationMs: z.number().finite().nonnegative(),
});
export const workResultResponseSchema = z.looseObject({
  task: uuid,
  state: z.string(),
  before: commitSchema.nullable(),
  after: commitSchema.nullable(),
  current: commitSchema.nullable(),
  changes: z.array(z.strictObject({ status: z.string(), path: z.string() })),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  validation: z.array(validationRecordSchema),
  undo: z.looseObject({
    available: z.boolean(),
    reason: z.string().nullable(),
    expectedCommit: commitSchema.nullable(),
    expectedRevision: revisionSchema.nullable(),
  }),
});
export const workUndoResponseSchema = z.strictObject({
  id: uuid,
  work: uuid,
  task: uuid,
  state: z.literal("succeeded"),
  commit: commitSchema,
  previewTask: uuid.nullable().optional(),
});

/** A range is a user's review request, not a claim about the exact visual impact of a diff. */
/** @param {{start?: number, end?: number, time?: number} | null | undefined} context */
export function reviewRange(context) {
  if (!context) return null;
  if (
    typeof context.start === "number" &&
    typeof context.end === "number" &&
    Number.isFinite(context.start) &&
    Number.isFinite(context.end) &&
    context.end > context.start
  )
    return { start: context.start, end: context.end };
  if (Number.isFinite(context.time)) return { time: context.time };
  return null;
}
