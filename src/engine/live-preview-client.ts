import {
  livePreviewManifestSchema,
  livePreviewStartingSchema,
  livePreviewErrorSchema,
} from "../contracts/live-preview.mjs";
import type { AnimationProject } from "./types";
import { previewSnapshotBusy } from "./live-preview-lock";
import type { z } from "zod";
import {
  createLivePreviewCache,
  validPreviewMode,
  type PreviewMediaMode,
  type PreviewCacheState,
} from "./live-preview-cache";

export type LivePreviewManifest = z.infer<typeof livePreviewManifestSchema>;
export type LivePreviewStatus = {
  state: "ready" | "updating" | "error" | "reconnecting";
  revision?: number;
  sourceRevision?: string;
  sessionId: string;
  error?: string;
  mediaMode?: PreviewMediaMode;
};
export interface LivePreviewConfig {
  manifestUrl: string;
  eventsUrl: string;
  sessionId: string;
  mediaMode?: PreviewMediaMode;
}
export interface LivePreviewCallbacks {
  onProject: (
    project: AnimationProject,
    manifest: LivePreviewManifest,
    signal: AbortSignal,
    onCommit: () => void,
  ) => Promise<void>;
  onStatus: (status: LivePreviewStatus) => void;
  onCache?: (state: PreviewCacheState) => void;
}
class PreviewNetworkError extends Error {}
const isNetworkFailure = (error: unknown) =>
  error instanceof PreviewNetworkError ||
  (error instanceof DOMException && error.name === "TimeoutError") ||
  /failed to fetch|fetch failed|dynamically imported module|networkerror|network request|load failed|网络连接.{0,8}(中断|失败)/i.test(
    String(error),
  );
async function cancellable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
/** One event stream; immutable module URLs share cached dependencies across revisions. */
export function createLivePreviewClient(
  config: LivePreviewConfig,
  callbacks: LivePreviewCallbacks,
) {
  let disposed = false,
    reconnecting = false,
    processing = false;
  const cache = createLivePreviewCache((value) => {
    window.__FRAME_PREVIEW_CACHE__ = value;
    callbacks.onCache?.(value);
  });
  const requestedMode =
    new URLSearchParams(location.search).get("mediaMode") || config.mediaMode;
  cache.setMode(validPreviewMode(requestedMode) ? requestedMode : "compressed");
  let forceApply = false,
    cacheSuspended = false;
  let applied: LivePreviewManifest | undefined,
    latest: LivePreviewManifest | undefined,
    lastReceived: LivePreviewManifest | undefined,
    processingManifest: LivePreviewManifest | undefined;
  const newestManifest = () =>
    [latest, processingManifest, lastReceived, applied]
      .filter((value): value is LivePreviewManifest => !!value)
      .sort((a, b) => b.revision - a.revision)[0];
  let receivedRevision = 0,
    candidate: AbortController | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined,
    networkRetry: ReturnType<typeof setTimeout> | undefined;
  let retryRevision = 0,
    retryAttempts = 0;
  let failure:
    { revision: number; error: string; transient: boolean } | undefined;
  let buildError: { revision: number; error: string } | undefined;
  let refresh: AbortController | undefined;
  const prefetched = new Set<string>();
  const source = new EventSource(new URL(config.eventsUrl, location.href).href);
  const status = (state: LivePreviewStatus["state"], error?: string) => {
    if (disposed) return;
    const value: LivePreviewStatus = {
      state,
      sessionId: config.sessionId,
      mediaMode: cache.mode(),
      revision: applied?.revision,
      sourceRevision: applied?.sourceRevision,
      ...(error ? { error } : {}),
    };
    window.__FRAME_LIVE_STATUS__ = value;
    callbacks.onStatus(value);
  };
  const clearRetry = (reset = false) => {
    if (networkRetry) clearTimeout(networkRetry);
    networkRetry = undefined;
    if (reset) {
      retryRevision = 0;
      retryAttempts = 0;
    }
  };
  const moduleUrl = (path: string) => {
    const url = new URL(path, location.href),
      page = new URL(location.href);
    if (
      url.origin !== page.origin ||
      !url.pathname.startsWith(new URL(".", page).pathname)
    )
      throw new Error("Live project module is outside this preview session");
    return url.href;
  };
  // Ordinary fetches do not populate the browser's ESM module map with permanent failed imports.
  // Finish all required code into HTTP cache before evaluating any candidate scene or audio module.
  const preflight = async (
    manifest: LivePreviewManifest,
    signal: AbortSignal,
  ) => {
    if (cache.mode() === "cached") {
      await cache.prepare(manifest, signal);
      return;
    }
    const urls = [
      ...new Set(
        [manifest.projectUrl, ...(manifest.preloads ?? [])].map(moduleUrl),
      ),
    ].filter((url) => !prefetched.has(url));
    const group = new AbortController();
    const requestSignal = AbortSignal.any([signal, group.signal]);
    let index = 0,
      failed: unknown;
    const worker = async () => {
      while (index < urls.length && failed === undefined) {
        const url = urls[index++];
        try {
          const response = await fetch(url, {
            cache: "force-cache",
            credentials: "same-origin",
            signal: requestSignal,
          });
          if (!response.ok) {
            const message = "Preview module request failed: " + response.status;
            if (
              response.status === 408 ||
              response.status === 429 ||
              response.status >= 500
            )
              throw new PreviewNetworkError(message);
            throw new Error(message);
          }
          await response.arrayBuffer();
          requestSignal.throwIfAborted();
          prefetched.add(url);
          // Browser HTTP cache remains authoritative; bound only our duplicate-fetch bookkeeping.
          if (prefetched.size > 1024)
            prefetched.delete(prefetched.values().next().value!);
        } catch (error) {
          if (failed === undefined) {
            failed = error;
            group.abort();
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
    signal.throwIfAborted();
    if (failed !== undefined) throw failed;
  };
  const scheduleRetry = (revision: number) => {
    if (
      disposed ||
      revision < receivedRevision ||
      revision <= (applied?.revision ?? -1) ||
      networkRetry
    )
      return;
    if (retryRevision !== revision) {
      retryRevision = revision;
      retryAttempts = 0;
    }
    const delay = [2000, 4000, 8000][retryAttempts++];
    if (delay === undefined) return;
    networkRetry = setTimeout(() => {
      networkRetry = undefined;
      void fetchManifest(true);
    }, delay);
  };
  const drain = async () => {
    if (
      processing ||
      disposed ||
      previewSnapshotBusy() ||
      (cacheSuspended && cache.mode() === "cached")
    )
      return;
    processing = true;
    try {
      while (
        latest &&
        !disposed &&
        !previewSnapshotBusy() &&
        !(cacheSuspended && cache.mode() === "cached")
      ) {
        const requested = latest;
        // Compare skipped revisions to the version actually shown, including after a frozen export.
        const reset = forceApply;
        forceApply = false;
        const manifest = {
          ...requested,
          changes: {
            visual:
              reset ||
              !applied ||
              requested.fingerprints.visual !== applied.fingerprints.visual,
            audio:
              reset ||
              !applied ||
              requested.fingerprints.audio !== applied.fingerprints.audio,
            metadata:
              !applied ||
              requested.fingerprints.metadata !== applied.fingerprints.metadata,
          },
        };
        processingManifest = manifest;
        latest = undefined;
        candidate?.abort();
        const controller = (candidate = new AbortController());
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(cache.mode() === "cached" ? 30 * 60000 : 60000),
        ]);
        status("updating");
        let committed = false;
        const commit = () => {
          if (committed) return;
          signal.throwIfAborted();
          applied = manifest;
          committed = true;
          cache.committed();
          failure = undefined;
          clearRetry(true);
          if (buildError && buildError.revision >= manifest.revision)
            status("error", buildError.error);
          else status(reconnecting ? "reconnecting" : "ready");
        };
        try {
          const url = moduleUrl(manifest.projectUrl);
          await preflight(manifest, signal);
          const mod = (await cancellable(
            import(/* @vite-ignore */ url),
            signal,
          )) as { default?: AnimationProject };
          if (!mod.default || typeof mod.default.load !== "function")
            throw new Error("Invalid live project module");
          signal.throwIfAborted();
          const sources = manifest.audioSources;
          const project: AnimationProject = {
            ...mod.default,
            livePreview: true,
            previewAudioSources: sources,
            previewAudioGeneratorRevision: manifest.audioGeneratorRevision,
          };
          await cancellable(
            callbacks.onProject(project, manifest, signal, commit),
            signal,
          );
          // Older callbacks may notify only by resolving. Live Player calls
          // commit synchronously when its prepared picture/audio pair is accepted.
          if (!committed) commit();
        } catch (error) {
          if (!committed && !controller.signal.aborted && !disposed) {
            cache.failed(error);
            const transient = isNetworkFailure(error);
            failure = {
              revision: manifest.revision,
              error: String(error),
              transient,
            };
            status(transient ? "reconnecting" : "error", failure.error);
            if (transient) scheduleRetry(manifest.revision);
            // A failed candidate must not be re-applied by an unrelated React status render.
            controller.abort(error);
          }
        }
      }
    } finally {
      processing = false;
      processingManifest = undefined;
      if (
        latest &&
        !disposed &&
        !previewSnapshotBusy() &&
        !(cacheSuspended && cache.mode() === "cached")
      )
        void drain();
    }
  };
  const accept = (value: unknown, retry = false, retryErrors = false) => {
    const result = livePreviewManifestSchema.safeParse(value);
    if (!result.success) {
      if (!livePreviewStartingSchema.safeParse(value).success)
        status("error", "Invalid live preview revision");
      return;
    }
    const manifest = result.data;
    if (manifest.sessionId !== config.sessionId) {
      status("error", "Live preview session identity mismatch");
      return;
    }
    if (!lastReceived || manifest.revision >= lastReceived.revision)
      lastReceived = manifest;
    if (
      manifest.revision < receivedRevision ||
      manifest.revision <= (applied?.revision ?? 0)
    )
      return;
    if (!retry && manifest.revision <= receivedRevision) return;
    if (
      retry &&
      !retryErrors &&
      failure?.revision === manifest.revision &&
      !failure.transient
    )
      return;
    if (latest && latest.revision >= manifest.revision) return;
    if (
      processingManifest &&
      processingManifest.revision >= manifest.revision &&
      !candidate?.signal.aborted
    )
      return;
    if (manifest.revision > receivedRevision) {
      clearRetry(true);
      failure = undefined;
    }
    if (buildError && manifest.revision > buildError.revision)
      buildError = undefined;
    receivedRevision = Math.max(receivedRevision, manifest.revision);
    latest = manifest;
    candidate?.abort(new DOMException("Superseded revision", "AbortError"));
    void drain();
  };
  const fetchManifest = async (retry = false, retryErrors = false) => {
    refresh?.abort();
    const controller = (refresh = new AbortController());
    try {
      const response = await fetch(new URL(config.manifestUrl, location.href), {
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(30000),
        ]),
      });
      if (!response.ok) {
        const message = "Preview revision request failed: " + response.status;
        if (
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500
        )
          throw new PreviewNetworkError(message);
        throw new Error(message);
      }
      accept(await response.json(), retry, retryErrors);
      if (
        !reconnecting &&
        !failure &&
        !buildError &&
        applied &&
        !latest &&
        !processing
      )
        status("ready");
    } catch (error) {
      if (!disposed && !controller.signal.aborted) {
        const transient = isNetworkFailure(error);
        failure = {
          revision: receivedRevision,
          error: String(error),
          transient,
        };
        status(transient ? "reconnecting" : "error", failure.error);
        if (transient) scheduleRetry(receivedRevision);
      }
    }
  };
  const schedulePoll = () => {
    if (poll || disposed || !reconnecting) return;
    poll = setTimeout(() => {
      poll = undefined;
      void fetchManifest(true).finally(schedulePoll);
    }, 15000);
  };
  source.addEventListener("revision", (event) => {
    try {
      accept(JSON.parse((event as MessageEvent).data));
    } catch (error) {
      status("error", String(error));
    }
  });
  source.addEventListener("error", (event) => {
    if (event instanceof MessageEvent && typeof event.data === "string") {
      try {
        const result = livePreviewErrorSchema.safeParse(JSON.parse(event.data));
        if (result.success) {
          buildError = {
            revision: result.data.revision,
            error: result.data.message,
          };
          clearRetry();
          status("error", result.data.message);
          return;
        }
      } catch {
        /* A transport error is handled below. */
      }
    }
    reconnecting = true;
    status("reconnecting", failure?.error);
    schedulePoll();
  });
  source.addEventListener("open", () => {
    reconnecting = false;
    if (poll) clearTimeout(poll);
    poll = undefined;
    void fetchManifest(true);
    if (applied && !latest && !processing && !failure && !buildError)
      status("ready");
  });
  const readers = () => {
    if (previewSnapshotBusy()) {
      if (
        processingManifest &&
        processingManifest.revision > (applied?.revision ?? 0) &&
        (!latest || latest.revision < processingManifest.revision)
      )
        latest = processingManifest;
      candidate?.abort(
        new DOMException("Frozen export in progress", "AbortError"),
      );
    } else void drain();
  };
  const offline = () => {
    reconnecting = true;
    status("reconnecting", failure?.error);
    schedulePoll();
  };
  const online = () => {
    reconnecting = source.readyState !== EventSource.OPEN;
    clearRetry(true);
    if (!reconnecting && poll) {
      clearTimeout(poll);
      poll = undefined;
    }
    void fetchManifest(true);
  };
  window.addEventListener("frame-preview-readers", readers);
  window.addEventListener("offline", offline);
  window.addEventListener("online", online);
  status("updating");
  void fetchManifest();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    source.close();
    cache.dispose();
    candidate?.abort();
    refresh?.abort();
    if (poll) clearTimeout(poll);
    clearRetry();
    window.removeEventListener("frame-preview-readers", readers);
    window.removeEventListener("offline", offline);
    window.removeEventListener("online", online);
    window.removeEventListener("pagehide", dispose);
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return {
    dispose,
    retry: () => {
      clearRetry(true);
      cacheSuspended = false;
      const wanted = newestManifest();
      if (
        cache.mode() === "cached" &&
        wanted &&
        cache.state().state !== "ready"
      ) {
        cache.setMode("cached");
        forceApply = true;
        latest = wanted;
        void drain();
        return Promise.resolve();
      }
      return fetchManifest(true, true);
    },
    applied: () => applied,
    cacheState: cache.state,
    waitCached: cache.waitReady,
    cancelCache: () => {
      cacheSuspended = true;
      clearRetry(true);
      candidate?.abort(new DOMException("缓存已取消", "AbortError"));
      cache.cancel();
      status(
        applied ? "ready" : "error",
        applied ? undefined : "缓存已取消，点击继续缓存",
      );
    },
    clearCache: async () => {
      if (cache.mode() === "cached" && cache.state().state !== "ready") {
        cacheSuspended = true;
        clearRetry(true);
        candidate?.abort(new DOMException("缓存已清理", "AbortError"));
        cache.cancel();
        status(
          applied ? "ready" : "error",
          applied ? undefined : "缓存已取消，点击继续缓存",
        );
      }
      await cache.clear();
    },
    mode: cache.mode,
    setMode: (mode: PreviewMediaMode) => {
      if (
        mode === cache.mode() &&
        cache.state().state !== "error" &&
        cache.state().state !== "cancelled"
      )
        return;
      if (previewSnapshotBusy())
        throw Error("导出正在读取固定版本，完成后再切换预览模式");
      cacheSuspended = false;
      cache.setMode(mode);
      candidate?.abort(new DOMException("Preview mode changed", "AbortError"));
      const shown = newestManifest();
      if (shown) {
        forceApply = true;
        latest = shown;
        void drain();
      } else void fetchManifest(true, true);
      status("updating");
    },
  };
}
declare global {
  interface Window {
    __FRAME_LIVE_PREVIEW__?: LivePreviewConfig;
    __FRAME_LIVE_STATUS__?: LivePreviewStatus;
    __FRAME_PREVIEW_CACHE__?: PreviewCacheState;
  }
}
