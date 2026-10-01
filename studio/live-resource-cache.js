import {
  PREVIEW_CACHE_NAME,
  loadPreviewResource,
  previewCacheKey,
} from "../src/engine/preview-cache-storage.mjs";

/** Opaque players cannot access storage. This broker never trusts their URLs or hash claims. */
export function liveResourceCacheBridge(iframe, previewUrl, queuedEvents = []) {
  const base = new URL("./", new URL(previewUrl, location.href));
  if (
    !base.pathname.startsWith("/preview-live/") ||
    base.origin !== location.origin
  )
    return () => {};
  const lifetime = new AbortController(),
    inFlight = new Map(),
    authorized = new Map();
  let manifestTask,
    manifestAt = 0;
  const namespaces = new Map();
  const authorize = async (revision) => {
    if (!authorized.has(revision)) {
      if (!manifestTask || Date.now() - manifestAt > 250) {
        manifestAt = Date.now();
        manifestTask = fetch(new URL("manifest.json", base), {
          cache: "no-store",
          signal: lifetime.signal,
        })
          .then(async (response) => {
            if (!response.ok) throw Error("无法验证缓存资源清单");
            const manifest = await response.json();
            if (
              !Number.isSafeInteger(manifest.revision) ||
              !Array.isArray(manifest.resources)
            )
              throw Error("预览没有提供完整资源清单");
            const owner =
              manifest.workId ||
              manifest.projectId ||
              manifest.sessionId ||
              base.pathname.split("/")[2];
            if (!/^[a-zA-Z0-9-]{1,200}$/.test(owner))
              throw Error("无效的作品缓存身份");
            namespaces.set(manifest.revision, PREVIEW_CACHE_NAME + "-" + owner);
            authorized.set(
              manifest.revision,
              new Map(
                manifest.resources.map((resource) => {
                  const url = new URL(
                    resource.originalUrl || resource.url,
                    base,
                  );
                  if (
                    url.origin !== base.origin ||
                    !url.pathname.startsWith(base.pathname) ||
                    !/^[a-f0-9]{64}$/.test(resource.sha256) ||
                    !Number.isSafeInteger(resource.bytes) ||
                    resource.bytes < 0
                  )
                    throw Error("缓存资源越过预览边界");
                  return [resource.path, { ...resource, url: url.href }];
                }),
              ),
            );
            while (authorized.size > 3)
              authorized.delete(authorized.keys().next().value);
          })
          .finally(() => {
            manifestTask = undefined;
          });
      }
      await manifestTask;
    }
    const resources = authorized.get(revision);
    if (!resources) throw Error("预览版本已过期，请重试最新版本");
    return resources;
  };
  const receive = async (event) => {
    if (
      event.source !== iframe.current?.contentWindow ||
      event.data?.type !== "frame-preview-resource-cache"
    )
      return;
    const port = event.ports[0];
    if (!port) return;
    port.postMessage({ ack: true });
    const controller = new AbortController();
    let entry,
      cancelled = false;
    const cancel = () => {
      cancelled = true;
      controller.abort();
      entry?.owners.delete(port);
      if (entry && !entry.owners.size) entry.controller.abort();
    };
    port.onmessage = ({ data }) => {
      if (data?.cancel) cancel();
    };
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    try {
      const resources = await authorize(event.data.revision);
      signal.throwIfAborted();
      const cacheName = namespaces.get(event.data.revision);
      if (event.data.op === "estimate") {
        const estimate = await navigator.storage?.estimate?.();
        const persistent = await navigator.storage?.persisted?.();
        port.postMessage({
          result: { ...estimate, persistent, available: !!globalThis.caches },
        });
      } else if (event.data.op === "clear") {
        await caches.delete(cacheName);
        port.postMessage({ result: { cleared: true } });
      } else if (event.data.op === "prune") {
        const cache = await caches.open(cacheName),
          active = new Set(
            [...resources.values()].map((resource) =>
              previewCacheKey(resource.sha256),
            ),
          );
        for (const key of await cache.keys()) {
          if (event.data.revision !== Math.max(...authorized.keys())) break;
          if (!active.has(key.url)) await cache.delete(key);
        }
        port.postMessage({ result: { pruned: true } });
      } else {
        const resource = resources.get(event.data.path);
        if (!resource || resource.sha256 !== event.data.sha256)
          throw Error("缓存请求不在服务器授权清单中");
        entry = inFlight.get(resource.sha256);
        if (!entry || entry.controller.signal.aborted) {
          entry = {
            controller: new AbortController(),
            owners: new Set(),
            task: null,
          };
          const owned = entry;
          owned.task = loadPreviewResource(resource, {
            cacheName,
            signal: AbortSignal.any([lifetime.signal, owned.controller.signal]),
            progress: (bytes) => {
              for (const owner of owned.owners)
                owner.postMessage({ progress: bytes });
            },
          }).finally(() => {
            if (inFlight.get(resource.sha256) === owned)
              inFlight.delete(resource.sha256);
          });
          inFlight.set(resource.sha256, owned);
        }
        entry.owners.add(port);
        const result = await entry.task;
        signal.throwIfAborted();
        port.postMessage({ result }); // Blob structured clone keeps large media out of JS byte buffers.
      }
    } catch (error) {
      if (!cancelled && !lifetime.signal.aborted)
        port.postMessage({ error: error.message || String(error) });
    } finally {
      entry?.owners.delete(port);
      port.close();
    }
  };
  window.addEventListener("message", receive);
  for (const event of queuedEvents) void receive(event);
  return () => {
    lifetime.abort();
    for (const entry of inFlight.values()) entry.controller.abort();
    window.removeEventListener("message", receive);
  };
}
