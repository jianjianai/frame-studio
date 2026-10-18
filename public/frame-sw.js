/* FRAME Studio cache for the preview.
 *
 * Assets: a work's files (its public/ folder and the library files it plays) are kept in
 * Cache Storage with content versions, and /files/... requests are answered from there,
 * including the Range requests media decoding makes. The files its playback uses are
 * downloaded as soon as the work opens, so playback never waits on the network; the others
 * (`lazy` in the list) the first time something asks for them. The stage page carries the
 * current list (the workbench sends it too, and again after changes) and the worker keeps the
 * newest, also across its own restarts: kept files that changed are dropped before any of
 * them is served, and the preview stage drops files it is about to reload after an edit. The
 * workbench's editors open kept files with the version from the list (?v=…) and are answered
 * from here when the kept copy is that version.
 *
 * Modules: preview pages carry the etag of every module they will import. A kept module
 * whose etag is unchanged is answered from Cache Storage without asking the server, so
 * opening a work again sends no module requests at all; changed modules are fetched.
 *
 * Built for high-latency links:
 * - small files travel together in bundles (one round trip for many files, also for the
 *   lazy files asked for at the same moment);
 * - large files are fetched as parallel 4 MB ranges, which lifts per-request
 *   throughput limits (tunnels, proxies) and keeps many requests in flight; each
 *   range becomes a Blob (browser storage, not script memory) and the file is
 *   stored once complete (Chrome fails a streamed Cache.put above 10 MB here);
 * - no byte is fetched twice: content already cached for another path or work
 *   is copied locally, and the preview waits for an ongoing download instead of
 *   starting its own (the file it needs jumps the queue).
 */
const CACHE = "frame-assets-v2";
const LISTS = "frame-lists-v1";
const MODULES = "frame-modules-v1";
const VERSION = "x-frame-version";
const PARALLEL = 8; // requests in flight
const SMALL = 1024 * 1024; // files below this size go into bundles
const BUNDLE_BYTES = 4 * 1024 * 1024;
const BUNDLE_FILES = 200;
const CHUNK = 4 * 1024 * 1024;
const GATHER = 20; // ms a lazy file waits for others asked for at the same moment (a scene loading its images)
const PAGES = /^\/preview\/(stage|resource|asset|render|export)\.html$/;
const jobs = new Map(); // work key -> job downloading the files its playback uses
const lists = new Map(); // work key -> its newest list (an older one arriving late is ignored)
const later = new Map(); // work key -> downloads of its other files, as they are asked for
const moduleVersions = new Map(); // module url -> etag of its compiled code, from the latest page listing it

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (
          (name.startsWith("frame-assets-") && name !== CACHE) ||
          (name.startsWith("frame-lists-") && name !== LISTS) ||
          (name.startsWith("frame-modules-") && name !== MODULES)
        )
          await caches.delete(name);
      await self.clients.claim();
    })(),
  ),
);

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && PAGES.test(url.pathname)) return event.respondWith(page(event));
  if (url.pathname.startsWith("/files/")) return event.respondWith(serve(event));
  const etag = moduleVersions.get(request.url);
  if (etag) event.respondWith(serveModule(event, etag));
});

self.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.type === "precache") event.waitUntil(precache(message)?.finished ?? Promise.resolve());
  else if (message.type === "invalidate") event.waitUntil(invalidate(message.urls || []).finally(() => event.ports[0]?.postMessage("done")));
});

// ---- preview pages ---------------------------------------------------------

/** A preview page: learn its modules' versions (and the stage's asset list) before the page asks for any. */
async function page(event) {
  const response = await fetch(event.request);
  try {
    const html = response.ok ? await response.clone().text() : "";
    const match = /<script type="application\/json" id="frame-cache">([\s\S]*?)<\/script>/.exec(html);
    if (match) {
      const data = JSON.parse(match[1]);
      const listed = [];
      for (const [path, etag] of Object.entries(data.modules || {})) {
        const url = new URL(path, self.location.origin).href;
        moduleVersions.set(url, etag);
        listed.push(url);
      }
      event.waitUntil(prune(listed).catch(() => {}));
      const job = data.precache ? precache(data.precache) : null;
      if (job) event.waitUntil(job.finished);
    }
  } catch {
    // Without the list the page still works: it asks the server as usual.
  }
  return response;
}

async function serveModule(event, etag) {
  const cache = await caches.open(MODULES);
  const kept = await cache.match(event.request.url);
  if (kept && sameTag(kept.headers.get("etag"), etag)) return kept;
  let response = await fetch(event.request);
  // Not the version the page was made with: a copy the browser kept on a proxy's say-so
  // (Cloudflare turns no-cache into hours), or a change since. Ask the server itself.
  if (response.ok && !sameTag(response.headers.get("etag"), etag)) response = await fetch(event.request, { cache: "no-cache" });
  if (response.ok && sameTag(response.headers.get("etag"), etag)) event.waitUntil(cache.put(event.request.url, response.clone()).catch(() => {}));
  return response;
}

/** Tags of the same content: a proxy that compresses marks them weak (Cloudflare) or appends the encoding (Caddy: "…-zstd"). */
const sameTag = (a, b) => Boolean(a && b) && bareTag(a) === bareTag(b);
const bareTag = (tag) => tag.replace(/^W\//, "").replace(/-(?:zstd|gzip|br|deflate)"$/, '"');

/** Older copies of the listed modules (an earlier ?t= after an edit) are never asked for again. */
async function prune(listed) {
  const cache = await caches.open(MODULES);
  const keep = new Set(listed);
  const paths = new Set(listed.map((url) => url.split("?")[0]));
  for (const request of await cache.keys()) if (!keep.has(request.url) && paths.has(request.url.split("?")[0])) await cache.delete(request);
}

// ---- serving ---------------------------------------------------------------

async function serve(event) {
  const request = event.request;
  // The workbench's editors ask for a file at a version (?v=, from the same list): the kept
  // copy answers only when it is that version, otherwise the server does.
  const versioned = /^([^?#]*)\?v=([^&#]+)$/.exec(request.url);
  const url = versioned ? versioned[1] : request.url;
  const version = versioned ? decodeURIComponent(versioned[2]) : null;
  const current = (response) => (response && (version === null || response.headers.get(VERSION) === version) ? response : undefined);
  // A newer list may drop a kept file that changed: let it be looked at first.
  for (const job of jobs.values()) if (url.startsWith(job.prefix)) await job.applied.promise;
  const cache = await caches.open(CACHE);
  const kept = await cache.match(url);
  let hit = current(kept);
  const range = request.headers.get("range");
  if (!hit) {
    // Let the precache deliver it (now, ahead of the queue) rather than downloading it twice;
    // a listed file it does not download is fetched and kept now (unless kept at another
    // version than asked for). Range reads of large media still go to the network so
    // playback can start at once.
    if (!range) for (const job of jobs.values()) if (url.startsWith(job.prefix)) await job.planned.promise;
    const item = prioritize(url) ?? (kept ? null : await fetchLater(url));
    if (!item) return fetch(request);
    event.waitUntil(item.done.promise.catch(() => {}));
    if (range) return fetch(request);
    await item.done.promise.catch(() => {});
    hit = current(await cache.match(url));
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

/** Put the tasks of a pending file first; returns it (`done` when it is cached). */
function prioritize(url) {
  for (const job of jobs.values()) {
    const item = job.items.get(url);
    if (!item) continue;
    const mine = job.tasks.filter((task) => task.items?.includes(item) || task.item === item);
    job.tasks = [...mine, ...job.tasks.filter((task) => !mine.includes(task))];
    job.wake?.();
    return item;
  }
  return null;
}

// ---- lists -----------------------------------------------------------------

/** A work's list as the worker uses it: its files by the address the engine asks for. */
function remember({ key, base, at = 0, files }, signature = JSON.stringify(files)) {
  const origin = self.location.origin;
  // Keys are normalized the way the engine's own requests are (assetUrl + URL parsing).
  const list = { key, base, at, signature, listed: files, prefix: new URL(base, origin).href, files: new Map(files.map((file) => [new URL(base + file.path, origin).href, file])) };
  lists.set(key, list);
  return list;
}

const listAddress = (key) => `${self.location.origin}/frame-sw/lists/${encodeURIComponent(key)}`;

/** Kept for when the worker starts again: lazy files are still kept when asked for. */
async function keepList({ key, base, at, listed }) {
  const cache = await caches.open(LISTS);
  await cache.put(listAddress(key), new Response(JSON.stringify({ key, base, at, files: listed }), { headers: { "Content-Type": "application/json" } }));
}

/** The newest list of the work a /files/ address belongs to (the one kept, after a restart). */
async function listFor(url) {
  for (const list of lists.values()) if (url.startsWith(list.prefix)) return list;
  const match = /^\/files\/([^/]+)\/([^/]+)\//.exec(new URL(url).pathname);
  if (!match) return null;
  const key = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
  const kept = await (await caches.open(LISTS)).match(listAddress(key)).catch(() => undefined);
  const message = kept && (await kept.json().catch(() => null));
  if (!message?.files) return null;
  return lists.get(key) ?? remember(message);
}

/** version -> url of a cached copy, across every work cached so far (looked up once per list). */
function versionsOf(list, cache) {
  list.known ??= (async () => {
    const known = new Map();
    for (const request of await cache.keys()) {
      const version = (await cache.match(request))?.headers.get(VERSION);
      if (version) known.set(version, request.url);
    }
    return known;
  })();
  return list.known;
}

/** Content of this version cached for another path or work, stored for `url` too. */
async function copied(list, cache, url, file) {
  const known = await versionsOf(list, cache);
  const copy = known.has(file.version) && (await cache.match(known.get(file.version)));
  if (!copy) return false;
  await cache.put(url, copy);
  return true;
}

// ---- downloads -------------------------------------------------------------

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

/** Small files (`{ url, file }` items, smallest first) in bundles of up to BUNDLE_FILES files / BUNDLE_BYTES. */
function bundleTasks(small) {
  small.sort((a, b) => a.file.size - b.file.size);
  const tasks = [];
  for (let index = 0; index < small.length; ) {
    const items = [];
    let bytes = 0;
    while (index < small.length && items.length < BUNDLE_FILES && (!items.length || bytes + small[index].file.size <= BUNDLE_BYTES)) {
      bytes += small[index].file.size;
      items.push(small[index++]);
    }
    tasks.push({ kind: "bundle", items });
  }
  return tasks;
}

/** A large file's ranges, in order. */
function chunkTasks(item) {
  const count = Math.ceil(item.file.size / CHUNK);
  item.parts = new Array(count); // a Blob per range, in order
  item.missing = count;
  return Array.from({ length: count }, (_, index) => ({ kind: "chunk", item, index, start: index * CHUNK, end: Math.min(item.file.size, (index + 1) * CHUNK) - 1 }));
}

/*
 * A download's context: the work (`key`, `base`), the asset cache, the signal that stops it,
 * and what to do as bytes arrive (`received`) and when a file is kept (`finished`).
 */

async function fetchBundle({ key, base, cache, signal, received, finished }, items) {
  const [repo, id] = key.split("/");
  const response = await fetch(`/api/works/${encodeURIComponent(repo)}/${encodeURIComponent(id)}/precache/bundle`, {
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
    const url = new URL(base + header.path, self.location.origin).href;
    const headers = new Headers({ "Content-Type": header.type, "Accept-Ranges": "bytes" });
    headers.set(VERSION, header.version);
    await cache.put(url, new Response(body, { headers }));
    const item = items.find((candidate) => candidate.url === url);
    if (item) finished(item);
  }
}

async function fetchChunk({ cache, signal, received, finished }, { item, index, start, end }) {
  if (item.failed) return;
  const response = await fetch(item.url, { headers: { Range: `bytes=${start}-${end}` }, credentials: "same-origin", cache: "no-store", signal });
  if (response.status !== 206 || !response.body) throw new Error(`${item.file.path}：分段下载失败（HTTP ${response.status}）`);
  // Every range must come from the same file version, or the parts would not fit together.
  const etag = response.headers.get("etag");
  item.etag ??= etag;
  if (etag !== item.etag) throw new Error(`${item.file.path} 在下载过程中被修改，稍后会重新缓存`);
  item.type ??= response.headers.get("content-type") || "application/octet-stream";
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
    received(value.byteLength);
  }
  if (length !== end - start + 1) throw new Error(`${item.file.path}：分段数据不完整`);
  if (item.failed) return;
  item.parts[index] = new Blob(chunks);
  if (--item.missing) return;
  const headers = new Headers({ "Content-Type": item.type, "Accept-Ranges": "bytes" });
  headers.set(VERSION, item.file.version);
  await cache.put(item.url, new Response(new Blob(item.parts, { type: item.type }), { headers }));
  item.parts = null;
  finished(item);
}

/**
 * Run a queue's tasks PARALLEL at a time until none are left or the signal stops them;
 * `queue.wake` (set while it runs) starts tasks added meanwhile. A failed task goes to `fail`.
 */
function drain(queue, context, fail) {
  return new Promise((resolve) => {
    const next = () => {
      if (context.signal.aborted || (!queue.tasks.length && !queue.active)) {
        queue.wake = null;
        return resolve();
      }
      while (queue.active < PARALLEL && queue.tasks.length) {
        const task = queue.tasks.shift();
        queue.active++;
        (task.kind === "bundle" ? fetchBundle(context, task.items) : fetchChunk(context, task))
          .catch((error) => fail(error, task))
          .finally(() => {
            queue.active--;
            next();
          });
      }
    };
    queue.wake = next;
    next();
  });
}

// ---- precache: the files playback uses -------------------------------------

/**
 * Take a work's list (unless an older one than the newest) and start keeping the files its
 * playback uses (a job replaces the work's running one unless the list is the same). Returns
 * the job at once: requests for the work's files wait for its `applied` (kept files checked
 * against the list), not for the downloads; one for a file not kept waits for `planned` (what
 * will be downloaded is known) to join its download.
 */
function precache(message) {
  const { key, base, files, at = 0 } = message;
  if (!key || !base || !Array.isArray(files)) return null;
  const newest = lists.get(key);
  if (at < (newest?.at ?? 0)) return null;
  const signature = JSON.stringify(files);
  const list = newest?.signature === signature ? Object.assign(newest, { at }) : remember(message, signature);
  const previous = jobs.get(key);
  if (previous?.list === list) return previous;
  previous?.abort.abort();
  const job = {
    list,
    prefix: list.prefix,
    abort: new AbortController(),
    applied: deferred(),
    planned: deferred(),
    items: new Map(),
    tasks: [],
    active: 0,
    wake: null,
    failure: null,
  };
  jobs.set(key, job);
  job.finished = run(job, list).finally(() => {
    job.applied.resolve();
    job.planned.resolve();
    if (jobs.get(key) === job) jobs.delete(key);
  });
  return job;
}

async function run(job, list) {
  const { key, base } = list;
  const { signal } = job.abort;
  // On failure or when a newer list replaces this one, release everything still waiting.
  const release = () => {
    const cancelled = new Error("cancelled");
    for (const item of job.items.values()) item.done.reject(cancelled);
  };
  signal.addEventListener("abort", release);
  const cache = await caches.open(CACHE);
  const played = [...list.files].filter(([, file]) => !file.lazy);
  const totalBytes = played.reduce((sum, [, file]) => sum + file.size, 0);
  const totalFiles = played.length;
  let doneBytes = 0,
    doneFiles = 0,
    last = 0;
  const progress = (force) => {
    if (!force && Date.now() - last < 150) return;
    last = Date.now();
    void report(key, { state: "running", doneBytes: Math.min(doneBytes, totalBytes), totalBytes, doneFiles, totalFiles });
  };
  const context = {
    key,
    base,
    cache,
    signal,
    received: (bytes) => {
      doneBytes += bytes;
      progress(false);
    },
    finished: (item) => {
      item.done.resolve();
      job.items.delete(item.url);
      doneFiles++;
      progress(false);
    },
  };

  const saved = keepList(list).catch(() => {});
  try {
    // Drop files the work no longer has and kept files whose content changed; the rest is current.
    const current = new Set();
    for (const request of await cache.keys()) {
      if (!request.url.startsWith(job.prefix)) continue;
      const file = list.files.get(request.url);
      const kept = file && (await cache.match(request));
      if (kept?.headers.get(VERSION) === file.version) current.add(request.url);
      else await cache.delete(request);
    }
    job.applied.resolve();

    // Copy content cached for another path or work; download the rest. Lazy files wait to be asked for.
    const small = [],
      large = [];
    for (const [url, file] of played) {
      if (current.has(url) || (await copied(list, cache, url, file))) {
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
    job.tasks.push(...bundleTasks(small));
    large.sort((a, b) => a.file.size - b.file.size);
    for (const item of large) job.tasks.push(...chunkTasks(item));
    job.planned.resolve();
    progress(true);

    await drain(job, context, (error) => {
      if (job.failure || signal.aborted) return;
      job.failure = error;
      job.abort.abort();
    });
    if (job.failure) throw job.failure;
    if (signal.aborted) return;
    await report(key, { state: "done", doneBytes: totalBytes, totalBytes, doneFiles: totalFiles, totalFiles });
  } catch (error) {
    const failure = job.failure || error;
    if (signal.aborted && !job.failure) return;
    const quota = failure?.name === "QuotaExceededError";
    await report(key, { state: "error", doneBytes: Math.min(doneBytes, totalBytes), totalBytes, doneFiles, totalFiles, error: quota ? "浏览器存储空间不足，部分素材未能缓存" : String(failure?.message || failure) });
  } finally {
    release();
    await saved;
  }
}

// ---- later: the other files, when asked for --------------------------------

/**
 * A listed file no job downloads (one playback does not use, or one whose download stopped):
 * fetch it now and keep it. Its download (`done` when it is kept); null when no list has it.
 */
async function fetchLater(url) {
  const asked = askedLater(url);
  if (asked) return asked;
  const list = await listFor(url);
  const file = list?.files.get(url);
  // A file the running job will download: it is joined once planned.
  if (!file || (!file.lazy && jobs.has(list.key))) return null;
  return askedLater(url) ?? queueLater(list, url, file);
}

function askedLater(url) {
  for (const queue of later.values()) {
    const item = queue.items.get(url);
    if (item) return item;
  }
  return null;
}

function queueLater(list, url, file) {
  let queue = later.get(list.key);
  if (!queue) later.set(list.key, (queue = { key: list.key, base: list.base, items: new Map(), small: [], tasks: [], active: 0, wake: null, timer: null }));
  const item = { url, file, done: deferred() };
  queue.items.set(url, item);
  void (async () => {
    const cache = await caches.open(CACHE);
    if (await copied(list, cache, url, file).catch(() => false)) {
      queue.items.delete(url);
      return item.done.resolve();
    }
    if (file.size < SMALL) queue.small.push(item);
    else queue.tasks.push(...chunkTasks(item));
    queue.timer ??= setTimeout(() => startLater(queue, cache), GATHER);
  })().catch((error) => {
    queue.items.delete(url);
    item.done.reject(error);
  });
  return item;
}

function startLater(queue, cache) {
  queue.timer = null;
  queue.tasks.unshift(...bundleTasks(queue.small.splice(0)));
  if (queue.wake) return queue.wake();
  const done = (item) => {
    queue.items.delete(item.url);
    if (!queue.items.size && !queue.timer && later.get(queue.key) === queue) later.delete(queue.key);
  };
  const context = {
    key: queue.key,
    base: queue.base,
    cache,
    signal: new AbortController().signal,
    received: () => {},
    finished: (item) => {
      item.done.resolve();
      done(item);
    },
  };
  // A failed download leaves the file to the network; the next request tries again.
  void drain(queue, context, (error, task) => {
    for (const item of task.items ?? [task.item]) {
      item.failed = true;
      item.parts = null;
      item.done.reject(error);
      done(item);
    }
  });
}
