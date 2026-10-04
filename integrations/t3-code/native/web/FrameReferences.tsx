import { useSyncExternalStore } from "react";
import { readFrameReferences, removeFrameReference, requestFrame, subscribeFrameReferences } from "./frameHost";
export function FrameReferences({ threadId }: { threadId: string }) {
  const items = useSyncExternalStore(subscribeFrameReferences, () => readFrameReferences(threadId));
  if (items.length === 0) return null;
  return <div className="flex flex-wrap gap-1 px-2 py-1" aria-label="FRAME references">
    {items.map(item => <span key={item.id} className="flex max-w-full items-center gap-1 rounded border px-2 text-xs">
      <button type="button" className="truncate py-1" title={item.subtitle ?? item.title}
        onClick={() => { void requestFrame("preview.open", { url: item.url }); }}>{item.title}</button>
      <button type="button" aria-label={`Remove ${item.title}`} onClick={() => removeFrameReference(threadId, item.id)}>×</button>
    </span>)}
  </div>;
}
