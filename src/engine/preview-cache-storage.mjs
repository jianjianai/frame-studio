/** Content storage shared by the trusted Studio parent and standalone preview. */
export const PREVIEW_CACHE_NAME = "frame-preview-resources-v1";
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (x, n) => (x >>> n) | (x << (32 - n));
/** Incremental SHA-256: large soundbanks/video never need an ArrayBuffer of the whole file. */
export class PreviewSha256 {
  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ]);
    this.tail = new Uint8Array(64);
    this.length = 0;
    this.used = 0;
    this.w = new Uint32Array(64);
  }
  block(bytes, offset) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] =
        (bytes[p] << 24) |
        (bytes[p + 1] << 16) |
        (bytes[p + 2] << 8) |
        bytes[p + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      w[i] =
        w[i - 16] +
        (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
        w[i - 7] +
        (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          K[i] +
          w[i]) >>>
        0;
      const t2 =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) >>>
        0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const values = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) this.h[i] += values[i];
  }
  update(bytes) {
    this.length += bytes.length;
    let offset = 0;
    if (this.used) {
      const n = Math.min(64 - this.used, bytes.length);
      this.tail.set(bytes.subarray(0, n), this.used);
      this.used += n;
      offset += n;
      if (this.used === 64) {
        this.block(this.tail, 0);
        this.used = 0;
      }
    }
    while (offset + 64 <= bytes.length) {
      this.block(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.length) {
      this.tail.set(bytes.subarray(offset), 0);
      this.used = bytes.length - offset;
    }
    return this;
  }
  digest() {
    const end = new Uint8Array(this.used < 56 ? 64 : 128);
    end.set(this.tail.subarray(0, this.used));
    end[this.used] = 128;
    const view = new DataView(end.buffer);
    view.setUint32(end.length - 8, Math.floor(this.length / 0x20000000));
    view.setUint32(end.length - 4, (this.length * 8) >>> 0);
    for (let i = 0; i < end.length; i += 64) this.block(end, i);
    return [...this.h].map((x) => x.toString(16).padStart(8, "0")).join("");
  }
}
export async function previewBlobHash(blob, signal, progress) {
  const hash = new PreviewSha256(),
    step = 1024 * 1024;
  for (let at = 0; at < blob.size; at += step) {
    signal?.throwIfAborted();
    hash.update(new Uint8Array(await blob.slice(at, at + step).arrayBuffer()));
    progress?.(Math.min(blob.size, at + step));
    // Yield during long banks so cancel controls and progress remain responsive.
    if (at % (step * 8) === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return hash.digest();
}
export function previewCacheKey(sha256, origin = location.origin) {
  return new URL("/__frame_preview_content__/" + sha256, origin).href;
}
/** @param {any} resource @param {{signal?:AbortSignal,progress?:(bytes:number)=>void,cacheStorage?:CacheStorage|null,cacheName?:string,fetcher?:typeof fetch,origin?:string}} [options] */
export async function loadPreviewResource(
  resource,
  {
    signal,
    progress,
    cacheStorage,
    cacheName = PREVIEW_CACHE_NAME,
    fetcher = globalThis.fetch,
    origin = location.origin,
  } = {},
) {
  if (
    !/^[a-f0-9]{64}$/.test(resource.sha256) ||
    !Number.isSafeInteger(resource.bytes) ||
    resource.bytes < 0
  )
    throw Error("无效的预览资源身份");
  signal?.throwIfAborted();
  let cache, warning;
  const key = previewCacheKey(resource.sha256, origin);
  try {
    cache =
      cacheStorage === null
        ? undefined
        : await (cacheStorage ?? globalThis.caches)?.open(cacheName);
  } catch {
    warning = "浏览器未允许持久存储，缓存只在当前预览中保留";
  }
  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      const blob = await hit.blob();
      if (
        blob.size === resource.bytes &&
        (await previewBlobHash(blob, signal)) === resource.sha256
      ) {
        progress?.(blob.size);
        return {
          blob: new Blob([blob], { type: resource.type || blob.type }),
          persistent: true,
        };
      }
      await cache.delete(key);
    }
  }
  const response = await fetcher(resource.url, {
    signal,
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok || response.status === 206)
    throw Error("资源下载失败 (" + response.status + "): " + resource.path);
  const reader = response.body?.getReader();
  let size = 0;
  const hash = new PreviewSha256();
  const type =
    resource.type ||
    response.headers.get("Content-Type") ||
    "application/octet-stream";
  let blob;
  try {
    if (reader) {
      const verifiedStream = new ReadableStream({
        async pull(controller) {
          try {
            signal?.throwIfAborted();
            const value = await reader.read();
            if (value.done) {
              controller.close();
              return;
            }
            size += value.value.length;
            if (size > resource.bytes)
              throw Error("资源大小发生变化: " + resource.path);
            hash.update(value.value);
            progress?.(size);
            controller.enqueue(value.value);
          } catch (error) {
            controller.error(error);
            await reader.cancel().catch(() => {});
          }
        },
        cancel: (reason) => reader.cancel(reason),
      });
      // Browser Blob storage owns bytes; do not retain an array of every JS download chunk.
      blob = await new Response(verifiedStream, {
        headers: { "Content-Type": type },
      }).blob();
    } else {
      blob = await response.blob();
      size = blob.size;
      hash.update(new Uint8Array(await blob.arrayBuffer()));
    }
  } finally {
    await reader?.cancel().catch(() => {});
  }
  signal?.throwIfAborted();
  if (size !== resource.bytes || hash.digest() !== resource.sha256)
    throw Error("资源校验失败: " + resource.path);
  let persistent = false;
  if (cache) {
    try {
      await cache.put(
        key,
        new Response(blob, {
          headers: {
            "Content-Type": blob.type,
            "Content-Length": String(blob.size),
            "X-Frame-Cached": String(Date.now()),
          },
        }),
      );
      persistent = true;
    } catch (error) {
      warning =
        error?.name === "QuotaExceededError"
          ? "浏览器缓存空间不足，当前预览继续使用内存缓存；可清理缓存或释放磁盘空间"
          : "浏览器持久缓存写入失败，当前预览继续使用内存缓存";
    }
  }
  return { blob, persistent, warning };
}
export function cachedBlobResponse(blob, request, init) {
  const method =
    init?.method ?? (request instanceof Request ? request.method : "GET");
  const headers = new Headers(
    init?.headers ?? (request instanceof Request ? request.headers : undefined),
  );
  const result = {
    "Content-Type": blob.type || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Length": String(blob.size),
  };
  const range = headers.get("Range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": "bytes */" + blob.size },
      });
    const start = match[1]
      ? Number(match[1])
      : Math.max(0, blob.size - Number(match[2]));
    const end = match[1]
      ? match[2]
        ? Math.min(blob.size - 1, Number(match[2]))
        : blob.size - 1
      : blob.size - 1;
    if (start >= blob.size || end < start)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": "bytes */" + blob.size },
      });
    return new Response(method === "HEAD" ? null : blob.slice(start, end + 1), {
      status: 206,
      headers: {
        ...result,
        "Content-Length": String(end - start + 1),
        "Content-Range": "bytes " + start + "-" + end + "/" + blob.size,
      },
    });
  }
  return new Response(method === "HEAD" ? null : blob, { headers: result });
}
