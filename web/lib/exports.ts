import { useSyncExternalStore } from "react";
import { api, formatBytes, subscribe, workPath } from "./api";
import type { Task, WorkInfo } from "./types";
import {
  EXPORT_CHANNEL,
  exportLock,
  fileOf,
  jobFolder,
  listJobs,
  localExportSupported,
  readJob,
  removeJob,
  removeSegments,
  saveJob,
  type ExportJob,
  type ExportMessage,
  type ExportOptions,
  type ExportProgress,
} from "../../src/preview/export-jobs";

/**
 * The exports the studio shows (the export status in the bottom-left corner, the export tab):
 * local ones, rendered by this browser and kept in its own storage (src/preview/export-jobs.ts),
 * and the server's MP4 exports (tasks). A local export runs in a hidden frame of whichever
 * studio page is open, whatever it shows: switching tabs, views or works, or going home, does
 * not stop it. One that stopped with its page (closed, reloaded, crashed) goes on when the
 * studio opens again, or when another studio tab sees that page go; paused and failed ones
 * wait for the user.
 */
export interface LocalExport extends ExportJob {
  progress: ExportProgress | null;
  /** Rendered by this page. */
  here: boolean;
  /** Rendered by another tab of this browser. */
  elsewhere: boolean;
  /** In this page's queue. */
  waiting: boolean;
}

export interface ExportsState {
  /** This browser can export locally. */
  supported: boolean;
  local: LocalExport[];
  /** Server exports running, and those that ended while the studio was open (until dismissed). */
  server: Task[];
}

/** A finished local export stays in the browser this long (it was downloaded when it finished). */
const KEEP_DONE_MS = 7 * 24 * 3600 * 1000;
/** A page asked to stop may finish its frame for this long before its frame is removed. */
const STOP_GRACE_MS = 10000;
/** An export page that loaded but says nothing for this long is given up. */
const SILENT_PAGE_MS = 30000;

interface Active {
  id: string;
  frame: HTMLIFrameElement;
  heard: boolean;
  timer?: number;
}

let state: ExportsState = { supported: false, local: [], server: [] };
const listeners = new Set<() => void>();
const jobs = new Map<string, ExportJob>();
const progress = new Map<string, ExportProgress>();
const elsewhere = new Set<string>();
const watching = new Set<string>();
const server = new Map<string, Task>();
let queue: string[] = [];
let active: Active | null = null;
let starting = false;
let channel: BroadcastChannel | null = null;
let initialized = false;

function publish() {
  const local = [...jobs.values()].map((job) => ({
    ...job,
    progress: progress.get(job.id) ?? null,
    here: active?.id === job.id,
    elsewhere: elsewhere.has(job.id) && active?.id !== job.id,
    waiting: queue.includes(job.id),
  }));
  state = { ...state, local, server: [...server.values()] };
  for (const listener of listeners) listener();
}

export function useExports() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => state,
  );
}

/** Start following exports (once, after signing in): server tasks, and this browser's local exports. */
export function initExports() {
  if (initialized) return;
  initialized = true;
  void api<Task[]>("/api/tasks").then(
    (tasks) => {
      for (const task of tasks) if (task.kind === "export" && task.status === "running" && !server.has(task.id)) server.set(task.id, task);
      publish();
    },
    () => {},
  );
  subscribe((event) => {
    if (event.type === "work-moved") return void moved(String(event.work), String(event.from), String(event.to));
    if (event.type !== "task") return;
    const task = event.task as Task;
    if (task.kind !== "export") return;
    if (task.status === "cancelled") server.delete(task.id);
    else if (task.status === "running" || server.has(task.id)) server.set(task.id, task);
    publish();
  });
  if (!localExportSupported()) return publish();
  state = { ...state, supported: true };
  channel = new BroadcastChannel(EXPORT_CHANNEL);
  channel.onmessage = (event: MessageEvent<ExportMessage>) => receive(event.data);
  void scan();
}

/** Why this browser cannot export locally. */
export function unsupportedReason() {
  return window.isSecureContext
    ? "这个浏览器不支持本机导出，请用较新的 Chrome、Edge 或 Firefox"
    : "本机导出需要用 https 或 localhost 地址打开 FRAME（浏览器只在安全连接里提供视频编码和本地存储）";
}

/** The exports kept in this browser; interrupted ones are resumed. */
async function scan() {
  let list: ExportJob[];
  try {
    list = await listJobs();
  } catch {
    return;
  }
  const held = await heldLocks();
  for (const job of list) {
    if (job.status === "done" && Date.now() - Date.parse(job.output?.finishedAt ?? job.updatedAt) > KEEP_DONE_MS) {
      await removeJob(job.id);
      continue;
    }
    jobs.set(job.id, job);
    if (held.has(exportLock(job.id))) {
      elsewhere.add(job.id);
      watch(job.id);
    } else if (resumable(job)) enqueue(job.id);
    // A page closed right after finishing leaves segments behind.
    if (job.status === "done") void removeSegments(job.id).catch(() => {});
  }
  publish();
  pump();
}

/** Marked running (or queued) but rendered nowhere: it goes on by itself, unless it keeps stopping before a segment is done. */
const resumable = (job: ExportJob) => (job.status === "running" || job.status === "queued") && job.stalls < 2;

async function heldLocks() {
  const snapshot = await navigator.locks.query();
  return new Set((snapshot.held ?? []).flatMap((lock) => (lock.name ? [lock.name] : [])));
}

/** An export another tab renders: when that tab's page goes (closed, crashed), its lock is released and this tab takes over. */
function watch(id: string) {
  if (watching.has(id)) return;
  watching.add(id);
  void navigator.locks.request(exportLock(id), { mode: "shared" }, async () => {
    watching.delete(id);
    elsewhere.delete(id);
    progress.delete(id);
    const job = await readJob(id).catch(() => null);
    if (!job) jobs.delete(id);
    else {
      jobs.set(id, job);
      if (resumable(job) && active?.id !== id) enqueue(id);
    }
    publish();
    pump();
  });
}

function receive(message: ExportMessage) {
  if (message.type === "job") {
    const { job } = message;
    jobs.set(job.id, job);
    if (active?.id === job.id) active.heard = true;
    else if (job.status === "running") {
      elsewhere.add(job.id);
      queue = queue.filter((id) => id !== job.id);
      watch(job.id);
    }
    if (job.status !== "running") progress.delete(job.id);
  } else if (message.type === "progress") {
    progress.set(message.progress.id, message.progress);
    if (active?.id === message.progress.id) active.heard = true;
  } else if (message.type === "removed") {
    jobs.delete(message.id);
    progress.delete(message.id);
    elsewhere.delete(message.id);
    queue = queue.filter((id) => id !== message.id);
  } else if (message.type === "stopped") {
    progress.delete(message.id);
    elsewhere.delete(message.id);
    if (active?.id === message.id) void finish(active);
  } else if (message.type === "busy" && active?.id === message.id) {
    elsewhere.add(message.id);
    watch(message.id);
    void finish(active);
  }
  publish();
}

function enqueue(id: string) {
  if (active?.id !== id && !queue.includes(id)) queue.push(id);
}

/** One local export at a time per page: they share the GPU. */
function pump() {
  if (active || starting) return;
  const id = queue.shift();
  if (!id) return publish();
  starting = true;
  void start(id).finally(() => {
    starting = false;
    pump();
  });
}

async function start(id: string) {
  const job = await readJob(id).catch(() => null);
  if (!job) {
    jobs.delete(id);
    return publish();
  }
  jobs.set(id, job);
  if (job.status !== "queued" && job.status !== "running") return publish();
  if ((await heldLocks()).has(exportLock(id))) {
    elsewhere.add(id);
    watch(id);
    return publish();
  }
  // The work is loaded from where the server has it now; it may have moved since the export began.
  let work: WorkInfo;
  try {
    work = await api<WorkInfo>(workPath(job.repo, job.work));
  } catch (error) {
    return settle({ ...job, status: "failed", error: "打不开作品：" + (error as Error).message });
  }
  // Segments made from other files would not fit together: ask before mixing them.
  if (job.done.length && (await fingerprintOf(job.repo, job.work).catch(() => job.fingerprint)) !== job.fingerprint)
    return settle({ ...job, status: "changed" });
  const query = new URLSearchParams({ job: id, module: work.preview.module, assetBase: work.preview.assetBase });
  const frame = document.createElement("iframe");
  frame.title = "本机导出";
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  // Out of sight but laid out: the page draws on a canvas of its own, the frame's size does not matter.
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  frame.src = `/preview/export.html?${query}`;
  const entry: Active = { id, frame, heard: false };
  active = entry;
  frame.addEventListener("load", () => {
    window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => {
      if (active === entry && !entry.heard) void giveUp(entry, "failed", "导出页面没有响应，请重试");
    }, SILENT_PAGE_MS);
  });
  document.body.append(frame);
  publish();
}

/** The page has stopped: what it left in job.json says how (done, paused, failed, removed). */
async function finish(entry: Active) {
  if (active !== entry) return;
  active = null;
  window.clearTimeout(entry.timer);
  entry.frame.remove();
  const job = await readJob(entry.id).catch(() => null);
  if (!job) jobs.delete(entry.id);
  else jobs.set(entry.id, job);
  publish();
  // Finished by this page: download it, as an export in the browser always did.
  if (job?.status === "done") void downloadLocal(entry.id).catch(() => {});
  pump();
}

/** The page does not answer: remove it and record the outcome for it. */
async function giveUp(entry: Active, outcome: "paused" | "failed" | "cancelled", error?: string) {
  if (active !== entry) return;
  active = null;
  window.clearTimeout(entry.timer);
  entry.frame.remove();
  progress.delete(entry.id);
  if (outcome === "cancelled") await forget(entry.id);
  else {
    const job = await readJob(entry.id).catch(() => null);
    if (job && job.status !== "done") await settle({ ...job, status: outcome, error, stalls: 0 });
  }
  pump();
}

async function settle(job: ExportJob) {
  const saved = await saveJob(job);
  jobs.set(saved.id, saved);
  channel?.postMessage({ type: "job", job: saved } satisfies ExportMessage);
  publish();
}

async function forget(id: string) {
  await removeJob(id);
  jobs.delete(id);
  progress.delete(id);
  elsewhere.delete(id);
  queue = queue.filter((item) => item !== id);
  channel?.postMessage({ type: "removed", id } satisfies ExportMessage);
  publish();
}

/** Ask the page rendering an export (here or in another tab) to stop. */
/** A work moved to another repository: its local exports load it from there (one rendering now blocked the move). */
async function moved(work: string, from: string, to: string) {
  for (const job of [...jobs.values()])
    if (job.work === work && job.repo === from)
      try {
        jobs.set(job.id, await saveJob({ ...job, repo: to }));
      } catch {}
  publish();
}

function command(id: string, which: "pause" | "cancel") {
  channel?.postMessage({ type: "command", id, command: which } satisfies ExportMessage);
  const entry = active;
  if (entry?.id !== id) return;
  window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => void giveUp(entry, which === "cancel" ? "cancelled" : "paused"), STOP_GRACE_MS);
}

/** The work's files (names, sizes, times): a resumed export says when they changed. */
async function fingerprintOf(repo: string, id: string) {
  const files = await api<{ path: string; type: string; size?: number; mtime?: number }[]>(`${workPath(repo, id)}/tree`);
  const text = JSON.stringify(files.filter((file) => file.type === "file").map((file) => [file.path, file.size, Math.round(file.mtime ?? 0)]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Room for the segments and the finished copy, judged from the bitrate the export encodes at. */
async function ensureSpace(work: WorkInfo, options: ExportOptions, seconds: number) {
  await navigator.storage.persist?.().catch(() => false);
  const estimate = await navigator.storage.estimate().catch(() => null);
  if (!estimate?.quota) return;
  const size = work.meta?.composition ?? { width: 1920, height: 1080 };
  const pixels = options.width * Math.round((options.width * size.height) / size.width);
  const videoBits = 1.2e7 * Math.pow(pixels / (1920 * 1080), 0.95);
  const needed = (seconds * (videoBits + 48000 * 32) * 2) / 8;
  const free = estimate.quota - (estimate.usage ?? 0);
  if (free < needed)
    throw new Error(`浏览器的存储空间不够：这次导出约需 ${formatBytes(needed)}，还能用 ${formatBytes(free)}。清理磁盘或移除不用的本机导出后再试`);
}

/** Queue a local export of the work as it is now. */
export async function startLocalExport(work: WorkInfo, options: ExportOptions) {
  if (!state.supported) throw new Error(unsupportedReason());
  const duration = work.meta?.duration ?? 0;
  const from = options.start ?? 0;
  const to = options.end ?? duration;
  if (!(to > from) || from < 0 || to > duration + 1e-6) throw new Error(`导出范围无效：作品长 ${duration} 秒，开始时间要小于结束时间`);
  await ensureSpace(work, options, to - from);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await settle({
    id,
    repo: work.repo,
    work: work.id,
    title: work.meta?.title ?? work.id,
    options,
    fingerprint: await fingerprintOf(work.repo, work.id),
    createdAt: now,
    updatedAt: now,
    status: "queued",
    done: [],
    bytes: 0,
    stats: { frames: 0, ms: 0 },
    stalls: 0,
  });
  enqueue(id);
  publish();
  pump();
}

export async function pauseLocal(id: string) {
  if (active?.id === id || elsewhere.has(id)) return command(id, "pause");
  queue = queue.filter((item) => item !== id);
  const job = jobs.get(id);
  if (job && job.status !== "done") await settle({ ...job, status: "paused", stalls: 0 });
}

/** Go on with a paused, failed or interrupted export; for one whose work changed, with the work as it is now. */
export async function resumeLocal(id: string) {
  const job = jobs.get(id) ?? (await readJob(id));
  const fingerprint = job.status === "changed" ? await fingerprintOf(job.repo, job.work) : job.fingerprint;
  await settle({ ...job, status: "queued", error: undefined, stalls: 0, fingerprint });
  enqueue(id);
  pump();
}

/** Throw away what is done and start again (with the work as it is now). */
export async function restartLocal(id: string) {
  const job = jobs.get(id) ?? (await readJob(id));
  await removeSegments(id);
  await settle({
    ...job,
    status: "queued",
    error: undefined,
    plan: undefined,
    codec: undefined,
    done: [],
    bytes: 0,
    stats: { frames: 0, ms: 0 },
    stalls: 0,
    output: undefined,
    fingerprint: await fingerprintOf(job.repo, job.work),
  });
  enqueue(id);
  pump();
}

/** Stop and delete an export, or remove a finished one from the browser. */
export async function removeLocal(id: string) {
  queue = queue.filter((item) => item !== id);
  if (active?.id === id || elsewhere.has(id)) return command(id, "cancel");
  await forget(id);
}

export async function downloadLocal(id: string) {
  const job = jobs.get(id);
  if (!job?.output) return;
  const file = await fileOf(await jobFolder(id), "output.webm").catch(() => {
    throw new Error("浏览器里已经没有这个视频了（浏览器的存储可能被清理过），请重新导出");
  });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = job.output.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function dismissServer(id: string) {
  server.delete(id);
  publish();
}

// ---- for display -------------------------------------------------------------

/** Frames of the finished segments. */
export function framesDone(job: ExportJob) {
  const plan = job.plan;
  if (!plan) return 0;
  return job.done.reduce((sum, index) => sum + Math.min(plan.frames, (index + 1) * plan.segmentFrames) - index * plan.segmentFrames, 0);
}

/** 0–1 for a local export: rendering is most of it, joining the segments the last bit. */
export function localRatio(job: LocalExport) {
  if (job.status === "done") return 1;
  const live = job.progress;
  if (live?.phase === "joining") return 0.98 + 0.02 * (live.done / Math.max(1, live.total));
  const total = job.plan?.frames ?? live?.total ?? 0;
  if (!total) return 0;
  return (0.98 * (live?.phase === "rendering" ? live.done : framesDone(job))) / total;
}

/** "45 秒", "3 分 20 秒", "12 分钟", "1 小时 5 分". */
export function formatEta(seconds: number) {
  const total = Math.max(1, Math.round(seconds));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 10) return total % 60 ? `${minutes} 分 ${total % 60} 秒` : `${minutes} 分钟`;
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`;
}

/** The clock time an export with `seconds` left finishes at. */
export const finishClock = (seconds: number) => new Date(Date.now() + seconds * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
