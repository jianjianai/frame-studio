import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { problem } from "./security.mjs";

/** One native shell subscription per FRAME process. Thread history is read only in bounded pages. */
export class AiClient extends EventEmitter {
  constructor({ data, url = process.env.FRAME_T3_URL || "http://127.0.0.1:3773", tokenFile,
    fetch: fetcher = globalThis.fetch, WebSocket: Socket = WebSocket } = {}) {
    super(); this.url = new URL(url); this.tokenFile = tokenFile || path.join(data, "ai/t3/frame-service-token");
    this.fetcher = fetcher; this.Socket = Socket; this.projects = new Map(); this.threads = new Map();
    this.requests = new Map(); this.terminals = new Map(); this.terminalsReady = false;
    this.sequence = 0; this.ready = false; this.closed = false; this.pending = null; this.socket = null;
  }
  async token() {
    const value = (await fs.readFile(this.tokenFile, "utf8").catch(() => { throw problem(503, "T3 服务正在启动，请稍后重试"); })).trim();
    if (!value || value.length > 8192 || /[\r\n\x00]/.test(value)) throw problem(503, "T3 服务登录凭据无效");
    return value;
  }
  async request(route, { method = "GET", body, signal } = {}) {
    const response = await this.fetcher(new URL(route, this.url), { method, signal: signal || AbortSignal.timeout(15000),
      headers: { authorization: "Bearer " + await this.token(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw problem(response.status === 404 ? 404 : 503, "T3 原生服务暂不可用（" + response.status + "）");
    return response.json();
  }
  apply(item) {
    if (item.kind === "snapshot") {
      const snapshot = item.snapshot;
      this.projects = new Map(snapshot.projects.map(project => [project.id, project]));
      this.threads = new Map(snapshot.threads.map(thread => [thread.id, thread]));
      this.sequence = snapshot.snapshotSequence; this.ready = true;
    } else if (item.sequence > this.sequence) {
      if (item.kind === "project-upserted") this.projects.set(item.project.id, item.project);
      else if (item.kind === "project-removed") this.projects.delete(item.projectId);
      else if (item.kind === "thread-upserted") this.threads.set(item.thread.id, item.thread);
      else if (item.kind === "thread-removed") this.threads.delete(item.threadId);
      this.sequence = item.sequence;
    }
    if (item.kind !== "synchronized") this.emit("change", item);
  }
  async connect() {
    if (this.closed) throw problem(503, "T3 客户端已关闭");
    if (this.ready && this.terminalsReady && this.socket?.readyState === 1) return;
    if (this.pending) return this.pending;
    const operation = this.open(); this.pending = operation;
    try { await operation; } finally { if (this.pending === operation) this.pending = null; }
  }
  async open() {
    // A single lightweight snapshot primes the shared cache. Reconnects replay from its sequence.
    if (!this.ready) this.apply({ kind: "snapshot", snapshot: await this.request("/api/orchestration/shell") });
    const { ticket } = await this.request("/api/auth/websocket-ticket", { method: "POST" });
    const url = new URL("/ws", this.url); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.searchParams.set("wsTicket", ticket);
    const socket = new this.Socket(url, { maxPayload: 16 * 1024 * 1024 }); this.socket = socket;
    this.terminalsReady = false;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.terminate(); reject(problem(503, "T3 原生订阅连接超时")); }, 15000);
      const fail = () => { clearTimeout(timeout); reject(problem(503, "T3 原生订阅连接失败")); };
      socket.once("error", fail);
      socket.once("open", () => { clearTimeout(timeout); socket.off("error", fail);
        socket.send(JSON.stringify({ _tag: "Request", id: "frame-shell", tag: "orchestration.subscribeShell",
          payload: { afterSequence: this.sequence, requestCompletionMarker: true }, headers: [] })); resolve(); });
    });
    let synchronized, synchronizationFailed;
    const synchronization = new Promise((resolve, reject) => { synchronized = resolve; synchronizationFailed = reject; });
    const synchronizationTimeout = setTimeout(() => synchronizationFailed(problem(503, "T3 原生终端状态同步超时")), 15000);
    socket.on("message", data => {
      try {
        const decoded = JSON.parse(data.toString());
        for (const item of Array.isArray(decoded) ? decoded : [decoded]) {
          if (item._tag === "Chunk" && item.requestId === "frame-shell") {
            for (const value of item.values) this.apply(value);
            socket.send(JSON.stringify({ _tag: "Ack", requestId: item.requestId }));
          } else if (item._tag === "Chunk" && item.requestId === "frame-terminals") {
            for (const value of item.values) {
              if (value.type === "snapshot") {
                this.terminals = new Map(value.terminals.map(terminal => [JSON.stringify([terminal.threadId, terminal.terminalId]), terminal]));
                this.terminalsReady = true; synchronized();
              } else if (value.type === "upsert") this.terminals.set(JSON.stringify([value.terminal.threadId, value.terminal.terminalId]), value.terminal);
              else if (value.type === "remove") this.terminals.delete(JSON.stringify([value.threadId, value.terminalId]));
              this.emit("terminal", value);
            }
            socket.send(JSON.stringify({ _tag: "Ack", requestId: item.requestId }));
          } else if (item._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
          else if (item._tag === "Exit") {
            if (item.requestId === "frame-shell" || item.requestId === "frame-terminals") {
              this.terminalsReady = false; synchronizationFailed(problem(503, "T3 原生状态订阅已结束")); socket.close();
            }
            else { const request = this.requests.get(String(item.requestId));
              if (request) { this.requests.delete(String(item.requestId)); clearTimeout(request.timer);
                if (item.exit?._tag === "Success") request.resolve(item.exit.value);
                else request.reject(problem(503, "T3 原生请求失败")); }
            }
          }
        }
      } catch { socket.close(1002, "Invalid native protocol"); }
    });
    socket.on("error", () => {});
    socket.once("close", () => { this.terminalsReady = false; synchronizationFailed(problem(503, "T3 连接已断开"));
      if (this.socket === socket) this.socket = null; for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(problem(503, "T3 连接已断开")); }
      this.requests.clear(); this.emit("disconnect"); });
    clearInterval(this.ping); this.ping = setInterval(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ _tag: "Ping" })); }, 20000); this.ping.unref();
    socket.send(JSON.stringify({ _tag: "Request", id: "frame-terminals", tag: "subscribeTerminalMetadata", payload: {}, headers: [] }));
    try { await synchronization; } catch (error) { socket.terminate(); throw error; }
    finally { clearTimeout(synchronizationTimeout); }
  }
  async rpc(tag, payload = {}) {
    await this.connect();
    const id = String(++this.requestId || (this.requestId = 1));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(problem(503, "T3 原生请求超时")); }, 15000);
      this.requests.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }
  async config() { return this.rpc("server.getConfig"); }
  async shell() { await this.connect(); return { projects: [...this.projects.values()], threads: [...this.threads.values()],
    terminals: [...this.terminals.values()], terminalsReady: this.terminalsReady, snapshotSequence: this.sequence }; }
  async dispatch(command) { const result = await this.request("/api/orchestration/dispatch", { method: "POST", body: command }); return result; }
  async detail(threadId, { turnLimit = 1, beforeCursor, signal } = {}) {
    if (!Number.isInteger(turnLimit) || turnLimit < 1 || turnLimit > 100) throw Error("Invalid native history page size");
    const route = "/api/orchestration/threads/" + encodeURIComponent(threadId) + "?turnLimit=" + turnLimit + (beforeCursor ? "&beforeCursor=" + encodeURIComponent(beforeCursor) : "");
    return this.request(route, { signal });
  }
  close() { this.closed = true; clearInterval(this.ping); this.socket?.terminate(); this.socket = null; this.removeAllListeners(); }
}
