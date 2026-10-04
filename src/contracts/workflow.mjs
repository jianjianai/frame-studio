import { z } from "zod";

export const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const shotIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/);
const uuid = z.string().uuid();
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
