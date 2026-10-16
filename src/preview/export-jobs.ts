/**
 * Local exports: rendered by this browser and kept in its own file system (the Origin Private
 * File System), nothing goes to the server. Shared by the export page (src/preview/export.ts,
 * which renders) and the studio (web/lib/exports.ts, which starts, lists, pauses and downloads).
 * One folder per export:
 *
 *   frame-exports/<id>/job.json      what to export and how far it got
 *   frame-exports/<id>/v-<n>.webm    segment n: its pictures
 *   frame-exports/<id>/a-<n>.pcm     segment n: its sound (16-bit stereo, 48 kHz)
 *   frame-exports/<id>/output.webm   the finished video (the segments are removed then)
 *
 * The page rendering an export holds the Web Lock `frame-export:<id>`: an export marked
 * running whose lock nobody holds was interrupted. Pages tell each other what happens on the
 * BroadcastChannel `frame-exports`.
 */
export interface ExportOptions {
  width: number;
  fps: number;
  start?: number;
  end?: number;
  subtitles: boolean;
  /** A module of the work played on its own (a sample, e.g. sheets/x.ts) instead of the film. */
  scene?: string;
}

export interface ExportPlan {
  start: number;
  end: number;
  fps: number;
  width: number;
  height: number;
  frames: number;
  duration: number;
  /** Frames per segment. */
  segmentFrames: number;
  segments: number;
  /** The work has sound. */
  audio: boolean;
}

export type ExportStatus = "queued" | "running" | "paused" | "failed" | "changed" | "done";

export interface ExportJob {
  id: string;
  repo: string;
  work: string;
  title: string;
  options: ExportOptions;
  /** The work's files (names, sizes, times) the finished segments were made from. */
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  status: ExportStatus;
  error?: string;
  plan?: ExportPlan;
  codec?: "vp9" | "vp8";
  /** Indexes of the finished segments. */
  done: number[];
  /** Size of the finished segments. */
  bytes: number;
  /** Rendering so far, over every session: the pace for the time left until a session has measured its own. */
  stats: { frames: number; ms: number };
  /** Starts that ended without finishing a segment (each finished one clears it): from two on, no automatic resume. */
  stalls: number;
  output?: { name: string; size: number; finishedAt: string };
}

/** What the page rendering an export reports, a few times a second. */
export interface ExportProgress {
  id: string;
  phase: "loading" | "rendering" | "joining";
  /** Frames rendered (loading, rendering) or segments joined (joining). */
  done: number;
  total: number;
  /** Frames per second, once known. */
  fps: number | null;
  /** Seconds left, once known. */
  eta: number | null;
}

export type ExportMessage =
  | { type: "job"; job: ExportJob }
  | { type: "progress"; progress: ExportProgress }
  /** The export and its files are gone (cancelled, or removed after it finished). */
  | { type: "removed"; id: string }
  /** The page that rendered it has stopped (paused, failed, done or cancelled). */
  | { type: "stopped"; id: string }
  /** Another page holds the export's lock. */
  | { type: "busy"; id: string }
  /** For the page rendering it, from a studio in another tab. */
  | { type: "command"; id: string; command: "pause" | "cancel" };

export const EXPORT_CHANNEL = "frame-exports";
export const exportLock = (id: string) => `frame-export:${id}`;
export const SEGMENT_SECONDS = 4;

/** WebCodecs, the browser's file system and Web Locks: secure contexts (https, localhost) of current Chrome, Edge, Firefox. */
export const localExportSupported = () =>
  typeof window !== "undefined" &&
  window.isSecureContext &&
  typeof VideoEncoder !== "undefined" &&
  Boolean(navigator.storage?.getDirectory) &&
  "locks" in navigator &&
  typeof FileSystemFileHandle !== "undefined" &&
  "createWritable" in FileSystemFileHandle.prototype;

async function root() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle("frame-exports", { create: true });
}

export async function jobFolder(id: string, create = false) {
  return (await root()).getDirectoryHandle(id, { create });
}

export async function readJob(id: string): Promise<ExportJob> {
  const file = await fileOf(await jobFolder(id), "job.json");
  return JSON.parse(await file.text()) as ExportJob;
}

export async function listJobs(): Promise<ExportJob[]> {
  const jobs: ExportJob[] = [];
  for await (const [name, handle] of (await root()).entries()) {
    if (handle.kind !== "directory") continue;
    try {
      jobs.push(await readJob(name));
    } catch {
      // Not an export (yet): its job.json is written first, so only a crash at creation leaves this.
    }
  }
  return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveJob(job: ExportJob): Promise<ExportJob> {
  const saved = { ...job, updatedAt: new Date().toISOString() };
  await writeFile(await jobFolder(job.id, true), "job.json", JSON.stringify(saved));
  return saved;
}

/** Written to a swap file and committed on close: a page that stops midway leaves the file as it was. */
export async function writeFile(folder: FileSystemDirectoryHandle, name: string, data: BufferSource | Blob | string) {
  const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

export async function fileOf(folder: FileSystemDirectoryHandle, name: string) {
  return (await folder.getFileHandle(name)).getFile();
}

/** The segments of an export (after it finished, or to start it over). */
export async function removeSegments(id: string) {
  const folder = await jobFolder(id);
  const names: string[] = [];
  for await (const name of folder.keys()) if (/^[va]-\d+\.(webm|pcm)$/.test(name)) names.push(name);
  for (const name of names) await folder.removeEntry(name).catch(() => {});
}

export async function removeJob(id: string) {
  await (await root()).removeEntry(id, { recursive: true }).catch(() => {});
}
