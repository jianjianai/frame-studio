import zlib from "node:zlib";
import { promisify } from "node:util";
import { problem, shortId } from "./util.mjs";

const gunzip = promisify(zlib.gunzip);

/** What a page may send at once: a frame drawn at up to 3840 pixels, as compressed JSON. */
export const GPU_SOCKET_PAYLOAD = 64 * 1024 * 1024;
/** A page that does not answer a quick question this soon is asleep or frozen: draw elsewhere. */
const PROBE_MS = 3000;
/** A page heard from this recently is awake: no question first (a round trip saved). */
const HEARD_MS = 5000;
/** No answer to one drawing call for this long: the page is gone for this purpose. */
const CALL_MS = 120000;
/** A page holds its drawing back for playback at most 2 minutes (gpu-render.ts PATIENCE): past this, it counts again. */
const HOLD_MS = 150000;

const gone = (message = "用户电脑上的 FRAME 页面已经关闭或不再响应") => problem(503, message, "GPU_PAGE_GONE");
export const isGone = (error) => error?.code === "GPU_PAGE_GONE";

/**
 * Studio pages open in the user's browsers that draw for the AI's render tools on their GPU:
 * the server has no GPU, and its software renderer takes seconds for a 3D frame. Several people
 * may share the studio's password, so not any page draws for a work: a page that has the work
 * open, or one of the sign-in writing in the AI's conversation — unless that person chose the
 * server in their settings. Each page reports which work it has open and its choice (`mode`:
 * "gpu" draws; "server" never draws, and their conversations draw on the server; "none" cannot
 * draw, a phone or a browser without a GPU). Each page
 * acts as a Playwright browser for `Renderer.openPage` (new context, page, goto, evaluate,
 * waitForFunction, page events), so the renderer's drawing code runs unchanged; the page does
 * it in a hidden frame of /preview/render.html, the page the headless browser loads.
 */
export class GpuBrowsers {
  constructor(services) {
    this.services = services;
    this.browsers = new Map();
    const accept = (ws, req) => this.accept(ws, req);
    services.sockets?.set("/api/render/gpu", Object.assign(accept, { maxPayload: GPU_SOCKET_PAYLOAD }));
  }

  accept(ws, req) {
    const principal = this.services.auth.identify(req);
    // A person's studio page only: drawn frames are what the AI is shown.
    if (!["session", "local"].includes(principal?.kind) || !principal.login) return ws.close(4003, "forbidden");
    const browser = new RemoteBrowser(ws, principal.login);
    this.browsers.set(browser.id, browser);
    ws.on("close", () => this.browsers.delete(browser.id));
  }

  /**
   * The page to draw on for work `repo`/`work` in a conversation `login` writes in (none for
   * other callers): first a page with the work open — of that sign-in before others' — then
   * another page of that sign-in (not with `opened`: only a page with the work open keeps its
   * files); among them the one in view, then the one used last. One that does not answer at
   * once (a sleeping laptop, a frozen tab) is passed over. Null: draw on the server, also when
   * the one writing chose the server.
   */
  async pick({ login, repo, work, opened = false } = {}) {
    const pages = [...this.browsers.values()].filter((browser) => !browser.closed);
    if (login && pages.some((browser) => browser.login === login && browser.mode === "server")) return null;
    const open = repo && work ? `${repo}/${work}` : null;
    const rank = (browser) => (open && browser.work === open ? 2 : 0) + (login && browser.login === login ? 1 : 0);
    const ready = pages.filter((browser) => browser.mode === "gpu" && browser.gpu && rank(browser) >= (opened ? 2 : 1));
    ready.sort((a, b) => rank(b) - rank(a) || Number(b.visible) - Number(a.visible) || b.activeAt - a.activeAt);
    for (const browser of ready) {
      if (Date.now() - browser.heardAt < HEARD_MS) return browser;
      const answers = await browser
        .call({ op: "ping" }, PROBE_MS)
        .then(() => true)
        .catch(() => false);
      if (answers) return browser;
    }
    return null;
  }
}

class RemoteBrowser {
  constructor(ws, login) {
    this.id = shortId();
    this.ws = ws;
    this.login = login;
    this.mode = "none"; // "gpu" | "server" | "none", as the page last said
    this.work = null; // "repo/id" of the work the page has open
    this.calls = new Map();
    this.pages = new Map();
    this.next = 0;
    this.gpu = null; // the graphics card the page reported; null until it says hello
    this.visible = false;
    this.activeAt = 0;
    this.heardAt = 0;
    this.closed = false;
    this.waitingSince = 0; // while the page holds the AI's drawing back for its playing preview
    this.waited = 0;
    let alive = true;
    ws.on("pong", () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 15000);
    ping.unref?.();
    ws.on("close", () => {
      clearInterval(ping);
      clearTimeout(this.holdTimer);
      this.closed = true;
      for (const call of this.calls.values()) call.reject(gone());
      this.calls.clear();
    });
    ws.on("message", (raw, binary) => void this.receive(raw, binary).catch(() => {}));
  }

  async receive(raw, binary) {
    this.heardAt = Date.now();
    // Results come compressed (frames are large); the page's own news as plain JSON.
    const message = JSON.parse(binary ? await gunzip(raw) : raw);
    if (message.type === "state") {
      this.gpu = message.gpu ? String(message.gpu).slice(0, 200) : null;
      this.mode = ["gpu", "server"].includes(message.mode) ? message.mode : "none";
      this.work = typeof message.work === "string" ? message.work.slice(0, 300) : null;
      this.visible = Boolean(message.visible);
      if (message.active) this.activeAt = Date.now();
    } else if (message.type === "waiting") this.hold(Boolean(message.waiting));
    else if (message.type === "event") this.pages.get(message.page)?.emit(message);
    else if (message.type === "result") {
      const call = this.calls.get(message.id);
      if (!call) return;
      this.calls.delete(message.id);
      if (message.ok) call.resolve(message.value);
      else call.reject(Object.assign(new Error(message.error), message.timeout ? { name: "TimeoutError" } : {}));
    }
  }

  /** How long this page has held the AI's drawing back for its playing preview, so far (ms). */
  waitedMs() {
    return this.waited + (this.waitingSince ? Date.now() - this.waitingSince : 0);
  }

  /**
   * The page waits to load or draw while the person plays a preview in it (web/lib/gpu-render.ts
   * standBy): no call times out meanwhile, and their time runs on when it goes on.
   */
  hold(waiting) {
    if (waiting === Boolean(this.waitingSince) || this.closed) return;
    clearTimeout(this.holdTimer);
    if (waiting) {
      this.waitingSince = Date.now();
      for (const call of this.calls.values()) call.pause();
      // A page that never says it goes on (frozen) times out like any other.
      this.holdTimer = setTimeout(() => this.hold(false), HOLD_MS);
      this.holdTimer.unref?.();
    } else {
      this.waited += Date.now() - this.waitingSince;
      this.waitingSince = 0;
      for (const call of this.calls.values()) call.resume();
    }
  }

  call(message, timeoutMs = CALL_MS) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return Promise.reject(gone());
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      let left = timeoutMs;
      let deadline = 0;
      let timer = null;
      // A quick question (is it awake, close a frame) is answered at once, waiting or not.
      const held = message.op !== "ping" && message.op !== "close";
      const expire = () => {
        this.calls.delete(id);
        reject(gone());
      };
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      const call = {
        resolve: settle(resolve),
        reject: settle(reject),
        pause() {
          if (!held || !timer) return;
          clearTimeout(timer);
          timer = null;
          left = Math.max(0, deadline - Date.now());
        },
        resume() {
          if (timer) return;
          deadline = Date.now() + left;
          timer = setTimeout(expire, left);
        },
      };
      this.calls.set(id, call);
      if (!this.waitingSince || !held) call.resume();
      this.ws.send(JSON.stringify({ ...message, id }));
    });
  }

  /** Playwright's browser.newContext: here a context holds the one page openPage asks for. */
  async newContext() {
    const browser = this;
    const opened = [];
    return {
      async newPage() {
        const page = new RemotePage(browser);
        browser.pages.set(page.id, page);
        opened.push(page);
        return page;
      },
      async close() {
        await Promise.all(opened.map((page) => page.close()));
      },
    };
  }
}

/** A hidden frame in the studio page, driven the way Renderer drives a Playwright page. */
class RemotePage {
  constructor(browser) {
    this.browser = browser;
    this.id = shortId();
    this.listeners = new Map();
  }
  on(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  /** What the frame reported, shaped like Playwright's page events. */
  emit({ kind, ...event }) {
    const value =
      kind === "pageerror"
        ? { message: event.message, stack: event.stack }
        : kind === "console"
          ? { type: () => event.level, text: () => event.text }
          : { status: () => event.status, url: () => event.url, request: () => ({ headers: () => ({}) }) };
    for (const listener of this.listeners.get(kind) ?? []) listener(value);
  }
  async goto(url, { timeout = 60000 } = {}) {
    // The page asks the studio with its own login; the address is the same path as the server's.
    const { pathname, search } = new URL(url);
    await this.browser.call({ op: "goto", page: this.id, url: pathname + search, timeout }, timeout + 15000);
  }
  waitForLoadState(_state, { timeout = 60000 } = {}) {
    return this.browser.call({ op: "load", page: this.id, timeout }, timeout + 15000);
  }
  waitForFunction(fn, arg, { timeout = 60000, polling = 100 } = {}) {
    return this.browser.call({ op: "wait", page: this.id, code: String(fn), arg, timeout, polling }, timeout + 15000);
  }
  evaluate(fn, arg) {
    return this.browser.call({ op: "eval", page: this.id, code: String(fn), arg });
  }
  async close() {
    this.browser.pages.delete(this.id);
    if (!this.browser.closed) await this.browser.call({ op: "close", page: this.id }, 10000).catch(() => {});
  }
}
