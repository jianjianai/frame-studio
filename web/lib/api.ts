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
  const response = await fetch(path, init);
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

function connect() {
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
  socket.onopen = () => {
    connected = true;
    statusListeners.forEach((listener) => listener(true));
    for (const message of queue) socket?.send(message);
    queue = [];
  };
  socket.onmessage = (message) => {
    const event = JSON.parse(message.data) as ServerEvent;
    listeners.forEach((listener) => listener(event));
  };
  socket.onclose = () => {
    if (connected) statusListeners.forEach((listener) => listener(false));
    connected = false;
    setTimeout(connect, 1500);
  };
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
