import { z } from "zod";
import { FrameReviewContextSchema, frameReviewUrl } from "../integrations/paseo/frame-plugin/shared/bridge.mjs";

const parameter = "frameReference";
const LinkSchema = z.strictObject({ version: z.literal(1), workId: z.uuid(), context: FrameReviewContextSchema });

/** Native Paseo persists this URL with its sent resource attachment. */
export function paseoReferenceUrl(workId, context, base) {
  return frameReviewUrl(workId, context, base);
}

export function readPaseoReference(url, workId) {
  const encoded = new URL(url).searchParams.get(parameter);
  if (encoded === null) return null;
  try {
    if (encoded.length > 4096) throw Error("Oversized reference");
    const value = LinkSchema.parse(JSON.parse(encoded));
    if (value.context.time === undefined && value.context.start === undefined) throw Error("Missing recorded position");
    // A reference query can remain while the user navigates to another work.
    return value.workId === workId ? value.context : null;
  } catch { throw Error("对话中的画面引用链接已损坏，无法定位。"); }
}

/** Compare the player's applied provenance, never a pending source update. */
export function paseoReferenceMatch(reference, current = {}) {
  if (reference.sourceRevision) {
    if (!current.sourceRevision) return current.sourceCommit ? "changed" : "pending";
    if (reference.sourceRevision !== current.sourceRevision) return "changed";
    if (reference.compiledRevision && !current.compiledRevision) return "pending";
    if (reference.compiledRevision && reference.compiledRevision !== current.compiledRevision) return "changed";
    return "matched";
  }
  if (reference.sourceCommit) return !current.sourceCommit ? current.sourceRevision ? "changed" : "pending" : reference.sourceCommit === current.sourceCommit ? "matched" : "changed";
  return "unversioned";
}

export function paseoReferencePosition(context) {
  return { time: context.start ?? context.time ?? 0,
    ...(context.start !== undefined ? { selection: { start: context.start, end: context.end } } : {}) };
}

export function paseoReferenceLabel(context) {
  return context.start !== undefined
    ? `${context.start.toFixed(2)}–${context.end.toFixed(2)} 秒`
    : `${(context.time ?? 0).toFixed(2)} 秒`;
}
