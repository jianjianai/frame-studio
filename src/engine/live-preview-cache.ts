import {
  cachedBlobResponse,
  loadPreviewResource,
  PREVIEW_CACHE_NAME,
} from "./preview-cache-storage.mjs";
import { rewritePreviewCode } from "./preview-code-cache.mjs";
import type { LivePreviewManifest } from "./live-preview-client";
export type PreviewMediaMode = "original" | "compressed" | "cached";
export interface PreviewCacheState {
  state: "idle" | "downloading" | "preparing" | "ready" | "cancelled" | "error";
  revision?: number;
  totalBytes: number;
  downloadedBytes: number;
  totalFiles: number;
  completeFiles: number;
  remaining: {
    path: string;
    bytes: number;
    downloadedBytes: number;
    state: "queued" | "downloading" | "error";
    error?: string;
  }[];
  persistentFiles: number;
  warning?: string;
  error?: string;
  storage?: { usage?: number; quota?: number; persistent?: boolean };
}
/** Byte readiness is distinct from successful scene/audio preparation. */
export function previewCachePresentation(cache: PreviewCacheState) {
  const resourcesComplete =
    cache.totalFiles > 0 &&
    cache.completeFiles === cache.totalFiles &&
    cache.remaining.length === 0 &&
    cache.downloadedBytes >= cache.totalBytes;
  const title = {
    idle: "等待缓存",
    downloading: "正在缓存",
    preparing: "素材已缓存，正在准备播放",
    ready: "缓存与画面已就绪",
    cancelled: resourcesComplete ? "素材已缓存，播放准备已取消" : "缓存已取消",
    error: resourcesComplete ? "素材已缓存，播放器准备失败" : "缓存未完成",
  }[cache.state];
  return {
    resourcesComplete,
    title,
    retryLabel: resourcesComplete ? "重试准备播放" : "继续缓存",
  };
}
type Resource = LivePreviewManifest["resources"][number];
type Entry = { blob: Blob; url: string; persistent: boolean };
type BrokerResult = { blob: Blob; persistent: boolean; warning?: string };
const modes = new Set(["original", "compressed", "cached"]);
export const validPreviewMode = (value: unknown): value is PreviewMediaMode =>
  typeof value === "string" && modes.has(value);

function broker<T>(
  data: object,
  signal: AbortSignal,
  progress?: (bytes: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const channel = new MessageChannel();
    let acknowledged = false;
    const timer = setTimeout(() => {
      if (!acknowledged) finish(Error("缓存桥不可用"));
    }, 1200);
    const abort = () => {
      channel.port1.postMessage({ cancel: true });
      finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const finish = (error?: unknown, value?: T) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      channel.port1.close();
      if (error) reject(error);
      else resolve(value!);
    };
    channel.port1.onmessage = (event) => {
      if (event.data?.ack) {
        acknowledged = true;
        clearTimeout(timer);
      } else if (typeof event.data?.progress === "number")
        progress?.(event.data.progress);
      else if (event.data?.error) finish(Error(event.data.error));
      else if (event.data?.result) finish(undefined, event.data.result);
    };
    signal.addEventListener("abort", abort, { once: true });
    parent.postMessage({ type: "frame-preview-resource-cache", ...data }, "*", [
      channel.port2,
    ]);
  });
}

/** Cached bytes are explicitly served by this adapter, including Range and worker requests. */
export function createLivePreviewCache(
  onState: (state: PreviewCacheState) => void,
) {
  const nativeFetch = globalThis.fetch.bind(globalThis),
    NativeWorker = globalThis.Worker,
    NativeFontFace = globalThis.FontFace;
  const pendingResources = new Map<
    string,
    { task: Promise<Entry>; signal: AbortSignal }
  >();
  const byHash = new Map<string, Entry>(),
    byUrl = new Map<string, Entry>(),
    scripts = new Map<string, string>(),
    semanticUrls = new Map<string, string>();
  const originals = new Map<string, string>(),
    workerUrls = new Map<string, string>(),
    ownedUrls = new Set<string>();
  const compiled = new Map<string, { code: string; url: string }>(),
    compiledWorkers = new Map<string, { code: string; url: string }>(),
    mappedImports = new Set<string>();
  let acceptedHashes = new Set<string>(),
    previousHashes = new Set<string>();
  const retiredUrls: { url: string; revision: number }[] = [];
  let mode: PreviewMediaMode = "compressed",
    manifest: LivePreviewManifest | undefined,
    disposed = false;
  let state: PreviewCacheState = {
    state: "idle",
    totalBytes: 0,
    downloadedBytes: 0,
    totalFiles: 0,
    completeFiles: 0,
    persistentFiles: 0,
    remaining: [],
  };
  let abort: AbortController | undefined,
    activeStyles: HTMLStyleElement[] = [],
    pendingStyles: HTMLStyleElement[] = [],
    notifyAt = 0;
  const emit = (patch: Partial<PreviewCacheState> = {}, force = true) => {
    state = { ...state, ...patch };
    if (force || performance.now() - notifyAt > 80) {
      notifyAt = performance.now();
      onState(structuredClone(state));
    }
  };
  const absolute = (value: string, base = location.href) =>
    new URL(value, base).href;
  const aliases = (resource: Resource) => [
    absolute(resource.url),
    absolute(resource.originalUrl),
    absolute(resource.path),
  ];
  // Libraries choose loaders using the original filename (for example Pixi Assets).
  // Keep that semantic URL; only the API which actually consumes bytes gets a Blob URL.
  const resolve = (url: string) => {
    if (mode !== "cached") return url;
    const original = new URL(url, location.href),
      canonical =
        semanticUrls.get(original.href) ??
        semanticUrls.get(original.href.split("#")[0]);
    if (!canonical || original.search) return url;
    // A versioned semantic URL also keeps the SDK's own asset cache fresh on updates.
    const current = new URL(canonical);
    current.hash = original.hash;
    return current.href;
  };
  const lookup = (url: string) => {
    const key = absolute(url);
    return byUrl.get(key) ?? byUrl.get(key.split("#")[0]);
  };
  const blobUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    ownedUrls.add(url);
    return url;
  };
  globalThis.fetch = async (request, init) => {
    const url = absolute(
      request instanceof Request ? request.url : String(request),
    );
    const signal =
      init?.signal ?? (request instanceof Request ? request.signal : undefined);
    signal?.throwIfAborted();
    if (mode === "cached") {
      const entry = lookup(url);
      if (entry) {
        const response = cachedBlobResponse(entry.blob, request, init);
        Object.defineProperty(response, "url", { value: url });
        return response;
      }
      if (
        manifest &&
        (state.state === "preparing" || state.state === "ready") &&
        url.startsWith(new URL(".", location.href).href) &&
        /\/(?:films|vendor|fonts|assets)\//.test(new URL(url).pathname)
      )
        return new Response("素材不在当前版本完整缓存中", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        });
    }
    return nativeFetch(request, init);
  };
  window.__FRAME_PREVIEW_ASSET_URL__ = resolve;
  const restoredProperties: (() => void)[] = [];
  const nativeUrl = (value: string, code = false) => {
    if (mode !== "cached") return value;
    try {
      const key = absolute(value),
        hash = new URL(key).hash;
      const mapped =
        (code
          ? (scripts.get(key) ?? scripts.get(key.split("#")[0]))
          : undefined) ?? lookup(key)?.url;
      return mapped ? mapped + hash : value;
    } catch {
      return value;
    }
  };
  for (const [prototype, name, code] of [
    [HTMLImageElement.prototype, "src", false],
    [HTMLMediaElement.prototype, "src", false],
    [HTMLSourceElement.prototype, "src", false],
    [HTMLScriptElement.prototype, "src", true],
    [HTMLLinkElement.prototype, "href", true],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor?.set || !descriptor.configurable) continue;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      set(value: string) {
        // CSS is injected atomically on accepted scene commit.
        const mapped =
          name === "href" && !/\.(?:m?js)(?:[?#]|$)/.test(String(value))
            ? value
            : nativeUrl(String(value), code);
        descriptor.set!.call(this, mapped);
      },
    });
    restoredProperties.push(() =>
      Object.defineProperty(prototype, name, descriptor),
    );
  }
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const attr = name.toLowerCase(),
      tag = this.tagName.toUpperCase();
    const mapped =
      attr === "src" && /^(IMG|AUDIO|VIDEO|SOURCE|SCRIPT)$/.test(tag)
        ? nativeUrl(String(value), tag === "SCRIPT")
        : attr === "href" &&
            tag === "LINK" &&
            /\.(?:m?js)(?:[?#]|$)/.test(String(value))
          ? nativeUrl(String(value), true)
          : (attr === "href" || attr === "xlink:href") &&
              /^(IMAGE|USE)$/.test(tag)
            ? nativeUrl(String(value))
            : attr === "style"
              ? cssUrl(String(value))
              : value;
    return nativeSetAttribute.call(this, name, mapped);
  };
  restoredProperties.push(() => {
    Element.prototype.setAttribute = nativeSetAttribute;
  });
  const cssUrl = (value: string) =>
    mode !== "cached" || disposed
      ? value
      : value.replace(
          /url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g,
          (full, _quote, url: string) => {
            try {
              const entry = lookup(url);
              return entry ? `url("${nativeUrl(url)}")` : full;
            } catch {
              return full;
            }
          },
        );
  // FontFace and dynamic CSS use native networking, outside window.fetch.
  if (NativeFontFace) {
    globalThis.FontFace = class extends NativeFontFace {
      constructor(
        family: string,
        source: string | BufferSource,
        descriptors?: FontFaceDescriptors,
      ) {
        super(
          family,
          typeof source === "string" ? cssUrl(source) : source,
          descriptors,
        );
      }
    };
    restoredProperties.push(() => {
      globalThis.FontFace = NativeFontFace;
    });
  }
  const nativeSetProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
    return nativeSetProperty.call(
      this,
      name,
      value == null ? value : cssUrl(value),
      priority,
    );
  };
  restoredProperties.push(() => {
    CSSStyleDeclaration.prototype.setProperty = nativeSetProperty;
  });
  // Chromium exposes individual CSS properties on each style instance, so
  // prototype setters cannot intercept `element.style.backgroundImage = ...`.
  const styleViews = new WeakMap<CSSStyleDeclaration, CSSStyleDeclaration>();
  for (const prototype of [HTMLElement.prototype, SVGElement.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "style");
    if (!descriptor?.get || !descriptor.configurable) continue;
    Object.defineProperty(prototype, "style", {
      ...descriptor,
      get() {
        const style: CSSStyleDeclaration = descriptor.get!.call(this);
        let view = styleViews.get(style);
        if (!view) {
          const methods = new Map<PropertyKey, unknown>();
          view = new Proxy(style, {
            get(target, key) {
              const value = Reflect.get(target, key, target);
              if (typeof value !== "function") return value;
              if (!methods.has(key)) methods.set(key, value.bind(target));
              return methods.get(key);
            },
            set(target, key, value) {
              return Reflect.set(
                target,
                key,
                typeof value === "string" ? cssUrl(value) : value,
                target,
              );
            },
          });
          styleViews.set(style, view);
        }
        return view;
      },
      ...(descriptor.set
        ? {
            set(value: string) {
              descriptor.set!.call(this, cssUrl(String(value)));
            },
          }
        : {}),
    });
    restoredProperties.push(() =>
      Object.defineProperty(prototype, "style", descriptor),
    );
  }
  // SVG href is an SVGAnimatedString rather than an HTML src property.
  const svgViews = new WeakMap<SVGAnimatedString, SVGAnimatedString>();
  for (const prototype of [
    SVGImageElement.prototype,
    SVGUseElement.prototype,
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "href");
    if (!descriptor?.get || !descriptor.configurable) continue;
    Object.defineProperty(prototype, "href", {
      ...descriptor,
      get() {
        const href: SVGAnimatedString = descriptor.get!.call(this);
        let view = svgViews.get(href);
        if (!view) {
          view = new Proxy(href, {
            get(target, key) {
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
            set(target, key, value) {
              return Reflect.set(
                target,
                key,
                key === "baseVal" ? nativeUrl(String(value)) : value,
                target,
              );
            },
          });
          svgViews.set(href, view);
        }
        return view;
      },
    });
    restoredProperties.push(() =>
      Object.defineProperty(prototype, "href", descriptor),
    );
  }
  const workerControl = "frame-preview-cache-" + crypto.randomUUID();
  const activeWorkers = new Set<Worker>();
  const workerMappings = () =>
    Object.fromEntries([...byUrl].map(([key, entry]) => [key, entry.url]));
  const updateWorkers = () => {
    const message = {
      [workerControl]: true,
      cached: mode === "cached",
      mappings: workerMappings(),
      semantics: Object.fromEntries(semanticUrls),
    };
    for (const worker of activeWorkers) worker.postMessage(message);
  };
  const workerPrefix = () => {
    const mappings = workerMappings();
    return (
      "self.__FRAME_LIVE_ASSET_BASE__=" +
      JSON.stringify(new URL(".", location.href).href) +
      ";" +
      "let __frameCached=" +
      JSON.stringify(mode === "cached") +
      ";let __frameCache=" +
      JSON.stringify(mappings) +
      ";let __frameSemantics=" +
      JSON.stringify(Object.fromEntries(semanticUrls)) +
      ";self.__FRAME_PREVIEW_MEDIA_MODE__=__frameCached?'cached':'original';" +
      "self.addEventListener('message',e=>{if(e.data?.[" +
      JSON.stringify(workerControl) +
      "]!==true)return;e.stopImmediatePropagation();__frameCached=e.data.cached;__frameCache=e.data.mappings;__frameSemantics=e.data.semantics;self.__FRAME_PREVIEW_MEDIA_MODE__=__frameCached?'cached':'original';});" +
      "const __frameResolve=u=>{const key=new URL(String(u),self.__FRAME_LIVE_ASSET_BASE__).href;return (__frameCached&&(__frameCache[key]||__frameCache[key.split('#')[0]]))||u;};" +
      'self.__FRAME_PREVIEW_ASSET_URL__=u=>{if(!__frameCached)return u;const original=new URL(String(u),self.__FRAME_LIVE_ASSET_BASE__),canonical=__frameSemantics[original.href]||__frameSemantics[original.href.split("#")[0]];if(!canonical||original.search)return u;const current=new URL(canonical);current.hash=original.hash;return current.href;};const __frameFetch=self.fetch.bind(self);self.fetch=(u,o)=>{if(!__frameCached)return __frameFetch(u,o);const key=new URL(String(u instanceof Request?u.url:u),self.__FRAME_LIVE_ASSET_BASE__).href,mapped=__frameResolve(key);if(mapped===key&&key.startsWith(self.__FRAME_LIVE_ASSET_BASE__)&&/\\/(films|vendor|fonts|assets)\\//.test(new URL(key).pathname))return Promise.resolve(new Response("素材不在当前版本缓存中",{status:404}));return __frameFetch(u instanceof Request?new Request(mapped,u):mapped,o);};' +
      "const __frameScripts=self.importScripts.bind(self);self.importScripts=(...u)=>__frameScripts(...u.map(__frameResolve));"
    );
  };
  const workerTarget = (url: string | URL, options?: WorkerOptions) => {
    const key = absolute(String(url));
    const cached =
      mode === "cached"
        ? (workerUrls.get(key) ?? workerUrls.get(key.split("#")[0]))
        : undefined;
    if (cached) return { url: cached, owned: false };
    // Wrap this preview's workers before a mode switch too: SDK worker pools survive scenes.
    if (
      !key.startsWith("blob:") &&
      !key.startsWith(new URL(".", location.href).href)
    )
      return { url, owned: false };
    // SDKs such as Pixi generate workers from Blob source, outside the module manifest.
    // Install the same cache resolver before loading their original worker code.
    const source =
      workerPrefix() +
      (options?.type === "module"
        ? "const __frameMessages=[];const __frameQueue=e=>{e.stopImmediatePropagation();__frameMessages.push(e);};self.addEventListener('message',__frameQueue);await import(" +
          JSON.stringify(String(url)) +
          ");self.removeEventListener('message',__frameQueue);for(const e of __frameMessages)self.dispatchEvent(new MessageEvent('message',{data:e.data,ports:e.ports,origin:e.origin}));"
        : "importScripts(" + JSON.stringify(String(url)) + ");");
    return {
      url: blobUrl(new Blob([source], { type: "application/javascript" })),
      owned: true,
    };
  };
  globalThis.Worker = class extends NativeWorker {
    private cachedBootstrap?: string;
    constructor(url: string | URL, options?: WorkerOptions) {
      const target = workerTarget(url, options);
      try {
        super(target.url, options);
      } catch (error) {
        if (target.owned) {
          URL.revokeObjectURL(String(target.url));
          ownedUrls.delete(String(target.url));
        }
        throw error;
      }
      if (target.owned) this.cachedBootstrap = String(target.url);
      if (
        target.owned ||
        (mode === "cached" && workerUrls.has(absolute(String(url))))
      ) {
        activeWorkers.add(this);
        this.postMessage({
          [workerControl]: true,
          cached: mode === "cached",
          mappings: workerMappings(),
          semantics: Object.fromEntries(semanticUrls),
        });
      }
    }
    terminate() {
      activeWorkers.delete(this);
      super.terminate();
      if (this.cachedBootstrap) {
        URL.revokeObjectURL(this.cachedBootstrap);
        ownedUrls.delete(this.cachedBootstrap);
        this.cachedBootstrap = undefined;
      }
    }
  };
  window.__FRAME_PREVIEW_WORKER__ = (url, options) =>
    mode === "cached" &&
    (workerUrls.has(absolute(String(url))) ||
      lookup(String(url)) ||
      new URL(String(url), location.href).protocol === "blob:")
      ? new globalThis.Worker(url, options)
      : undefined;
  // The bundler delegate must distinguish a cached worker from an unavailable mapping.
  const workletPrototype =
    typeof AudioWorklet !== "undefined" ? AudioWorklet.prototype : undefined;
  const addModule = workletPrototype?.addModule;
  if (workletPrototype && addModule)
    workletPrototype.addModule = function (url, options) {
      return addModule.call(
        this,
        mode === "cached" ? nativeUrl(String(url), true) : url,
        options,
      );
    };
  const loadResource = async (
    resource: Resource,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ) => {
    const old = byHash.get(resource.sha256);
    if (old) {
      progress(resource.bytes);
      return old;
    }
    let result: BrokerResult;
    if (parent !== window) {
      try {
        result = await broker<BrokerResult>(
          {
            op: "resource",
            revision: manifest!.revision,
            path: resource.path,
            sha256: resource.sha256,
          },
          signal,
          progress,
        );
      } catch (error) {
        signal.throwIfAborted();
        // Open previews and test hosts may have no Studio parent; provide a visible memory-only fallback.
        if (!String(error).includes("缓存桥不可用")) throw error;
        result = (await loadPreviewResource(
          { ...resource, url: absolute(resource.originalUrl) },
          { signal, progress, cacheStorage: null, fetcher: nativeFetch },
        )) as BrokerResult;
        result.warning = "当前预览没有连接工作台缓存桥，素材缓存只在此页面保留";
      }
    } else {
      result = (await loadPreviewResource(
        { ...resource, url: absolute(resource.originalUrl) },
        { signal, progress, cacheStorage: null, fetcher: nativeFetch },
      )) as BrokerResult;
      result.warning = "独立安全预览仅在此页面保留缓存；从工作台打开可持久保存";
    }
    if (result.warning) emit({ warning: result.warning });
    const entry = {
      blob: result.blob,
      url: blobUrl(result.blob),
      persistent: result.persistent,
    };
    byHash.set(resource.sha256, entry);
    return entry;
  };
  const getResource = async (
    resource: Resource,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ) => {
    let pending = pendingResources.get(resource.sha256);
    if (!pending || pending.signal.aborted) {
      pending = { task: loadResource(resource, signal, progress), signal };
      pendingResources.set(resource.sha256, pending);
      const owned = pending;
      void owned.task
        .finally(() => {
          if (pendingResources.get(resource.sha256) === owned)
            pendingResources.delete(resource.sha256);
        })
        .catch(() => {});
    }
    const value = await pending.task;
    signal.throwIfAborted();
    progress(resource.bytes);
    return value;
  };
  const rewrite = (code: string, resource: Resource) => {
    const original = absolute(resource.url);
    return rewritePreviewCode(code, original, (url: string) => {
      const entry = lookup(url);
      if (!entry) return undefined;
      // Imports retain singleton modules through import maps. Other resources retain
      // their filename/query/hash so SDKs can select the correct loader.
      return /\.(?:m?js)$/.test(new URL(url).pathname) ? url : resolve(url);
    });
  };
  const prepareCode = async (resources: Resource[], signal: AbortSignal) => {
    const imports: Record<string, string> = {};
    for (const resource of resources.filter((r) =>
      /\.(?:m?js)$/.test(r.path),
    )) {
      signal.throwIfAborted();
      const code = await byHash.get(resource.sha256)!.blob.text(),
        transformed = rewrite(code, resource);
      const previous = compiled.get(resource.sha256);
      const url =
        previous && previous.code === transformed
          ? previous.url
          : blobUrl(
              new Blob([transformed], { type: "application/javascript" }),
            );
      if (previous && previous.url !== url)
        retiredUrls.push({ url: previous.url, revision: manifest!.revision });
      compiled.set(resource.sha256, { code: transformed, url });
      for (const key of aliases(resource)) {
        if (!mappedImports.has(key)) {
          imports[key] = url;
          mappedImports.add(key);
        }
        scripts.set(key, url);
        originals.set(key, transformed);
      }
    }
    if (Object.keys(imports).length) {
      if (!HTMLScriptElement.supports?.("importmap"))
        throw Error(
          "当前浏览器不支持完整代码缓存，请使用新版 Chromium 或切换原始素材模式",
        );
      const map = document.createElement("script");
      map.type = "importmap";
      map.textContent = JSON.stringify({ imports });
      document.head.append(map);
    }
    // Worker globals own their resolver; parent fetch patches do not leak into a worker.
    for (const resource of resources.filter(
      (r) =>
        /\.(?:m?js)$/.test(r.path) &&
        (!manifest?.moduleGraph?.[r.path] || /worker/i.test(r.path)),
    )) {
      const prefix = workerPrefix(),
        code = originals.get(absolute(resource.url))!,
        source = prefix + code;
      const previous = compiledWorkers.get(resource.sha256);
      const url =
        previous && previous.code === source
          ? previous.url
          : blobUrl(new Blob([source], { type: "application/javascript" }));
      if (previous && previous.url !== url)
        retiredUrls.push({ url: previous.url, revision: manifest!.revision });
      compiledWorkers.set(resource.sha256, { code: source, url });
      for (const key of aliases(resource)) workerUrls.set(key, url);
    }
    const styles: HTMLStyleElement[] = [];
    for (const resource of resources.filter((r) => /\.css$/.test(r.path))) {
      const css = await byHash.get(resource.sha256)!.blob.text(),
        original = absolute(resource.url);
      const style = document.createElement("style");
      style.textContent = css.replace(
        /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g,
        (full, _quote, value) => {
          try {
            const entry = lookup(absolute(value.trim(), original));
            return entry ? 'url("' + entry.url + '")' : full;
          } catch {
            return full;
          }
        },
      );
      styles.push(style);
    }
    pendingStyles = styles;
  };
  return {
    state: () => structuredClone(state),
    mode: () => mode,
    setMode(value: PreviewMediaMode) {
      if (!validPreviewMode(value)) throw Error("未知预览模式");
      mode = value;
      updateWorkers();
      window.__FRAME_PREVIEW_MEDIA_MODE__ = value;
      abort?.abort();
      abort = undefined;
      emit({
        state: "idle",
        revision: undefined,
        totalBytes: 0,
        downloadedBytes: 0,
        completeFiles: 0,
        persistentFiles: 0,
        totalFiles: 0,
        remaining: [],
        error: undefined,
        warning: undefined,
      });
    },
    async prepare(next: LivePreviewManifest, signal: AbortSignal) {
      manifest = next;
      if (mode !== "cached") return;
      if (!next.resources.length) throw Error("服务器尚未提供完整资源清单");
      abort?.abort();
      const controller = (abort = new AbortController()),
        combined = AbortSignal.any([signal, controller.signal]);
      const resources = [...next.resources].sort((a, b) => a.bytes - b.bytes),
        progress = new Map<string, number>(),
        done = new Set<string>();
      emit({
        state: "downloading",
        revision: next.revision,
        totalBytes: resources.reduce((sum, r) => sum + r.bytes, 0),
        downloadedBytes: 0,
        totalFiles: resources.length,
        completeFiles: 0,
        persistentFiles: 0,
        error: undefined,
        warning: undefined,
        remaining: resources.map((r) => ({
          path: r.path,
          bytes: r.bytes,
          downloadedBytes: 0,
          state: "queued",
        })),
      });
      if (parent !== window) {
        try {
          const storage = await broker<PreviewCacheState["storage"]>(
            { op: "estimate", revision: next.revision },
            combined,
          );
          emit({
            storage,
            ...(storage?.quota !== undefined &&
            state.totalBytes > storage.quota - (storage.usage ?? 0)
              ? {
                  warning:
                    "所需素材可能超过剩余持久缓存空间，下载后将尽量使用当前页面缓存；可清理本作品缓存",
                }
              : {}),
          });
        } catch {
          combined.throwIfAborted();
        }
      }
      let index = 0,
        failure: unknown,
        persistent = 0;
      // Only one large file transfers at once; small modules remain responsive.
      let largeTail: Promise<unknown> = Promise.resolve();
      const worker = async () => {
        while (index < resources.length && !failure) {
          const resource = resources[index++],
            row = state.remaining.find((r) => r.path === resource.path)!;
          row.state = "downloading";
          emit({}, false);
          const run = async () => {
            const entry = await getResource(resource, combined, (bytes) => {
              progress.set(resource.path, bytes);
              row.downloadedBytes = bytes;
              emit(
                {
                  downloadedBytes: [...progress.values()].reduce(
                    (a, b) => a + b,
                    0,
                  ),
                },
                false,
              );
            });
            combined.throwIfAborted();
            for (const key of aliases(resource)) {
              byUrl.set(key, entry);
              semanticUrls.set(key, absolute(resource.originalUrl));
            }
            byUrl.set(entry.url, entry);
            done.add(resource.path);
            if (entry.persistent) persistent++;
            emit({
              completeFiles: done.size,
              persistentFiles: persistent,
              remaining: state.remaining.filter(
                (r) => r.path !== resource.path,
              ),
            });
          };
          try {
            if (resource.bytes > 32 * 1024 * 1024) {
              const task = largeTail.catch(() => {}).then(run);
              largeTail = task;
              await task;
            } else await run();
          } catch (error) {
            if (!combined.aborted) {
              failure = error;
              row.state = "error";
              row.error = String(error);
              emit({ state: "error", error: String(error) }, true);
              controller.abort(error);
            }
            throw error;
          }
        }
      };
      try {
        await Promise.all(
          Array.from({ length: Math.min(3, resources.length) }, worker),
        );
        combined.throwIfAborted();
        await prepareCode(resources, combined);
        updateWorkers();
        emit({
          state: "preparing",
          downloadedBytes: state.totalBytes,
          remaining: [],
        });
      } catch (error) {
        if (
          abort === controller &&
          state.state !== "error" &&
          state.state !== "cancelled" &&
          !disposed
        )
          emit({
            state:
              controller.signal.aborted && !signal.aborted
                ? "cancelled"
                : "error",
            error: signal.aborted ? undefined : String(error),
          });
        throw error;
      }
    },
    committed() {
      if (mode !== "cached") return;
      activeStyles.forEach((style) => style.remove());
      activeStyles = pendingStyles;
      pendingStyles = [];
      activeStyles.forEach((style) => document.head.append(style));
      previousHashes = acceptedHashes;
      acceptedHashes = new Set(
        manifest?.resources.map((resource) => resource.sha256),
      );
      const retained = new Set([...acceptedHashes, ...previousHashes]);
      for (const [hash, entry] of byHash)
        if (!retained.has(hash)) {
          byHash.delete(hash);
          URL.revokeObjectURL(entry.url);
          ownedUrls.delete(entry.url);
          for (const [url, value] of byUrl)
            if (value === entry) byUrl.delete(url);
        }
      for (const store of [compiled, compiledWorkers])
        for (const [hash, value] of store)
          if (!retained.has(hash)) {
            store.delete(hash);
            URL.revokeObjectURL(value.url);
            ownedUrls.delete(value.url);
          }
      for (const store of [scripts, originals, workerUrls, semanticUrls])
        for (const key of store.keys()) if (!byUrl.has(key)) store.delete(key);
      for (let index = retiredUrls.length - 1; index >= 0; index--)
        if (retiredUrls[index].revision < (manifest?.revision ?? 0) - 1) {
          const [{ url }] = retiredUrls.splice(index, 1);
          URL.revokeObjectURL(url);
          ownedUrls.delete(url);
        }
      emit({ state: "ready" });
      if (parent !== window && manifest)
        void broker(
          { op: "prune", revision: manifest.revision },
          AbortSignal.timeout(30000),
        ).catch(() => {});
    },
    failed(error: unknown) {
      if (mode === "cached") emit({ state: "error", error: String(error) });
    },
    cancel() {
      abort?.abort(new DOMException("缓存已取消", "AbortError"));
      emit({ state: "cancelled" });
    },
    async clear() {
      abort?.abort();
      if (manifest && parent !== window)
        await broker(
          { op: "clear", revision: manifest.revision },
          AbortSignal.timeout(30000),
        );
      else {
        try {
          await globalThis.caches?.delete(PREVIEW_CACHE_NAME);
        } catch {
          /* Opaque standalone preview has no durable storage. */
        }
      }
      for (const entry of byHash.values()) entry.persistent = false;
      emit({
        persistentFiles: 0,
        warning: "本作品持久缓存已清理；当前页面仍可播放，离开后需要重新缓存",
      });
    },
    async waitReady(timeoutMs = 300000) {
      if (mode !== "cached") throw Error("先切换到完整缓存模式");
      if (
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 30 * 60000
      )
        throw Error("等待时间必须在 1 到 1800000 毫秒之间");
      const deadline = Date.now() + timeoutMs;
      while (state.state !== "ready" || state.revision !== manifest?.revision) {
        if (mode !== "cached") throw Error("已离开完整缓存模式");
        if (disposed) throw Error("预览已关闭");
        if (state.state === "error" || state.state === "cancelled")
          throw Error(state.error || "缓存已取消");
        if (Date.now() > deadline) throw Error("等待完整缓存超时");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return structuredClone(state);
    },
    dispose() {
      disposed = true;
      abort?.abort();
      restoredProperties.forEach((restore) => restore());
      globalThis.fetch = nativeFetch;
      globalThis.Worker = NativeWorker;
      if (workletPrototype && addModule) workletPrototype.addModule = addModule;
      delete window.__FRAME_PREVIEW_ASSET_URL__;
      delete window.__FRAME_PREVIEW_WORKER__;
      for (const worker of activeWorkers) worker.terminate();
      activeWorkers.clear();
      for (const url of ownedUrls) URL.revokeObjectURL(url);
      activeStyles.forEach((style) => style.remove());
    },
  };
}
declare global {
  interface Window {
    __FRAME_PREVIEW_MEDIA_MODE__?: PreviewMediaMode;
    __FRAME_PREVIEW_ASSET_URL__?: (url: string) => string;
    __FRAME_PREVIEW_WORKER__?: (
      url: string | URL,
      options?: WorkerOptions,
    ) => Worker | undefined;
  }
}
