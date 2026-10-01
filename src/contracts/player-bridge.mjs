import { previewMessageSchema, playerExportStateSchema } from "./platform.mjs";

/** Callers must verify the exact iframe WindowProxy before decoding. Sandbox origins are intentionally opaque. @param {unknown} value */
export function decodePlayerMessage(value) {
  const result = previewMessageSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** @param {unknown} value @param {string} requestId */
export function decodeExportMessage(value, requestId) {
  const result = playerExportStateSchema.safeParse(value);
  return result.success && result.data.id === requestId ? result.data : null;
}

/** Coordinates are attached to the applied live revision or immutable preview the user actually saw. @param {{time?: number, selection?: {start?: number, end?: number}, shotId?: string}} position @param {{previewTask?: string, sourceCommit?: string, liveSessionId?: string, sourceRevision?: string, draftTask?: string}} reference @param {boolean} [range] */
export function positionReference(position, reference, range = false) {
  const selection = position.selection;
  const coordinates =
    range &&
    typeof selection?.start === "number" &&
    typeof selection.end === "number" &&
    selection.end > selection.start
      ? { start: selection.start, end: selection.end }
      : { time: position.time || 0 };
  return {
    ...coordinates,
    ...reference,
    ...(position.shotId ? { shotId: position.shotId } : {}),
  };
}
