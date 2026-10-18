import { useSyncExternalStore } from "react";
import { api, workPath } from "./api";

/**
 * Asset precache: a service worker (public/frame-sw.js) keeps the open work's files (its
 * public/ folder and the library files it plays) in Cache Storage: those its playback uses as
 * soon as the work opens, so preview playback never waits on the network, the others the
 * first time they are asked for. Needs a secure context (https or localhost); elsewhere it
 * is skipped. The editors open listed files from there too (`useKeptFile`, `keptText`).
 */
export interface PrecacheProgress {
  key: string;
  state: "running" | "done" | "error";
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  error?: string;
}

interface Manifest {
  key: string;
  base: string;
  /** When the server made the list: the worker keeps the newest. */
  at: number;
  /** `lazy`: not used by playback, kept the first time it is asked for. */
  files: { path: string; size: number; version: string; lazy?: true }[];
}

export interface KeptFile {
  /** The work's address of the file with its version: the worker answers it from its cache. */
  url: string;
  version: string;
  size: number;
}

export const precacheSupported = () => window.isSecureContext && "serviceWorker" in navigator;

let worker: Promise<ServiceWorker | null> | null = null;
function activeWorker() {
  worker ??= (async () => {
    if (!precacheSupported()) return null;
    try {
      await navigator.serviceWorker.register("/frame-sw.js");
      const registration = await navigator.serviceWorker.ready;
      // Ask the browser not to evict cached media under storage pressure.
      void navigator.storage?.persist?.().catch(() => {});
      return registration.active;
    } catch (error) {
      console.warn("素材预缓存不可用：", error);
      return null;
    }
  })();
  return worker;
}

/** The latest list of each open work, for the editors. */
interface Entry {
  manifest?: Manifest;
  /** Settles when the list asked for last is known: readers wait for it rather than open an outdated file. */
  pending?: Promise<void>;
  settle?: () => void;
  timer?: number;
  asked: number;
}
const lists = new Map<string, Entry>();
const listeners = new Set<() => void>();
const indexes = new WeakMap<Manifest, Map<string, Manifest["files"][number]>>();

/**
 * Fetch the work's current file list (after `delay`; requests made meanwhile are merged) and
 * send it to the worker, which downloads only missing or changed playback files.
 */
export function requestPrecache(repo: string, id: string, delay = 0) {
  const key = `${repo}/${id}`;
  let entry = lists.get(key);
  if (!entry) lists.set(key, (entry = { asked: 0 }));
  const current = entry;
  const asked = ++current.asked;
  current.pending ??= new Promise<void>((resolve) => (current.settle = resolve));
  window.clearTimeout(current.timer);
  current.timer = window.setTimeout(async () => {
    try {
      const [manifest, sw] = await Promise.all([api<Manifest>(`${workPath(repo, id)}/precache`), activeWorker()]);
      // The worker learns the list before the editors use its versions.
      sw?.postMessage({ type: "precache", ...manifest });
      if (!current.manifest || manifest.at >= current.manifest.at) current.manifest = manifest;
    } catch {
      // The editors read from the server instead.
    } finally {
      if (asked === current.asked) {
        current.settle?.();
        current.pending = current.settle = undefined;
        listeners.forEach((listener) => listener());
      }
    }
  }, delay);
  return current.pending;
}

/** The work is closed: its list is fetched anew when it opens again. */
export function forgetPrecache(repo: string, id: string) {
  const entry = lists.get(`${repo}/${id}`);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  entry.settle?.();
  entry.pending = entry.settle = undefined;
  lists.delete(`${repo}/${id}`);
  listeners.forEach((listener) => listener());
}

function lookup(manifest: Manifest, address: string): KeptFile | null {
  let index = indexes.get(manifest);
  if (!index) indexes.set(manifest, (index = new Map(manifest.files.map((file) => [file.path, file]))));
  const file = index.get(address);
  return file ? { url: `${manifest.base}${address}?v=${encodeURIComponent(file.version)}`, version: file.version, size: file.size } : null;
}

/** The list, "waiting" before the first one is known, null when there is none. */
function snapshot(key: string): Manifest | "waiting" | null {
  const entry = lists.get(key);
  if (!entry) return "waiting";
  return entry.manifest ?? (entry.pending ? "waiting" : null);
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * A listed file of the work (`films/<slug>/…` or `materials/<ref>`) as the browser keeps it
 * (a lazy one from the first time it is asked for); the address changes with the file.
 * Undefined until the work's list is known, null for files that are not kept.
 */
export function useKeptFile(repo: string, id: string, address: string | null): KeptFile | null | undefined {
  const list = useSyncExternalStore(subscribe, () => snapshot(`${repo}/${id}`));
  if (!address || list === null) return null;
  return list === "waiting" ? undefined : lookup(list, address);
}

/** The kept file once the list asked for last is known; null when it is not kept. */
async function keptFile(repo: string, id: string, address: string) {
  const entry = lists.get(`${repo}/${id}`);
  while (entry?.pending) await entry.pending;
  return entry?.manifest ? lookup(entry.manifest, address) : null;
}

/** The most the server reads as text (TEXT_LIMIT in server/files.mjs). */
const TEXT_LIMIT = 2 * 1024 * 1024;

/**
 * A kept text file read from the browser's cache, with the hash the server gives it (SHA-256
 * of the text as UTF-8); `current`: not a library file kept at the version the work locked.
 * Null when it is not kept, the page has no worker, or it is too large for the editor: then it
 * is read from the server.
 */
export async function keptText(repo: string, id: string, address: string, { current = false } = {}) {
  if (!navigator.serviceWorker?.controller || !crypto.subtle) return null;
  const file = await keptFile(repo, id, address);
  if (!file || file.size > TEXT_LIMIT || (current && file.version.startsWith("git-"))) return null;
  const response = await fetch(file.url);
  if (!response.ok) return null;
  // The server reads the file as UTF-8 and keeps a byte order mark.
  const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { content, hash };
}

export function onPrecacheProgress(listener: (progress: PrecacheProgress) => void) {
  if (!precacheSupported()) return () => {};
  const handler = (event: MessageEvent) => {
    if (event.data?.type === "precache") listener(event.data as PrecacheProgress);
  };
  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}
