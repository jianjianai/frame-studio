import { useEffect, useState } from "react";

/**
 * This browser draws for the AI's render tools (preview_frames, work_check timing,
 * preview_motion, and asset_view for files of the work it keeps) on its GPU: the server has none, and its software renderer takes seconds for
 * a 3D frame. The server drives this page the way it drives its headless browser — open a page,
 * wait for it, evaluate a function in it (server/render-gpu.mjs) — and this page does that in
 * hidden frames of /preview/render.html or asset.html, the pages the headless browser loads.
 */

const CHOICE = "frame:gpu-render";

/**
 * Where the AI's frames are drawn for this person, chosen per browser: "auto" — on a computer
 * that has the work open (this one when it can draw), or "server" — never on this device, and
 * the conversations written here draw on the server too.
 */
export function renderChoice(): "auto" | "server" {
  try {
    if (localStorage.getItem(CHOICE) === "off") return "server";
  } catch {}
  return "auto";
}

export function setRenderChoice(choice: "auto" | "server") {
  try {
    localStorage.setItem(CHOICE, choice === "server" ? "off" : "on");
  } catch {}
  void report();
  changed();
}

/** What this page tells the server: draws ("gpu"), chose the server, or cannot draw (a phone or tablet, no GPU). */
export function renderMode(): "gpu" | "server" | "none" {
  if (renderChoice() === "server") return "server";
  return graphicsCard() && matchMedia("(any-pointer: fine)").matches ? "gpu" : "none";
}

let card: string | null | undefined;
/** The graphics card WebGL draws with; null when there is none worth drawing on (software rendering). */
export function graphicsCard() {
  if (card !== undefined) return card;
  card = null;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return card;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    if (/SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(name)) return card;
    // "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)" → the card.
    const angle = /^ANGLE \([^,]*, (.*?)(?:, [^,]*)?\)$/.exec(name);
    card =
      (angle ? angle[1] : name)
        .replace(/^ANGLE Metal Renderer: /, "")
        .replace(/\s*\(0x[0-9a-f]+\)/i, "")
        .replace(/\s+(Direct3D|OpenGL|vs_\d).*$/, "")
        .trim() || name;
  } catch {}
  return card;
}

type Page = { frame: HTMLIFrameElement; loads: number; reloaded: Set<(error: Error) => void> };
const pages = new Map<string, Page>();
let socket: WebSocket | null = null;
let started = false;
let working = 0;
const listeners = new Set<() => void>();
let lingering = 0;
let drawing = false;
const changed = () => listeners.forEach((listener) => listener());

/** Tell the server about this page once it is signed in (what it has open, whether it draws). */
export function initGpuRender() {
  if (started) return;
  started = true;
  connect();
  document.addEventListener("visibilitychange", report);
  // The workbench changes the address when another work opens.
  window.addEventListener("popstate", () => void report());
  window.setInterval(() => void report(), 60000);
  for (const type of ["pointerdown", "keydown", "focus"]) window.addEventListener(type, active, { capture: true, passive: true });
  window.addEventListener("message", relay);
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/render/gpu`);
  socket = ws;
  ws.onopen = () => report(true);
  ws.onmessage = (message) => void handle(ws, JSON.parse(message.data));
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    closeAll();
    window.setTimeout(() => !socket && connect(), 3000);
  };
}

/**
 * Which page draws (server/render-gpu.mjs pick): one with the work open, of the sign-in writing
 * in the AI's conversation first, then another page of that sign-in; then one in view, then the
 * one used last.
 */
function report(active: unknown = false) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const mode = renderMode();
  const work = /^\/work\/([^/]+)\/([^/]+)/.exec(location.pathname);
  socket.send(
    JSON.stringify({
      type: "state",
      mode,
      gpu: mode === "gpu" ? graphicsCard() : null,
      work: work ? `${decodeURIComponent(work[1])}/${decodeURIComponent(work[2])}` : null,
      visible: document.visibilityState === "visible",
      active: active === true,
    }),
  );
}
let lastActive = 0;
function active() {
  if (Date.now() - lastActive < 10000) return;
  lastActive = Date.now();
  report(true);
}

async function handle(ws: WebSocket, message: { id: number; op: string; page?: string; [key: string]: unknown }) {
  let reply: Record<string, unknown>;
  const drawing = message.op !== "ping" && message.op !== "close";
  if (drawing) busy(1);
  try {
    reply = { type: "result", id: message.id, ok: true, value: await run(message) };
  } catch (error) {
    reply = { type: "result", id: message.id, ok: false, error: describe(error), timeout: (error as Error)?.name === "TimeoutError" };
  } finally {
    if (drawing) busy(-1);
  }
  await reported(message.page);
  // Frames are large: compressed, a 1280-pixel PNG in base64 shrinks back to about its size.
  const data = await new Response(new Blob([JSON.stringify(reply ?? null)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

async function run(message: { op: string; page?: string; [key: string]: unknown }): Promise<unknown> {
  const { op } = message;
  if (op === "ping") return true;
  const id = String(message.page);
  if (op === "goto") return open(id, String(message.url), Number(message.timeout));
  const page = pages.get(id);
  if (op === "close") return void (page && close(id));
  if (!page) throw new Error("Target page has been closed");
  if (op === "load") return loaded(page, Number(message.timeout));
  if (op === "wait") return waitFor(page, String(message.code), message.arg, Number(message.timeout), Number(message.polling));
  if (op === "eval") return evaluate(page, String(message.code), message.arg);
  throw new Error("Unknown operation " + op);
}

/** A hidden frame, laid out the way local exports keep theirs: the page draws on its own canvas. */
function open(id: string, url: string, timeout: number) {
  // The pages the server's headless browser draws with: a work's frames, and media files of it (models…).
  if (!/^\/preview\/(render|asset)\.html\?/.test(url)) throw new Error("Not a render page");
  let page = pages.get(id);
  if (!page) {
    const frame = document.createElement("iframe");
    frame.title = "AI 渲染";
    // The page reports its errors to this one only in a frame of this name (src/preview/report.ts).
    frame.name = "frame-ai-render";
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
    page = { frame, loads: 0, reloaded: new Set() };
    const entry = page;
    // A second load is Vite reloading the page: calls running in the old one never finish.
    frame.addEventListener("load", () => {
      if (entry.loads++) for (const reject of entry.reloaded) reject(new Error("Execution context was destroyed, most likely because of a navigation"));
    });
    pages.set(id, page);
    hold();
    frame.src = url;
    document.body.append(frame);
  } else page.frame.src = url;
  return loaded(page, timeout, true);
}

function loaded(page: Page, timeout: number, fresh = false) {
  const doc = page.frame.contentDocument;
  if (!fresh && doc?.readyState === "complete" && doc.location.href !== "about:blank") return Promise.resolve();
  return within(new Promise<void>((resolve) => page.frame.addEventListener("load", () => resolve(), { once: true })), timeout);
}

async function waitFor(page: Page, code: string, arg: unknown, timeout: number, polling: number) {
  const until = Date.now() + timeout;
  for (;;) {
    // Like Playwright's, the wait goes on in the page that replaces one reloading meanwhile.
    const value = await evaluate(page, code, arg).catch((error: Error) => {
      if (!/Execution context was destroyed/.test(error.message)) throw error;
    });
    if (value) return value;
    if (Date.now() > until) throw Object.assign(new Error(`Timeout ${timeout}ms exceeded.`), { name: "TimeoutError" });
    await new Promise((resolve) => window.setTimeout(resolve, polling || 100));
  }
}

/** A function the server wrote for its headless browser's pages, run in the frame's page. */
function evaluate(page: Page, code: string, arg: unknown) {
  const view = page.frame.contentWindow as (Window & { eval(source: string): (arg: unknown) => unknown }) | null;
  if (!view) throw new Error("Target page has been closed");
  let reject!: (error: Error) => void;
  const reloaded = new Promise<never>((_, fail) => (reject = fail));
  page.reloaded.add(reject);
  return Promise.race([Promise.resolve().then(() => view.eval(`(${code})`)(arg)), reloaded]).finally(() => page.reloaded.delete(reject));
}

function within<T>(promise: Promise<T>, timeout: number) {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise<never>(
      (_, reject) => (timer = window.setTimeout(() => reject(Object.assign(new Error(`Timeout ${timeout}ms exceeded.`), { name: "TimeoutError" })), timeout)),
    ),
  ]).finally(() => window.clearTimeout(timer));
}

function close(id: string) {
  pages.get(id)?.frame.remove();
  pages.delete(id);
  if (!pages.size) {
    release?.();
    release = null;
  }
}

function closeAll() {
  for (const id of [...pages.keys()]) close(id);
}

/** What a frame's page reported (errors, console, failed requests), passed on as its page's events. */
function relay(event: MessageEvent) {
  const news = (event.data as { frameRender?: Record<string, unknown> } | null)?.frameRender;
  if (!news || event.origin !== location.origin) return;
  for (const [id, page] of pages)
    if (page.frame.contentWindow === event.source) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "event", page: id, ...news }));
      return;
    }
}

/**
 * What the frame's page saw until now (failed requests, errors) reaches the server before the
 * result: the server reads a call's errors when the result comes, as from its own pages.
 */
async function reported(id: unknown) {
  try {
    (pages.get(String(id))?.frame.contentWindow as { __FRAME_RENDER_FLUSH__?: () => void } | null)?.__FRAME_RENDER_FLUSH__?.();
  } catch {}
  // The frame's messages are queued before this one, so relay has sent them on by the time it arrives.
  await new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = resolve;
    channel.port2.postMessage(null);
  });
}

/** While frames are open, keep this tab from being frozen in the background (as exports do). */
let release: (() => void) | null = null;
function hold() {
  if (!navigator.locks || release) return;
  release = () => {};
  void navigator.locks.request("frame-gpu-render", () => (pages.size ? new Promise<void>((resolve) => (release = resolve)) : undefined));
}

/** Errors the way the server's headless browser words them (its stack is mapped back to the work's files). */
function describe(error: unknown) {
  if (!error || typeof error !== "object" || !("message" in error)) return String(error);
  const { message, stack } = error as Error;
  const text = stack && stack.includes(message) ? stack : `${message}${stack ? "\n" + stack : ""}`;
  return text.replace(/^Error: /, "");
}

function busy(change: number) {
  working += change;
  window.clearTimeout(lingering);
  // Quiet for a moment before saying it stopped: drawing comes in many short calls.
  const now = () => {
    drawing = working > 0;
    changed();
  };
  if (working) now();
  else lingering = window.setTimeout(now, 1500);
}

/** Where the AI's frames are drawn from this device (`mode`, see renderMode), and whether it is drawing right now. */
export function useRenderStatus() {
  const [, update] = useState(0);
  useEffect(() => {
    const listener = () => update((count) => count + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  return { mode: renderMode(), card: graphicsCard(), drawing };
}
