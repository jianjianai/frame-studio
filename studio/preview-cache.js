const NAME = "frame-preview-audio-v1";
let maintenance;
async function trim(cache) {
  const keys = await cache.keys();
  const rows = await Promise.all(
    keys.map(async (key) => {
      const response = await cache.match(key);
      return {
        key,
        at: Number(response.headers.get("X-Frame-Cached")),
        bytes: Number(response.headers.get("Content-Length")),
      };
    }),
  );
  rows.sort((a, b) => b.at - a.at);
  let size = 0;
  for (let i = 0; i < rows.length; i++) {
    size += rows[i].bytes;
    if (
      i >= 2048 ||
      size > 128 * 1024 * 1024 ||
      Date.now() - rows[i].at > 30 * 86400000
    )
      await cache.delete(rows[i].key);
  }
}
export function previewCacheBridge(iframe, url) {
  const base = new URL("./", new URL(url, location.href));
  let releaseResources = () => {},
    disposed = false;
  const queuedResources = [];
  const pendingResources = (event) => {
    if (
      event.source !== iframe.current?.contentWindow ||
      event.data?.type !== "frame-preview-resource-cache"
    )
      return;
    const port = event.ports[0];
    if (!port) return;
    port.postMessage({ ack: true });
    queuedResources.push(event);
  };
  if (
    base.origin === location.origin &&
    base.pathname.startsWith("/preview-live/")
  ) {
    window.addEventListener("message", pendingResources);
    import("./live-resource-cache.js")
      .then(({ liveResourceCacheBridge }) => {
        if (disposed) return;
        releaseResources = liveResourceCacheBridge(
          iframe,
          url,
          queuedResources.splice(0),
        );
        window.removeEventListener("message", pendingResources);
      })
      .catch((error) => {
        window.removeEventListener("message", pendingResources);
        for (const event of queuedResources.splice(0)) {
          event.ports[0].postMessage({
            error: "浏览器缓存模块加载失败，请重试：" + error.message,
          });
          event.ports[0].close();
        }
      });
  }
  const pending = new Map();
  const lifetime = new AbortController();
  const valid = async (data, sha) => {
    const actual = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return actual === sha;
  };
  const receive = async (event) => {
    if (
      event.source !== iframe.current?.contentWindow ||
      event.data?.type !== "frame-preview-audio"
    )
      return;
    const { file, sha256, bytes } = event.data,
      port = event.ports[0];
    if (
      !port ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      file !== `preview-audio/${sha256}.mp3` ||
      !(bytes > 0 && bytes < 262144)
    ) {
      port?.close();
      return;
    }
    port.postMessage({ ack: true });
    let cancelled = false,
      entry;
    const release = () => {
      cancelled = true;
      entry?.ports.delete(port);
      if (entry && !entry.ports.size) entry.controller.abort();
    };
    port.onmessage = ({ data }) => {
      if (data?.cancel) release();
    };
    try {
      if (
        !pending.has(sha256) ||
        pending.get(sha256).controller.signal.aborted
      ) {
        entry = { ports: new Set(), controller: new AbortController() };
        pending.set(sha256, entry);
        entry.promise = (async () => {
          let cache;
          const key = new URL(
            `/__frame_audio_cache__/${sha256}`,
            location.origin,
          ).href;
          try {
            cache = await caches.open(NAME);
            const hit = await cache.match(key);
            if (hit) {
              const data = await hit.arrayBuffer();
              if (data.byteLength === bytes && (await valid(data, sha256)))
                return data;
              await cache.delete(key);
            }
          } catch {
            /* Storage may be disabled or full; playback still works. */
          }
          const response = await fetch(new URL(file, base), {
            signal: AbortSignal.any([lifetime.signal, entry.controller.signal]),
          });
          if (!response.ok) throw Error("Preview audio unavailable");
          const data = await response.arrayBuffer();
          if (data.byteLength !== bytes || !(await valid(data, sha256)))
            throw Error("Preview audio checksum mismatch");
          if (cache) {
            try {
              await cache.put(
                key,
                new Response(data, {
                  headers: {
                    "Content-Type": "audio/mpeg",
                    "Content-Length": String(bytes),
                    "X-Frame-Cached": String(Date.now()),
                  },
                }),
              );
              maintenance ??= trim(cache)
                .catch(() => {})
                .finally(() => {
                  maintenance = undefined;
                });
            } catch {
              /* Quota errors must never interrupt playback. */
            }
          }
          return data;
        })().finally(() => {
          if (pending.get(sha256) === entry) pending.delete(sha256);
        });
      } else entry = pending.get(sha256);
      entry.ports.add(port);
      const data = (await entry.promise).slice(0);
      if (!lifetime.signal.aborted && !cancelled)
        port.postMessage({ bytes: data }, [data]);
    } catch {
      if (!cancelled) port.postMessage({ unavailable: true });
    } finally {
      entry?.ports.delete(port);
      port.close();
    }
  };
  window.addEventListener("message", receive);
  return () => {
    disposed = true;
    window.removeEventListener("message", pendingResources);
    for (const event of queuedResources.splice(0)) {
      event.ports[0].postMessage({ error: "预览已关闭" });
      event.ports[0].close();
    }
    releaseResources();
    lifetime.abort();
    window.removeEventListener("message", receive);
  };
}
