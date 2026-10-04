import {
  frameReviewUrl,
  readFrameReviewUrl,
} from "../integrations/t3-code/shared/bridge.mjs";

/** Native T3 Code persists this URL with its sent resource attachment. */
export function aiReferenceUrl(workId, context, base) {
  return frameReviewUrl(workId, context, base);
}

export function readAiReference(url, workId) {
  try {
    return readFrameReviewUrl(url, workId);
  } catch {
    throw Error("对话中的画面引用链接已损坏，无法定位。");
  }
}

/** Compare the player's applied provenance, never a pending source update. */
export function aiReferenceMatch(reference, current = {}) {
  if (reference.sourceRevision) {
    if (!current.sourceRevision)
      return current.sourceCommit ? "changed" : "pending";
    if (reference.sourceRevision !== current.sourceRevision) return "changed";
    if (reference.compiledRevision && !current.compiledRevision)
      return "pending";
    if (
      reference.compiledRevision &&
      reference.compiledRevision !== current.compiledRevision
    )
      return "changed";
    return "matched";
  }
  if (reference.sourceCommit)
    return !current.sourceCommit
      ? current.sourceRevision
        ? "changed"
        : "pending"
      : reference.sourceCommit === current.sourceCommit
        ? "matched"
        : "changed";
  return "unversioned";
}

export function aiReferencePosition(context) {
  return {
    time: context.start ?? context.time ?? 0,
    ...(context.start !== undefined
      ? { selection: { start: context.start, end: context.end } }
      : {}),
  };
}

export function aiReferenceLabel(context) {
  return context.start !== undefined
    ? `${context.start.toFixed(2)}–${context.end.toFixed(2)} 秒`
    : `${(context.time ?? 0).toFixed(2)} 秒`;
}
