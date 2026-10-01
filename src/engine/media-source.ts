import {
  Input,
  UrlSource,
  ALL_FORMATS,
  CanvasSink,
  type InputVideoTrack,
  type WrappedCanvas,
} from "mediabunny";
import { previewAssetUrl, type Quality } from "./types";
import { MediaRequestQueue } from "./media-buffering";
export interface MediaFrame {
  image: CanvasImageSource;
  width: number;
  height: number;
}
export interface VideoSource {
  duration: number;
  frame(time: number, signal?: AbortSignal): Promise<MediaFrame>;
  dispose(): void;
}
const INPUT_CACHE_BYTES = 2 * 1024 * 1024;
const INPUT_BUDGET_BYTES = 64 * 1024 * 1024;
const CANVAS_BUDGET_BYTES = 256 * 1024 * 1024;
const IMAGE_CACHE_BUDGET_BYTES = 32 * 1024 * 1024;
const IMAGE_BITMAP_BUDGET_BYTES = 128 * 1024 * 1024;
interface ImageEntry {
  url: string;
  ready: Promise<Blob>;
  bytes: number;
  owners: number;
  used: number;
  retired: boolean;
  controller: AbortController;
}
interface VideoEntry {
  url: string;
  input: Input;
  ready: Promise<{
    track: InputVideoTrack;
    origin: number;
    duration: number;
    aspect: number;
  }>;
  owners: number;
  used: number;
  retired: boolean;
}
interface VideoPoolState {
  entries: Set<VideoEntry>;
  cached: Map<string, VideoEntry>;
  canvasBytes: number;
  requests: MediaRequestQueue;
  images: Set<ImageEntry>;
  imageCached: Map<string, ImageEntry>;
  imageBytes: number;
  bitmapBytes: number;
  transfers: {
    bytes: number;
    responses: number;
    throughputBytesPerSecond: number;
    latencySeconds: number;
  };
}
// Immutable live revisions can contain different copies of this module. Resource
// limits and ref counts must span every copy while old and new scenes coexist.
const globalPool = globalThis as typeof globalThis & {
  __FRAME_VIDEO_SOURCE_POOL_V8__?: VideoPoolState;
};
const pool = (globalPool.__FRAME_VIDEO_SOURCE_POOL_V8__ ??= {
  entries: new Set(),
  cached: new Map(),
  canvasBytes: 0,
  requests: new MediaRequestQueue(4),
  images: new Set(),
  imageCached: new Map(),
  imageBytes: 0,
  bitmapBytes: 0,
  transfers: {
    bytes: 0,
    responses: 0,
    throughputBytesPerSecond: 0,
    latencySeconds: 0,
  },
});
const { entries, cached, requests } = pool;

/** Hold the network slot through the response body, not just through its headers. */
async function videoFetch(
  request: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const signal =
    init?.signal ??
    (request instanceof Request
      ? request.signal
      : new AbortController().signal);
  const slot = await requests.acquire(signal);
  let done = false,
    bytes = 0,
    headersAt = 0;
  const started = performance.now();
  const release = () => {
    if (done) return;
    done = true;
    const seconds = (performance.now() - headersAt) / 1000;
    if (bytes >= 16 * 1024 && headersAt && seconds > 0.05) {
      const sample = bytes / seconds;
      pool.transfers.throughputBytesPerSecond = pool.transfers
        .throughputBytesPerSecond
        ? pool.transfers.throughputBytesPerSecond * 0.75 + sample * 0.25
        : sample;
    }
    signal.removeEventListener("abort", release);
    slot();
  };
  try {
    signal.throwIfAborted();
    const response = await fetch(request, init);
    headersAt = performance.now();
    pool.transfers.responses++;
    pool.transfers.latencySeconds = Math.max(
      (headersAt - started) / 1000,
      pool.transfers.latencySeconds * 0.85,
    );
    if (!response.body) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    signal.addEventListener("abort", release, { once: true });
    if (signal.aborted) release();
    const streamed = new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              release();
              controller.close();
            } else {
              bytes += result.value.byteLength;
              pool.transfers.bytes += result.value.byteLength;
              controller.enqueue(result.value);
            }
          } catch (error) {
            release();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            release();
          }
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
    // Media parsers use these fields for redirected paths and size discovery.
    Object.defineProperties(streamed, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return streamed;
  } catch (error) {
    release();
    throw error;
  }
}
function removeEntry(entry: VideoEntry) {
  if (!entries.delete(entry)) return;
  if (cached.get(entry.url) === entry) cached.delete(entry.url);
  entry.retired = true;
  entry.input.dispose();
}
function previewQuality(quality: Quality): Quality {
  if (quality !== "standard") return quality;
  const connection = (
    globalThis.navigator as
      | (Navigator & {
          connection?: {
            saveData?: boolean;
            effectiveType?: string;
            downlink?: number;
          };
        })
      | undefined
  )?.connection;
  const constrained =
    connection?.saveData ||
    /^(slow-2g|2g|3g)$/.test(connection?.effectiveType ?? "") ||
    (connection?.downlink !== undefined && connection.downlink < 1.5) ||
    (pool.transfers.throughputBytesPerSecond > 0 &&
      pool.transfers.throughputBytesPerSecond < 128 * 1024);
  // Choose once when a source is acquired. Never repeatedly reload a playing clip.
  return constrained ? "draft" : quality;
}
function acquireEntry(src: string, quality: Quality): VideoEntry {
  // The live manifest makes this URL immutable. Different revisions never share an Input.
  const url = previewAssetUrl(src, previewQuality(quality));
  let entry = cached.get(url);
  if (!entry) {
    while ((entries.size + 1) * INPUT_CACHE_BYTES > INPUT_BUDGET_BYTES) {
      const oldest = [...entries]
        .filter((value) => !value.owners)
        .sort((a, b) => a.used - b.used)[0];
      if (!oldest) throw Error("视频缓存预算不足；请减少同时活跃的视频素材");
      removeEntry(oldest);
    }
    const input = new Input({
      source: new UrlSource(url, {
        maxCacheSize: INPUT_CACHE_BYTES,
        parallelism: 2,
        fetchFn: videoFetch,
        // Transient transport failures resume the same range; retries are bounded.
        getRetryDelay: (attempts) =>
          attempts <= 2 ? 0.25 * 2 ** (attempts - 1) : null,
        handleUnhandledError: () => {},
      }),
      formats: ALL_FORMATS,
    });
    entry = {
      url,
      input,
      owners: 0,
      used: performance.now(),
      retired: false,
      ready: undefined!,
    };
    entries.add(entry);
    cached.set(url, entry);
    const owned = entry;
    entry.ready = (async () => {
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode()))
        throw Error(
          "无法解码视频 " + src + "；请通过素材转码生成兼容的 H.264/VP9 副本",
        );
      const [origin, end, width, height] = await Promise.all([
        track.getFirstTimestamp(),
        track.computeDuration(),
        track.getDisplayWidth(),
        track.getDisplayHeight(),
      ]);
      if (
        ![origin, end, width, height].every(Number.isFinite) ||
        end <= origin ||
        width <= 0 ||
        height <= 0
      )
        throw Error("视频素材的时长或尺寸无效：" + src);
      return { track, origin, duration: end - origin, aspect: height / width };
    })();
    // Failed acquisitions do not poison subsequent attempts, including aborted initialization.
    void entry.ready.catch(() => removeEntry(owned));
  }
  entry.owners++;
  entry.used = performance.now();
  return entry;
}
function releaseEntry(entry: VideoEntry) {
  entry.owners--;
  entry.used = performance.now();
  if (!entry.owners && entry.retired) removeEntry(entry);
}
function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}
/** Cancelling one waiter never cancels a shared download or another owner's decoder. */
function waitFor<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener("abort", cancel);
      reject(aborted(signal));
    };
    signal.addEventListener("abort", cancel, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}
/** Close a session's idle sources; active scenes release their own Input leases later. */
export function clearVideoSourceCache(): void {
  for (const entry of pool.images) {
    entry.retired = true;
    if (pool.imageCached.get(entry.url) === entry)
      pool.imageCached.delete(entry.url);
    if (!entry.owners) removeImageEntry(entry);
  }
  for (const entry of entries) {
    entry.retired = true;
    if (cached.get(entry.url) === entry) cached.delete(entry.url);
    if (!entry.owners) removeEntry(entry);
  }
}
export function videoSourceDiagnostics() {
  return {
    sources: entries.size,
    owners: [...entries].reduce((total, entry) => total + entry.owners, 0),
    cacheBudgetBytes: INPUT_BUDGET_BYTES,
    perSourceCacheBytes: INPUT_CACHE_BYTES,
    reservedCacheBytes: entries.size * INPUT_CACHE_BYTES,
    decodedBudgetBytes: CANVAS_BUDGET_BYTES,
    reservedDecodedBytes: pool.canvasBytes,
    network: { ...requests.diagnostics(), ...pool.transfers },
    images: {
      sources: pool.images.size,
      cachedBytes: pool.imageBytes,
      cacheBudgetBytes: IMAGE_CACHE_BUDGET_BYTES,
      bitmapBytes: pool.bitmapBytes,
      bitmapBudgetBytes: IMAGE_BITMAP_BUDGET_BYTES,
    },
  };
}
/** Shared, bounded compressed data; each scene owns its sink and its two reusable canvases. */
export async function openVideoSource(
  src: string,
  width: number,
  signal?: AbortSignal,
  quality: Quality = "standard",
): Promise<VideoSource> {
  signal?.throwIfAborted();
  if (!Number.isInteger(width) || width < 1)
    throw Error("Invalid video frame width");
  const entry = acquireEntry(src, quality);
  let reserved = 0;
  try {
    const { track, origin, duration, aspect } = await waitFor(
      entry.ready,
      signal,
    );
    signal?.throwIfAborted();
    const height = Math.max(1, Math.round(width * aspect));
    reserved = width * height * 4 * 2;
    if (reserved > CANVAS_BUDGET_BYTES - pool.canvasBytes) {
      reserved = 0;
      throw Error("视频解码画面预算不足；请降低预览尺寸或减少视频图层");
    }
    pool.canvasBytes += reserved;
    const sink = new CanvasSink(track, { width, alpha: true, poolSize: 2 });
    const lifetime = new AbortController();
    type Job = { time: number; consumers: number; task: Promise<MediaFrame> };
    const pending = new Map<number, Job>();
    let tail: Promise<unknown> = Promise.resolve();
    let iterator: AsyncGenerator<WrappedCanvas, void, unknown> | undefined;
    let current: WrappedCanvas | undefined, ahead: WrappedCanvas | undefined;
    const surfaces = new Set<HTMLCanvasElement | OffscreenCanvas>();
    let lastTime = -Infinity;
    const closeIterator = async () => {
      const previous = iterator;
      iterator = undefined;
      current = undefined;
      ahead = undefined;
      await previous?.return();
    };
    const decode = async (time: number): Promise<MediaFrame> => {
      lifetime.signal.throwIfAborted();
      const target = origin + time;
      // Continuous playback keeps the decoder and its small lookahead alive. A true seek
      // starts a new iterator against the retained compressed range cache.
      if (!iterator || time < lastTime || time - lastTime > 0.75) {
        await closeIterator();
        lifetime.signal.throwIfAborted();
        iterator = sink.canvases(target);
        const first = await iterator.next();
        current = first.done ? undefined : first.value;
        if (current) surfaces.add(current.canvas);
      }
      lastTime = time;
      lifetime.signal.throwIfAborted();
      if (!current) throw Error("视频目标帧不存在：" + src + " @ " + time);
      if (ahead && ahead.timestamp <= target + 1e-9) {
        current = ahead;
        ahead = undefined;
      }
      while (!ahead && current.timestamp + current.duration <= target + 1e-9) {
        const next = await iterator!.next();
        if (!next.done) surfaces.add(next.value.canvas);
        lifetime.signal.throwIfAborted();
        if (next.done) break;
        if (next.value.timestamp > target + 1e-9) ahead = next.value;
        else current = next.value;
      }
      return {
        image: current.canvas,
        width: current.canvas.width,
        height: current.canvas.height,
      };
    };
    return {
      duration,
      async frame(time, frameSignal) {
        lifetime.signal.throwIfAborted();
        frameSignal?.throwIfAborted();
        if (!Number.isFinite(time) || time < 0 || time >= duration)
          throw Error("视频片段超出素材时长：" + src + " @ " + time);
        let job = pending.get(time);
        if (!job) {
          const next = {
            time,
            consumers: 0,
            task: undefined! as Promise<MediaFrame>,
          };
          next.task = tail
            .catch(() => {})
            .then(async () => {
              // Cancelled seeks never start decoder work after the currently running frame.
              if (!next.consumers)
                throw new DOMException("Superseded frame", "AbortError");
              try {
                return await decode(next.time);
              } catch (error) {
                await closeIterator();
                throw error;
              }
            });
          job = next;
          pending.set(time, job);
          tail = job.task;
          void job.task.then(
            () => {
              if (pending.get(time) === next) pending.delete(time);
            },
            () => {
              if (pending.get(time) === next) pending.delete(time);
            },
          );
        }
        job.consumers++;
        const owned = job;
        const combined = AbortSignal.any([
          lifetime.signal,
          ...(frameSignal ? [frameSignal] : []),
        ]);
        let released = false;
        const releaseConsumer = () => {
          if (released) return;
          released = true;
          owned.consumers--;
          combined.removeEventListener("abort", releaseConsumer);
          if (!owned.consumers && pending.get(time) === owned)
            pending.delete(time);
        };
        combined.addEventListener("abort", releaseConsumer, { once: true });
        try {
          return await waitFor(owned.task, combined);
        } finally {
          releaseConsumer();
        }
      },
      dispose() {
        if (lifetime.signal.aborted) return;
        lifetime.abort();
        // Wait for any borrowed canvases to leave the decoder before releasing reservations.
        void tail
          .catch(() => {})
          .then(closeIterator)
          .catch(() => {})
          .finally(() => {
            // A disposed source may still be retained by author code. Free its actual
            // canvas storage before returning the memory reservation to other scenes.
            for (const surface of surfaces) surface.width = surface.height = 1;
            surfaces.clear();
            pool.canvasBytes -= reserved;
          });
        releaseEntry(entry);
      },
    };
  } catch (error) {
    if (reserved) pool.canvasBytes -= reserved;
    releaseEntry(entry);
    throw error;
  }
}
function removeImageEntry(entry: ImageEntry) {
  if (!pool.images.delete(entry)) return;
  if (pool.imageCached.get(entry.url) === entry)
    pool.imageCached.delete(entry.url);
  entry.retired = true;
  entry.controller.abort();
  pool.imageBytes -= entry.bytes;
}
function reserveImageBytes(entry: ImageEntry, bytes: number) {
  while (pool.imageBytes + bytes > IMAGE_CACHE_BUDGET_BYTES) {
    const oldest = [...pool.images]
      .filter((value) => !value.owners && value !== entry && value.bytes)
      .sort((a, b) => a.used - b.used)[0];
    if (!oldest) throw Error("图片缓存预算不足；请降低素材尺寸或预览质量");
    removeImageEntry(oldest);
  }
  entry.bytes += bytes;
  pool.imageBytes += bytes;
}
function acquireImageEntry(src: string, quality: Quality): ImageEntry {
  const url = previewAssetUrl(src, previewQuality(quality));
  let entry = pool.imageCached.get(url);
  if (!entry) {
    if (pool.images.size >= 64) {
      const oldest = [...pool.images]
        .filter((value) => !value.owners)
        .sort((a, b) => a.used - b.used)[0];
      if (!oldest) throw Error("同时加载的图片过多；请减少活跃图层");
      removeImageEntry(oldest);
    }
    entry = {
      url,
      ready: undefined!,
      bytes: 0,
      owners: 0,
      used: performance.now(),
      retired: false,
      controller: new AbortController(),
    };
    pool.images.add(entry);
    pool.imageCached.set(url, entry);
    const owned = entry;
    entry.ready = (async () => {
      const response = await videoFetch(url, {
        signal: owned.controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error("图片加载失败：" + src + " (" + response.status + ")");
      }
      if (!response.body) throw Error("图片响应缺少内容：" + src);
      const reader = response.body.getReader(),
        chunks: BlobPart[] = [];
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          owned.controller.signal.throwIfAborted();
          reserveImageBytes(owned, result.value.byteLength);
          chunks.push(result.value as Uint8Array<ArrayBuffer>);
        }
        return new Blob(chunks, {
          type: response.headers.get("Content-Type") ?? "",
        });
      } finally {
        await reader.cancel().catch(() => {});
      }
    })();
    void entry.ready.catch(() => removeImageEntry(owned));
  }
  entry.owners++;
  entry.used = performance.now();
  return entry;
}
/** Compressed bytes are shared, but every caller owns a separate, bounded bitmap. */
export async function openImageSource(
  src: string,
  signal?: AbortSignal,
  width?: number,
  height?: number,
  quality: Quality = "standard",
): Promise<ImageBitmap> {
  signal?.throwIfAborted();
  if (
    (width !== undefined && (!Number.isInteger(width) || width < 1)) ||
    (height !== undefined && (!Number.isInteger(height) || height < 1))
  )
    throw Error("Invalid image frame size");
  const entry = acquireImageEntry(src, quality);
  let bitmap: ImageBitmap | undefined;
  try {
    const blob = await waitFor(entry.ready, signal);
    signal?.throwIfAborted();
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      // Browser Image handles SVG dimensions and formats unsupported by the blob decoder.
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        signal?.throwIfAborted();
        bitmap = await createImageBitmap(img);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    signal?.throwIfAborted();
    const scale = Math.min(
      1,
      (width ?? bitmap.width) / bitmap.width,
      (height ?? bitmap.height) / bitmap.height,
    );
    if (scale < 1) {
      const resized = await createImageBitmap(bitmap, {
        resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
        resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
        resizeQuality: "high",
      });
      bitmap.close();
      bitmap = resized;
    }
    signal?.throwIfAborted();
    const bytes = bitmap.width * bitmap.height * 4;
    if (pool.bitmapBytes + bytes > IMAGE_BITMAP_BUDGET_BYTES)
      throw Error("图片解码预算不足；请减少图片图层或降低预览尺寸");
    const close = bitmap.close.bind(bitmap);
    let closed = false;
    Object.defineProperty(bitmap, "close", {
      value: () => {
        if (closed) return;
        closed = true;
        close();
        pool.bitmapBytes -= bytes;
      },
    });
    pool.bitmapBytes += bytes;
    return bitmap;
  } catch (error) {
    bitmap?.close();
    throw error;
  } finally {
    entry.owners--;
    entry.used = performance.now();
    if (!entry.owners && entry.retired) removeImageEntry(entry);
  }
}
