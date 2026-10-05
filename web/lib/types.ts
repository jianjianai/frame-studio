export interface WorkSummary {
  id: string;
  repo: string;
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  accent: string;
  status: string;
  poster: string;
  updatedAt: string;
  openedAt?: string;
  location: "local" | "remote" | "both" | "trash";
  checkedOut: boolean;
  error?: string;
}

export interface Repo {
  id: string;
  name: string;
  remote: string;
  account: string;
  createdAt: string;
  fetchedAt?: string;
  ready: boolean;
}

export interface Subtitle {
  start: number;
  end: number;
  text: string;
}
export interface Beat {
  at: number;
  id?: string;
  title: string;
  detail: string;
}

export interface VisualClip {
  id: string;
  name?: string;
  source: { kind: string; src?: string; module?: string; engine?: string; color?: string; frames?: string[] };
  start: number;
  duration: number;
  hidden?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  [key: string]: unknown;
}

export interface WorkInfo {
  id: string;
  repo: string;
  branch: string;
  slug: string;
  root: string;
  dir: string;
  meta: null | {
    title: string;
    subtitle: string;
    description: string;
    renderer: string;
    composition?: { width: number; height: number };
    duration: number;
    fps: number;
    beats: Beat[];
    subtitles: Subtitle[];
    visual?: { background: string; clips: VisualClip[] };
    audioDocument?: AudioDocument;
  };
  loads: Record<string, string> | null;
  metaError: string | null;
  preview: { module: string; assetBase: string };
}

export interface AudioDocument {
  schemaVersion: 1;
  sources: { id: string; kind: "file" | "generated"; src?: string; module?: string }[];
  tracks: { id: string; name: string; gain: number; pan: number; muted: boolean; processors?: { type: string; track?: string }[]; [key: string]: unknown }[];
  clips: {
    id: string;
    track: string;
    source: string;
    name?: string;
    start: number;
    duration: number;
    offset: number;
    gain: number;
    muted: boolean;
    fadeIn: number;
    fadeOut: number;
    rate?: number;
    [key: string]: unknown;
  }[];
  buses: unknown[];
  master: { gain: number };
}

export interface FileEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
  mtime?: number;
  kind?: string;
}

export interface Asset {
  path: string;
  url: string;
  kind: string;
  mime: string;
  size: number;
  duration?: number;
  width?: number;
  height?: number;
}

export interface Problem {
  severity: "error" | "warning";
  source: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
}
export interface CheckResult {
  ok: boolean;
  checkedAt: string;
  ms: number;
  problems: Problem[];
  console: string[];
}

export interface WorkStatus {
  branch: string;
  ahead: number;
  behind: number;
  upstream: string;
  files: { path: string; status: string }[];
  head: { commit: string; message: string; date: string } | null;
  remote: boolean;
}

export interface Version {
  commit: string;
  short: string;
  message: string;
  date: string;
  author: string;
  stat?: string;
}

export interface Task {
  id: string;
  kind: string;
  title: string;
  work?: string;
  status: "running" | "done" | "failed" | "cancelled";
  progress: number | null;
  message: string;
  error: string | null;
  result: unknown;
  startedAt: string;
}

export interface PlaybackSnapshot {
  time: number;
  playing: boolean;
  buffering: boolean;
  rate: number;
  loop: boolean;
  volume: number;
  muted: boolean;
}

export interface StageStatus {
  status: "loading" | "ready" | "error";
  error?: string;
  updating?: boolean;
  revision: number;
  project?: {
    id: string;
    title: string;
    duration: number;
    fps: number;
    width: number;
    height: number;
    tracks: { id: string; name: string; kind: string }[];
    beats: Beat[];
    subtitles: Subtitle[];
  };
}
