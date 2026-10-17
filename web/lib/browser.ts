import { useSyncExternalStore } from "react";
import { api, onConnection, subscribe } from "./api";

/** A tab of the studio's logged-in browser (server/browser.mjs). */
export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  owner: "ai" | "user";
  loading: boolean;
  /** The AI used it in the last seconds. */
  ai: boolean;
  /** The AI asked the user to log in here. */
  login: { host: string; reason: string } | null;
}
export interface BrowserDownload {
  id: string;
  name: string;
  url: string;
  tab: string;
  state: "downloading" | "done" | "failed";
  size: number;
  error?: string;
  at: number;
}

/**
 * The browser's tabs and downloads as the server announces them (its events reach every page):
 * one copy for the page, loaded when the first component asks.
 */
let state: { tabs: BrowserTabInfo[]; downloads: BrowserDownload[] } = { tabs: [], downloads: [] };
const watchers = new Set<() => void>();
let started = false;
function start() {
  if (started) return;
  started = true;
  const set = (change: Partial<typeof state>) => {
    state = { ...state, ...change };
    watchers.forEach((watcher) => watcher());
  };
  subscribe((event) => {
    if (event.type === "browser-tabs") set({ tabs: event.tabs as BrowserTabInfo[] });
    if (event.type === "browser-downloads") set({ downloads: event.downloads as BrowserDownload[] });
  });
  const load = () =>
    api<typeof state>("/api/browser").then(
      (loaded) => set({ tabs: loaded.tabs, downloads: loaded.downloads }),
      () => {},
    );
  void load();
  // The studio restarted (the browser with it): what it has now.
  onConnection((connected) => connected && void load());
}
export function useBrowserState() {
  return useSyncExternalStore(
    (watcher) => {
      start();
      watchers.add(watcher);
      return () => void watchers.delete(watcher);
    },
    () => state,
  );
}

/**
 * Which browser tab the 浏览器 editor tab should show next (a login the AI asked for): kept
 * until an open viewer takes it, so it works whether the editor tab is open already or not.
 */
let wanted: string | null = null;
const wanters = new Set<(tab: string) => void>();
export function showBrowserTab(tab: string) {
  wanted = tab;
  wanters.forEach((listener) => listener(tab));
}
export function takeWantedTab() {
  const tab = wanted;
  wanted = null;
  return tab;
}
export function onWantedTab(listener: (tab: string) => void) {
  wanters.add(listener);
  return () => void wanters.delete(listener);
}

/** Tell the AI that asked that the user logged in (a message in its conversation). */
export const loginDone = (tab: string) => api<{ ok: true; notified: boolean }>(`/api/browser/tabs/${encodeURIComponent(tab)}/login-done`, { method: "POST" });
