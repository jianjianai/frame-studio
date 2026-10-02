import type { createLivePreviewClient } from "../engine/live-preview-client";
import { validPreviewMode } from "../engine/live-preview-cache";

type Client = ReturnType<typeof createLivePreviewClient>;

/** The opaque preview frame owns all cache state; the workbench only presents it. */
export function installPreviewMediaBridge(
  client: Client,
  onMode: () => void,
  onError: (message: string) => void,
) {
  let channel = "",
    pendingAction = "",
    controlError = "",
    disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const snapshot = () => ({
    mode: client.mode(),
    cache: client.cacheState(),
    exportBusy: (window.__FRAME_PREVIEW_READERS__ ?? 0) > 0,
    controlError,
    pendingAction,
  });
  const publish = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!disposed && channel)
      parent.postMessage(
        { type: "frame-preview-media-state", channel, state: snapshot() },
        "*",
      );
  };
  // Progress can update many times per frame. Send at most four snapshots per second.
  const update = () => {
    if (!disposed && channel && !timer) timer = setTimeout(publish, 250);
  };
  const execute = async (data: {
    action: string;
    mode?: unknown;
    requestId: string;
  }) => {
    const requestChannel = channel;
    let error = "",
      started = false;
    try {
      if (pendingAction) throw Error("上一项操作还在进行，请稍候");
      if ((window.__FRAME_PREVIEW_READERS__ ?? 0) > 0)
        throw Error("导出正在读取固定版本，完成后再调整素材模式或缓存");
      pendingAction = data.action;
      started = true;
      controlError = "";
      onError("");
      publish();
      if (data.action === "mode") {
        if (!validPreviewMode(data.mode)) throw Error("无效的素材模式");
        client.setMode(data.mode);
        onMode();
      } else if (data.action === "cancel") client.cancelCache();
      else if (data.action === "retry") await client.retry();
      else if (data.action === "clear") await client.clearCache();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
      controlError = error;
      if (!disposed) onError(error);
    } finally {
      // A stale subscription cannot acknowledge a newer workbench session.
      if (started) pendingAction = "";
      if (!disposed) {
        publish();
        parent.postMessage(
          {
            type: "frame-preview-media-result",
            channel: requestChannel,
            requestId: data.requestId,
            ...(error ? { error } : {}),
          },
          "*",
        );
      }
    }
  };
  const receive = (event: MessageEvent) => {
    if (disposed || parent === window || event.source !== parent) return;
    const data = event.data;
    if (
      data?.type === "frame-preview-media-subscribe" &&
      typeof data.channel === "string" &&
      data.channel.length > 0 &&
      data.channel.length <= 100
    ) {
      channel = data.channel;
      publish();
    } else if (
      data?.type === "frame-preview-media-command" &&
      channel &&
      data.channel === channel &&
      typeof data.requestId === "string" &&
      data.requestId.length > 0 &&
      data.requestId.length <= 100 &&
      ["mode", "cancel", "retry", "clear"].includes(data.action)
    ) {
      void execute(data);
    }
  };
  window.addEventListener("message", receive);
  window.addEventListener("frame-preview-readers", publish);
  if (parent !== window)
    parent.postMessage({ type: "frame-preview-media-ready" }, "*");
  return {
    update,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("message", receive);
      window.removeEventListener("frame-preview-readers", publish);
    },
  };
}
