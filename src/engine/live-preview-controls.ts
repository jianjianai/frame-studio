import type { createLivePreviewClient } from "./live-preview-client";
import type { PreviewMediaMode } from "./live-preview-cache";

/** Available during the initial download, before a project can be evaluated. */
export function installPreviewControls(
  client: ReturnType<typeof createLivePreviewClient>,
) {
  const controls = {
    preview: () => ({
      mode: client.mode(),
      cache: client.cacheState(),
      revision: client.applied()?.revision,
    }),
    setPreviewMode: (mode: PreviewMediaMode) => {
      client.setMode(mode);
      return controls.preview();
    },
    waitPreviewCache: (options: { timeoutMs?: number } = {}) =>
      client.waitCached(options.timeoutMs),
    retryPreviewCache: () => {
      void client.retry();
      return controls.preview();
    },
    cancelPreviewCache: () => {
      client.cancelCache();
      return controls.preview();
    },
    clearPreviewCache: () => client.clearCache(),
  };
  window.__FRAME_PREVIEW_CONTROL__ = controls;
  // Preview controls exist before FRAME_AI's project methods become available.
  if (!window.FRAME_AI) {
    const starter = {
      ...controls,
      help: () => ({
        preview:
          'FRAME_AI.preview(); FRAME_AI.setPreviewMode("cached"); await FRAME_AI.waitPreviewCache()',
        ready: "await FRAME_AI.ready()",
      }),
      async ready() {
        const deadline = Date.now() + 30 * 60000;
        while (window.FRAME_AI === (starter as unknown)) {
          const value = controls.preview();
          if (
            value.cache.state === "error" ||
            value.cache.state === "cancelled"
          )
            throw Error(
              value.cache.error ||
                (value.cache.state === "cancelled"
                  ? "缓存已取消，点击继续缓存"
                  : "缓存失败"),
            );
          if (window.__FRAME_LIVE_STATUS__?.state === "error")
            throw Error(window.__FRAME_LIVE_STATUS__.error || "预览准备失败");
          if (Date.now() > deadline) throw Error("等待播放器准备超时");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return window.FRAME_AI?.ready();
      },
    };
    window.FRAME_AI = starter as NonNullable<typeof window.FRAME_AI>;
  }
  return controls;
}
declare global {
  interface Window {
    __FRAME_PREVIEW_CONTROL__?: ReturnType<typeof installPreviewControls>;
  }
}
