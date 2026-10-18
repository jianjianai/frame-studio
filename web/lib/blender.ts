import { useSyncExternalStore } from "react";
import { api, onConnection, subscribe } from "./api";

/** What a linked Blender says about itself (the AB to T add-on, server/blender.mjs). */
export interface BlenderState {
  blender: string | null;
  addon: string | null;
  file: string | null;
  /** The shot open there: its work ("<repo>/<id>") and path in the work. */
  shot: { work: string; path: string } | null;
  live: boolean;
  dirty: boolean;
  uploading: number;
  conflict: { work: string; path: string; message: string } | null;
  error: string | null;
  /** The last things done there for the AI. */
  activity: string[];
}
/** A Blender on the user's computer linked to a repository. */
export interface BlenderLink {
  id: string;
  name: string;
  online: boolean;
  lastSeen: string | null;
  repos: number;
  state: BlenderState | null;
}

/** The Blenders linked to a repository, as the server announces them (one copy per repository for the page). */
const states = new Map<string, BlenderLink[]>();
const watchers = new Set<() => void>();
const loaded = new Set<string>();
const EMPTY: BlenderLink[] = [];
let listening = false;
const set = (repo: string, links: BlenderLink[]) => {
  states.set(repo, links);
  watchers.forEach((watcher) => watcher());
};
const load = (repo: string) =>
  api<{ links: BlenderLink[] }>(blenderPath(repo)).then(
    (state) => set(repo, state.links),
    () => {},
  );
function start(repo: string) {
  if (!listening) {
    listening = true;
    subscribe((event) => event.type === "blender" && set(event.repo as string, event.links as BlenderLink[]));
    onConnection((connected) => connected && loaded.forEach((repo) => void load(repo)));
  }
  if (loaded.has(repo)) return;
  loaded.add(repo);
  void load(repo);
}
export function useBlenderLinks(repo: string) {
  return useSyncExternalStore(
    (watcher) => {
      start(repo);
      watchers.add(watcher);
      return () => void watchers.delete(watcher);
    },
    () => states.get(repo) ?? EMPTY,
  );
}

export const blenderPath = (repo: string) => `/api/blender/${encodeURIComponent(repo)}`;
/** Open a shot of a work (`abt/<shot>.json`) in the repository's Blender. */
export const openInBlender = (repo: string, work: string, shot: string, reimport = false) =>
  api<{ message: string }>(`${blenderPath(repo)}/open`, { body: { work, shot, reimport } });
/** Whether a file of a work (path in its project folder) is an AB to T shot. */
export const isShot = (path: string) => /^abt\/[^/]+\.json$/.test(path);
