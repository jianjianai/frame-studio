import { useEffect, useRef } from "react";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Options = { method?: string; body?: unknown; raw?: BodyInit; contentType?: string; signal?: AbortSignal };

/** GET requests sent before the page asks for them (the work page's first one, with /api/state). */
const early = new Map<string, Promise<Response>>();
export function prefetch(path: string) {
  early.set(path, fetch(path));
}

/** JSON API call. Throws ApiError with the server's message. */
export async function api<T = unknown>(path: string, options: Options = {}): Promise<T> {
  const init: RequestInit = { method: options.method || (options.body !== undefined || options.raw ? "POST" : "GET"), signal: options.signal, headers: {} };
  if (options.raw !== undefined) {
    init.body = options.raw;
    (init.headers as Record<string, string>)["Content-Type"] = options.contentType || "application/octet-stream";
  } else if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const sent = init.method === "GET" ? early.get(path) : undefined;
  early.delete(path);
  // An early answer that failed (not signed in yet, say) is asked for again.
  const answered = sent ? await sent.catch(() => null) : null;
  const response = answered?.ok ? answered : await fetch(path, init);
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const error = (data as { error?: { message?: string; code?: string; details?: unknown } })?.error;
    if (response.status === 401 && !path.startsWith("/api/login")) window.dispatchEvent(new Event("frame:unauthorized"));
    throw new ApiError(error?.message || response.statusText, response.status, error?.code || "HTTP", error?.details);
  }
  return data as T;
}

export const del = <T = unknown>(path: string) => api<T>(path, { method: "DELETE" });
export const put = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: "PUT", body });
export const patch = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });

// ---- server events over one shared WebSocket ----
export type ServerEvent = { type: string; [key: string]: unknown };
type Listener = (event: ServerEvent) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let connected = false;
const statusListeners = new Set<(connected: boolean) => void>();
let queue: string[] = [];
/** When the server last said anything (it sends a tick every 20 s). */
let heard = 0;
/** The connection dropped since the page first connected: what happened meanwhile was missed. */
let dropped = false;
let retry: ReturnType<typeof setTimeout> | undefined;

function connect() {
  clearTimeout(retry);
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
  socket = ws;
  ws.onopen = () => {
    connected = true;
    heard = Date.now();
    statusListeners.forEach((listener) => listener(true));
    // Views that keep what live events told them (the chat) load it again.
    if (dropped) listeners.forEach((listener) => listener({ type: "reconnected" }));
    dropped = false;
    for (const message of queue) ws.send(message);
    queue = [];
  };
  ws.onmessage = (message) => {
    heard = Date.now();
    const event = JSON.parse(message.data) as ServerEvent;
    if (event.type === "tick") return;
    listeners.forEach((listener) => listener(event));
  };
  ws.onclose = () => lost(ws);
}

/** The connection is gone: say so once and connect again. */
function lost(ws: WebSocket) {
  if (socket !== ws) return;
  socket = null;
  if (connected) statusListeners.forEach((listener) => listener(false));
  connected = false;
  dropped = true;
  retry = setTimeout(connect, 1500);
}

/**
 * A connection can die without closing (a computer that slept, a changed network, a tab the
 * browser froze): silence longer than a few ticks means it is gone, so it is dropped and made
 * again at once instead of waiting for a close that never comes.
 */
function check(quiet: number) {
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - heard < quiet) return;
  ws.onclose = ws.onmessage = null;
  try {
    ws.close();
  } catch {}
  lost(ws);
  clearTimeout(retry);
  connect();
}
if (typeof window !== "undefined") {
  setInterval(() => check(45000), 10000);
  // Back in front, back online, out of the browser's freezer: check sooner.
  const soon = () => check(25000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && soon());
  document.addEventListener("resume", soon);
  window.addEventListener("online", soon);
  window.addEventListener("pageshow", soon);
}

export function sendEvent(event: ServerEvent) {
  const text = JSON.stringify(event);
  if (socket?.readyState === WebSocket.OPEN) socket.send(text);
  else queue = [...queue.slice(-20), text];
}

export function subscribe(listener: Listener) {
  if (!socket) connect();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function onConnection(listener: (connected: boolean) => void) {
  statusListeners.add(listener);
  return () => void statusListeners.delete(listener);
}

/** Subscribe to server events for the lifetime of a component. */
export function useServerEvent(handler: Listener, deps: unknown[] = []) {
  const ref = useRef(handler);
  ref.current = handler;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => subscribe((event) => ref.current(event)), deps);
}

export const workPath = (repo: string, id: string) => `/api/works/${encodeURIComponent(repo)}/${encodeURIComponent(id)}`;
/** API base of a repository's experience libraries (same file/version endpoints as a work). */
export const experiencePath = (repo: string) => `/api/repos/${encodeURIComponent(repo)}/experience`;
/** API base of a repository's material libraries (history and sync like a work's). */
export const materialsPath = (repo: string) => `/api/repos/${encodeURIComponent(repo)}/materials`;
/** API base of a repository's AI skills (files, and history and sync like a work's). */
export const skillsPath = (repo: string) => `/api/repos/${encodeURIComponent(repo)}/skills`;

/** What a module of the work played on its own is called: its file name (sheets/剪纸.ts → 剪纸). */
export const sampleName = (path: string) => path.replace(/^.*\//, "").replace(/\.[^.]+$/, "");

export function formatTime(seconds: number, precise = true) {
  if (!Number.isFinite(seconds)) return "0:00";
  const sign = seconds < 0 ? "-" : "";
  seconds = Math.abs(seconds);
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return sign + `${m}:${precise ? s.toFixed(2).padStart(5, "0") : Math.floor(s).toString().padStart(2, "0")}`;
}

export function formatBytes(bytes?: number) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function timeAgo(iso?: string) {
  if (!iso) return "";
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`;
  return new Date(iso).toLocaleDateString();
}
