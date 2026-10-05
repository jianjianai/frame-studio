import { api, workPath } from "./api";

/**
 * Asset precache: a service worker (public/frame-sw.js) keeps every public file
 * of the open work in Cache Storage so preview playback never waits on the
 * network. Needs a secure context (https or localhost); elsewhere it is skipped.
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
  base: string;
  files: { path: string; size: number; version: string }[];
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

/** Send the work's current file list; the worker downloads only missing or changed files. */
export async function requestPrecache(repo: string, id: string) {
  const sw = await activeWorker();
  if (!sw) return false;
  const manifest = await api<Manifest>(`${workPath(repo, id)}/precache`);
  sw.postMessage({ type: "precache", key: `${repo}/${id}`, ...manifest });
  return true;
}

export function onPrecacheProgress(listener: (progress: PrecacheProgress) => void) {
  if (!precacheSupported()) return () => {};
  const handler = (event: MessageEvent) => {
    if (event.data?.type === "precache") listener(event.data as PrecacheProgress);
  };
  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}
