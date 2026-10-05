/* FRAME Studio asset precache.
 *
 * The workbench sends the list of a work's public files with content versions;
 * this worker stores them in Cache Storage and answers /files/... requests from
 * there, including the Range requests media decoding makes, so playback never
 * waits on the network. The preview stage asks it to drop changed files before
 * it reloads them, so an edit is never played stale.
 *
 * Built for high-latency links:
 * - small files travel together in bundles (one round trip for many files);
 * - large files are fetched as parallel 4 MB ranges, which lifts per-request
 *   throughput limits (tunnels, proxies) and keeps many requests in flight;
 * - no byte is fetched twice: content already cached for another path or work
 *   is copied locally, and the preview waits for an ongoing download instead of
 *   starting its own (the file it needs jumps the queue).
 */
const CACHE = "frame-assets-v2";
const VERSION = "x-frame-version";
const PARALLEL = 8; // requests in flight
const SMALL = 1024 * 1024; // files below this size go into bundles
const BUNDLE_BYTES = 4 * 1024 * 1024;
const BUNDLE_FILES = 200;
const CHUNK = 4 * 1024 * 1024;
const LOOKAHEAD = 8; // chunks of one file that may be fetched ahead of the one being written
const jobs = new Map(); // work key -> job

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith("frame-assets-") && name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  ),
);

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/files/")) return;
  event.respondWith(serve(request));
});

self.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.type === "precache") event.waitUntil(precache(message));
  else if (message.type === "invalidate") event.waitUntil(invalidate(message.urls || []).finally(() => event.ports[0]?.postMessage("done")));
});

// ---- serving ---------------------------------------------------------------

async function serve(request) {
  const cache = await caches.open(CACHE);
  let hit = await cache.match(request.url);
  const range = request.headers.get("range");
  if (!hit) {
    // Let the precache deliver it (now, ahead of the queue) rather than downloading it twice.
    // Range reads of large media still go to the network so playback can start at once.
    const pending = prioritize(request.url);
    if (!pending || range) return fetch(request);
    await pending.catch(() => {});
    hit = await cache.match(request.url);
    if (!hit) return fetch(request);
  }
  if (!range) return hit;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) return fetch(request); // multi-range: let the server answer
  const blob = await hit.blob();
  const size = blob.size;
  let start = 0,
    end = size - 1;
  if (match[1]) {
    start = Number(match[1]);
    if (match[2]) end = Math.min(Number(match[2]), size - 1);
  } else start = Math.max(0, size - Number(match[2]));
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const headers = new Headers(hit.headers);
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(blob.slice(start, end + 1), { status: 206, headers });
}

async function invalidate(urls) {
  const cache = await caches.open(CACHE);
  await Promise.all(urls.map((url) => cache.delete(new URL(url, self.location.origin).href)));
}

/** Put the tasks of a pending file first; returns a promise for when it is cached. */
function prioritize(url) {
  for (const job of jobs.values()) {
    const item = job.items.get(url);
    if (!item) continue;
    const mine = job.tasks.filter((task) => task.items?.includes(item) || task.item === item);
    job.tasks = [...mine, ...job.tasks.filter((task) => !mine.includes(task))];
    job.wake();
    return item.done.promise;
  }
  return null;
}

// ---- precache --------------------------------------------------------------

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => ((resolve = ok), (reject = fail)));
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function report(key, progress) {
  return self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    for (const client of clients) client.postMessage({ type: "precache", key, ...progress });
  });
}

/** version -> url of a cached copy, across every work cached so far. */
async function cachedVersions(cache) {
  const known = new Map();
  for (const request of await cache.keys()) {
    const version = (await cache.match(request))?.headers.get(VERSION);
    if (version) known.set(version, request.url);
  }
  return known;
}

/** Bytes arriving in arbitrary chunks, taken out in exact lengths. */
class ByteQueue {
  constructor(reader, onBytes) {
    this.reader = reader;
    this.onBytes = onBytes;
    this.chunks = [];
    this.length = 0;
  }
  async take(n) {
    while (this.length < n) {
      const { done, value } = await this.reader.read();
      if (done) throw new Error("打包下载的数据不完整");
      this.chunks.push(value);
      this.length += value.byteLength;
      this.onBytes(value.byteLength);
    }
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0];
      const count = Math.min(chunk.byteLength, n - offset);
      out.set(chunk.subarray(0, count), offset);
      offset += count;
      if (count === chunk.byteLength) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(count);
    }
    this.length -= n;
    return out;
  }
}

async function precache({ key, base, files }) {
  const signature = JSON.stringify(files);
  const previous = jobs.get(key);
  if (previous?.signature === signature) return;
  previous?.abort.abort();
  const job = { signature, abort: new AbortController(), items: new Map(), tasks: [], wake: () => {}, failure: null };
  jobs.set(key, job);
  const { signal } = job.abort;
  // On failure or when a newer list replaces this one, release everything still waiting
  // (half-written large files would otherwise wait for parts that never come).
  const release = () => {
    const cancelled = new Error("cancelled");
    for (const item of job.items.values()) {
      item.done.reject(cancelled);
      for (const part of item.parts ?? []) part?.reject(cancelled);
    }
  };
  signal.addEventListener("abort", release);
  const cache = await caches.open(CACHE);
  const origin = self.location.origin;
  const prefix = new URL(base, origin).href;
  const [repo, id] = key.split("/");
  const bundleUrl = `/api/works/${encodeURIComponent(repo)}/${encodeURIComponent(id)}/precache/bundle`;
  // Keys are normalized the way the engine's own requests are (assetUrl + URL parsing).
  const wanted = new Map(files.map((file) => [new URL(base + file.path, origin).href, file]));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let doneBytes = 0,
    doneFiles = 0,
    last = 0;
  const progress = (force) => {
    if (!force && Date.now() - last < 150) return;
    last = Date.now();
    void report(key, { state: "running", doneBytes: Math.min(doneBytes, totalBytes), totalBytes, doneFiles, totalFiles: files.length });
  };
  const received = (bytes) => {
    doneBytes += bytes;
    progress(false);
  };
  const finished = (item) => {
    item.done.resolve();
    job.items.delete(item.url);
    doneFiles++;
    progress(false);
  };

  // Drop files the work no longer has; keep those whose content is unchanged; copy known content.
  for (const request of await cache.keys()) if (request.url.startsWith(prefix) && !wanted.has(request.url)) await cache.delete(request);
  const known = await cachedVersions(cache);
  const small = [],
    large = [];
  for (const [url, file] of wanted) {
    if (known.get(file.version) === url) {
      doneBytes += file.size;
      doneFiles++;
      continue;
    }
    await cache.delete(url);
    const copy = known.has(file.version) && (await cache.match(known.get(file.version)));
    if (copy) {
      await cache.put(url, copy);
      doneBytes += file.size;
      doneFiles++;
      continue;
    }
    const item = { url, file, done: deferred() };
    job.items.set(url, item);
    (file.size < SMALL ? small : large).push(item);
  }

  // Bundles of small files first (most assets become available quickly), then the
  // large files' ranges in order, smallest file first.
  small.sort((a, b) => a.file.size - b.file.size);
  for (let index = 0; index < small.length; ) {
    const items = [];
    let bytes = 0;
    while (index < small.length && items.length < BUNDLE_FILES && (!items.length || bytes + small[index].file.size <= BUNDLE_BYTES)) {
      bytes += small[index].file.size;
      items.push(small[index++]);
    }
    job.tasks.push({ kind: "bundle", items });
  }
  large.sort((a, b) => a.file.size - b.file.size);
  for (const item of large) {
    const count = Math.ceil(item.file.size / CHUNK);
    item.parts = Array.from({ length: count }, deferred);
    item.written = 0; // index of the next part the cache is waiting for
    for (let index = 0; index < count; index++)
      job.tasks.push({ kind: "chunk", item, index, start: index * CHUNK, end: Math.min(item.file.size, (index + 1) * CHUNK) - 1 });
  }
  progress(true);

  const fetchBundle = async ({ items }) => {
    const response = await fetch(bundleUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: items.map((item) => item.file.path) }),
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`打包下载失败：HTTP ${response.status}`);
    const bytes = new ByteQueue(response.body.getReader(), received);
    for (let count = 0; count < items.length; count++) {
      const headerLength = new DataView((await bytes.take(4)).buffer).getUint32(0);
      const header = JSON.parse(new TextDecoder().decode(await bytes.take(headerLength)));
      const body = await bytes.take(header.size);
      const url = new URL(base + header.path, origin).href;
      const headers = new Headers({ "Content-Type": header.type, "Accept-Ranges": "bytes" });
      headers.set(VERSION, header.version);
      await cache.put(url, new Response(body, { headers }));
      const item = items.find((candidate) => candidate.url === url);
      if (item) finished(item);
    }
  };

  // A large file is written to the cache as one stream fed by its ranges, in order.
  const startWriting = (item, type) => {
    const headers = new Headers({ "Content-Type": type, "Accept-Ranges": "bytes" });
    headers.set(VERSION, item.file.version);
    const stream = new ReadableStream({
      async pull(controller) {
        if (item.written >= item.parts.length) return controller.close();
        try {
          const part = await item.parts[item.written].promise;
          item.parts[item.written++] = null;
          controller.enqueue(part);
          job.wake();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    item.writing = cache.put(item.url, new Response(stream, { headers })).then(() => finished(item));
    item.writing.catch((error) => fail(error));
  };

  const fetchChunk = async ({ item, index, start, end }) => {
    const response = await fetch(item.url, { headers: { Range: `bytes=${start}-${end}` }, credentials: "same-origin", cache: "no-store", signal });
    if (response.status !== 206 || !response.body) throw new Error(`${item.file.path}：分段下载失败（HTTP ${response.status}）`);
    // Every range must come from the same file version, or the parts would not fit together.
    const etag = response.headers.get("etag");
    item.etag ??= etag;
    if (etag !== item.etag) throw new Error(`${item.file.path} 在下载过程中被修改，稍后会重新缓存`);
    if (!item.writing) startWriting(item, response.headers.get("content-type") || "application/octet-stream");
    const part = new Uint8Array(end - start + 1);
    let offset = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      part.set(value, offset);
      offset += value.byteLength;
      received(value.byteLength);
    }
    if (offset !== part.length) throw new Error(`${item.file.path}：分段数据不完整`);
    item.parts[index].resolve(part);
  };

  const fail = (error) => {
    if (job.failure || signal.aborted) return;
    job.failure = error;
    job.abort.abort();
  };

  try {
    await new Promise((resolve) => {
      let active = 0;
      // A chunk too far ahead of its file's write position waits, which bounds memory.
      const ready = (task) => task.kind === "bundle" || task.index <= task.item.written + LOOKAHEAD;
      const next = () => {
        if (signal.aborted) return resolve();
        if (!job.tasks.length && !active) return resolve();
        while (active < PARALLEL) {
          const position = job.tasks.findIndex(ready);
          if (position < 0) break;
          const [task] = job.tasks.splice(position, 1);
          active++;
          (task.kind === "bundle" ? fetchBundle(task) : fetchChunk(task))
            .catch(fail)
            .finally(() => {
              active--;
              next();
            });
        }
      };
      job.wake = next;
      next();
    });
    // Ranges are all fetched; wait until the large files are fully written.
    await Promise.all(large.map((item) => item.writing));
    if (job.failure) throw job.failure;
    if (signal.aborted) return;
    await report(key, { state: "done", doneBytes: totalBytes, totalBytes, doneFiles: files.length, totalFiles: files.length });
  } catch (error) {
    const failure = job.failure || error;
    if (signal.aborted && !job.failure) return;
    const quota = failure?.name === "QuotaExceededError";
    await report(key, { state: "error", doneBytes: Math.min(doneBytes, totalBytes), totalBytes, doneFiles, totalFiles: files.length, error: quota ? "浏览器存储空间不足，部分素材未能缓存" : String(failure?.message || failure) });
  } finally {
    release();
    if (jobs.get(key) === job) jobs.delete(key);
  }
}
