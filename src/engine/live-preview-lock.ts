/** Editing revisions wait while a browser export reads its frozen source and resource URLs. */
export function previewSnapshotBusy(): boolean {
  return typeof window !== "undefined" && (window.__FRAME_PREVIEW_READERS__ ?? 0) > 0;
}
export function beginPreviewSnapshot(): () => void {
  if (typeof window === "undefined") return () => {};
  window.__FRAME_PREVIEW_READERS__ = (window.__FRAME_PREVIEW_READERS__ ?? 0) + 1;
  window.dispatchEvent(new Event("frame-preview-readers"));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    window.__FRAME_PREVIEW_READERS__ = Math.max(0, (window.__FRAME_PREVIEW_READERS__ ?? 1) - 1);
    window.dispatchEvent(new Event("frame-preview-readers"));
  };
}
declare global { interface Window { __FRAME_PREVIEW_READERS__?: number; } }
