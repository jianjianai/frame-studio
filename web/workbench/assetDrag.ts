import type { Asset } from "../lib/types";

/**
 * Dragging an asset from the assets view onto the timeline. `dragover` handlers cannot
 * read dataTransfer data, so the dragged asset is kept here for the drop preview.
 */
export const ASSET_DRAG_TYPE = "application/x-frame-asset";
let dragged: Asset | null = null;

export const assetDrag = {
  start(event: React.DragEvent, asset: Asset) {
    dragged = asset;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.path);
    event.dataTransfer.setData("text/plain", asset.url);
  },
  end() {
    dragged = null;
  },
  /** The asset of a drag event that came from the assets view, else null. */
  of(event: React.DragEvent) {
    return [...event.dataTransfer.types].includes(ASSET_DRAG_TYPE) ? dragged : null;
  },
};
