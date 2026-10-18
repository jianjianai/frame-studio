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
/** A browser on the user's computer linked through the FRAME 连接器 extension. */
export interface BrowserComputer {
  id: string;
  name: string;
  online: boolean;
  lastSeen: string | null;
  /** How many repositories it is linked to. */
  repos: number;
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
 * A repository's browser: its tabs and downloads as the server announces them (its events reach
 * every page). One copy per repository for the page, loaded when the first component asks.
 */
type BrowserState = { tabs: BrowserTabInfo[]; downloads: BrowserDownload[]; computers: BrowserComputer[]; remoteTabs: BrowserTabInfo[] };
const EMPTY: BrowserState = { tabs: [], downloads: [], computers: [], remoteTabs: [] };
const states = new Map<string, BrowserState>();
const watchers = new Set<() => void>();
const loaded = new Set<string>();
let listening = false;
const set = (repo: string, change: Partial<BrowserState>) => {
  states.set(repo, { ...(states.get(repo) ?? EMPTY), ...change });
  watchers.forEach((watcher) => watcher());
};
const load = (repo: string) =>
  api<BrowserState>(`/api/browser/${encodeURIComponent(repo)}`).then(
    (state) => set(repo, { tabs: state.tabs, downloads: state.downloads, computers: state.computers ?? [], remoteTabs: state.remoteTabs ?? [] }),
    () => {},
  );
function start(repo: string) {
  if (!listening) {
    listening = true;
    subscribe((event) => {
      const repo = event.repo as string;
      if (event.type === "browser-tabs") set(repo, { tabs: event.tabs as BrowserTabInfo[] });
      if (event.type === "browser-downloads") set(repo, { downloads: event.downloads as BrowserDownload[] });
      if (event.type === "browser-computer") set(repo, { computers: event.computers as BrowserComputer[], remoteTabs: event.tabs as BrowserTabInfo[] });
    });
    // The studio restarted (the browsers with it): what they have now.
    onConnection((connected) => connected && loaded.forEach((repo) => void load(repo)));
  }
  if (loaded.has(repo)) return;
  loaded.add(repo);
  void load(repo);
}
export function useBrowserState(repo: string) {
  return useSyncExternalStore(
    (watcher) => {
      start(repo);
      watchers.add(watcher);
      return () => void watchers.delete(watcher);
    },
    () => states.get(repo) ?? EMPTY,
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

/** API base of a repository's browser. */
export const browserPath = (repo: string) => `/api/browser/${encodeURIComponent(repo)}`;
/** Tell the AI that asked that the user logged in (a message in its conversation); x… tabs are on the user's computer. */
export const loginDone = (repo: string, tab: string) =>
  api<{ ok: true; notified: boolean }>(`${browserPath(repo)}/${tab.startsWith("x") ? "remote-tabs" : "tabs"}/${encodeURIComponent(tab)}/login-done`, { method: "POST" });
/** Bring a tab of the user's computer to the front there. */
export const focusRemote = (repo: string, tab: string) => api(`${browserPath(repo)}/remote-tabs/${encodeURIComponent(tab)}/focus`, { method: "POST" });
