import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { browserExecutable } from "./render.mjs";
import { startGuardProxy, GUARD_HEADER } from "./browser-proxy.mjs";
import { readJson, sendFile } from "./http.mjs";
import { writeStream, uniquePath } from "./files.mjs";
import { importedAsset } from "./tools/asset-tools.mjs";
import { registerBrowserTools } from "./tools/browser-tools.mjs";
import { problem, notFound } from "./util.mjs";

const require = createRequire(import.meta.url);

/** The browser closes after this long without a viewer or a tool call (logins stay: they are in the profile). */
const IDLE_MS = 15 * 60 * 1000;
const MAX_TABS = 12;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
/** Downloads and cookie files for other programs are kept this long. */
const KEEP_MS = 60 * 60 * 1000;
const DOWNLOAD_LIMIT = 2 * 1024 * 1024 * 1024;
/** A tab counts as in use by the AI this long after its last tool call (shown in the tab strip). */
const AI_ACTIVE_MS = 20 * 1000;

const id = (prefix) => prefix + randomBytes(3).toString("hex");

/**
 * The user agent of the same browser without "Headless": what a person at this Chrome would send.
 * Some sites refuse or strip their pages for a headless browser, though a person is using it.
 */
function userAgent(executable) {
  let major;
  try {
    major = /(\d+)\.\d+\.\d+\.\d+/.exec(execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10000 }))?.[1];
  } catch {}
  if (!major) return undefined;
  const platform = { win32: "Windows NT 10.0; Win64; x64", darwin: "Macintosh; Intel Mac OS X 10_15_7" }[process.platform] ?? "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** What a failed navigation means, in words (the guard proxy refuses intranet addresses as a failed tunnel). */
export function navigationError(error, url) {
  const message = String(error?.message || error);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/.test(message)) return problem(400, `打不开 ${host}：服务器上的浏览器不能访问内网地址，或者找不到这个网址的服务器`, "PRIVATE_ADDRESS");
  if (/ERR_NAME_NOT_RESOLVED/.test(message)) return problem(400, `找不到这个网址的服务器：${host}`);
  if (/Timeout/i.test(message)) return problem(504, `${host} 30 秒内没有打开（网页还在载入时可以用 browser_read 看看已经出来的内容）`, "TIMEOUT");
  return problem(502, `打开 ${host} 失败：${message.split("\n")[0]}`);
}

/** The part of a host name a login belongs to: www.sketchfab.com → sketchfab.com, a.b.com.cn → b.com.cn. */
export function siteOf(host) {
  const labels = String(host).toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2 || /^\d+$/.test(labels.at(-1))) return labels.join(".");
  const second = labels.at(-2);
  const keep = labels.at(-1).length === 2 && /^(com|net|org|gov|edu|co|ac|or|ne)$/.test(second) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** A cookie belongs to a site when its domain is the site or a part of it, or the other way round. */
const cookieFor = (cookie, site) => {
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  return domain === site || domain.endsWith("." + site) || site.endsWith("." + domain);
};

/** Cookies as a Netscape cookies.txt (what yt-dlp, curl and wget read). */
export function netscapeCookies(cookies) {
  const lines = ["# Netscape HTTP Cookie File", "# FRAME 浏览器导出，用完即删", ""];
  for (const cookie of cookies) {
    const domain = (cookie.httpOnly ? "#HttpOnly_" : "") + cookie.domain;
    const expires = cookie.expires > 0 ? Math.round(cookie.expires) : 0;
    lines.push([domain, cookie.domain.startsWith(".") ? "TRUE" : "FALSE", cookie.path, cookie.secure ? "TRUE" : "FALSE", expires, cookie.name, cookie.value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

/**
 * One logged-in browser for the whole studio: a Chromium with a persistent profile in the data
 * folder (`browser/profile`), so a site the user logged in to stays logged in. The user sees and
 * works it in the 浏览器 editor tab (a screencast with the input sent back); the AI uses it
 * through the browser_* tools, each AI conversation in a tab of its own. On a studio reachable
 * from the network everything it loads goes through the guard proxy (public addresses only).
 */
export class WebBrowser {
  constructor(services) {
    this.services = services;
    const { config } = services;
    this.dir = path.join(config.home, "browser");
    this.profile = path.join(this.dir, "profile");
    this.sessionCookies = path.join(this.dir, "session-cookies.json");
    this.downloadsDir = path.join(config.dirs.tmp, "browser-downloads");
    this.keptDir = path.join(this.downloadsDir, "kept");
    this.cookieDir = path.join(config.dirs.tmp, "browser-cookies");
    this.contextPromise = null;
    this.proxy = null;
    /** id → { id, page, owner: "ai" | "user", session, title, url, loading, aiAt, login, viewport, cast } */
    this.tabs = new Map();
    /** AI conversation (or "external") → its tab id. */
    this.sessionTabs = new Map();
    this.viewers = new Set();
    /** id → { id, name, url, tab, state: "downloading" | "done" | "failed", size, file, error, at } */
    this.downloads = new Map();
    this.lastUse = 0;
    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    this.sweeper.unref?.();
    // Files for other programs from an earlier run.
    for (const dir of [this.cookieDir, this.downloadsDir]) fs.rmSync(dir, { recursive: true, force: true });
  }

  get running() {
    return Boolean(this.contextPromise);
  }

  async context() {
    this.lastUse = Date.now();
    if (!this.contextPromise) {
      this.contextPromise = this.launch();
      this.contextPromise.catch(() => (this.contextPromise = null));
    }
    return this.contextPromise;
  }

  async launch() {
    const executablePath = browserExecutable();
    if (!executablePath) throw problem(500, "没有找到 Chromium/Chrome。安装 Chrome，或设置 FRAME_BROWSER 指向浏览器程序。", "NO_BROWSER");
    fs.mkdirSync(this.profile, { recursive: true });
    fs.mkdirSync(this.keptDir, { recursive: true });
    const args = ["--lang=zh-CN", "--disable-renderer-backgrounding", "--autoplay-policy=user-gesture-required"];
    if (this.services.auth.required) {
      this.proxy ??= await startGuardProxy();
      // Loopback too goes through the proxy (Chrome sends it direct by default), and WebRTC may not go around it.
      args.push(`--proxy-server=${this.proxy.url}`, "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    }
    const { chromium } = require("playwright-core");
    const context = await chromium.launchPersistentContext(this.profile, {
      executablePath,
      headless: true,
      args,
      viewport: DEFAULT_VIEWPORT,
      deviceScaleFactor: 1,
      locale: "zh-CN",
      userAgent: userAgent(executablePath),
      acceptDownloads: true,
      downloadsPath: this.downloadsDir,
    });
    // Logins that live in session cookies survive the browser closing when idle.
    try {
      const saved = JSON.parse(fs.readFileSync(this.sessionCookies, "utf8"));
      if (Array.isArray(saved) && saved.length) await context.addCookies(saved);
    } catch {}
    this.current = context;
    context.on("page", (page) => this.adopt(page));
    context.on("close", () => this.current === context && this.forget());
    // The empty page a persistent browser starts with goes to whoever asked for the browser.
    for (const page of context.pages()) this.adopt(page).pristine = true;
    return context;
  }

  /** The browser went away (closed when idle, or crashed): its tabs with it. */
  forget() {
    this.current = null;
    this.contextPromise = null;
    this.tabs.clear();
    this.sessionTabs.clear();
    for (const viewer of this.viewers) {
      viewer.tab = null;
      viewer.send?.({ type: "view", tab: null });
    }
    this.emitTabs();
  }

  /** A page of the browser as a tab: new tabs, and pages a site opened (they belong with their opener). */
  adopt(page) {
    const tab = { id: id("t"), page, owner: "user", session: null, title: "", url: page.url(), loading: false, aiAt: 0, login: null, viewport: { ...DEFAULT_VIEWPORT, dpr: 1 }, cast: null, cdp: null };
    this.tabs.set(tab.id, tab);
    const refresh = async () => {
      tab.url = page.url();
      tab.title = await page.title().catch(() => tab.title);
      this.emitTabs();
    };
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      tab.loading = true;
      void refresh();
    });
    page.on("domcontentloaded", () => void refresh());
    page.on("load", () => {
      tab.loading = false;
      void refresh();
    });
    page.on("download", (download) => this.onDownload(tab, download));
    page.on("close", () => this.closed(tab));
    // A site's own popup (a login window, a new tab): it belongs to the opener's owner, and whoever watched the opener now watches it.
    void page.opener().then((opener) => {
      const parent = opener && this.tabOf(opener);
      if (!parent) return;
      tab.owner = parent.owner;
      tab.session = parent.session;
      tab.opener = parent.id;
      if (tab.session && this.sessionTabs.get(tab.session) === parent.id) this.sessionTabs.set(tab.session, tab.id);
      for (const viewer of this.viewers) if (viewer.tab === parent.id) void this.show(viewer, tab.id);
      this.emitTabs();
    });
    this.emitTabs();
    return tab;
  }

  tabOf(page) {
    for (const tab of this.tabs.values()) if (tab.page === page) return tab;
    return null;
  }

  closed(tab) {
    if (!this.tabs.delete(tab.id)) return;
    for (const [key, value] of this.sessionTabs) if (value === tab.id) this.sessionTabs.delete(key);
    // Who watched it watches its opener, or another tab.
    const next = (tab.opener && this.tabs.has(tab.opener) ? tab.opener : null) ?? [...this.tabs.keys()].at(-1) ?? null;
    for (const viewer of this.viewers) if (viewer.tab === tab.id) void this.show(viewer, next);
    this.emitTabs();
  }

  /** The tabs someone is looking at now (the 浏览器 editor tab in front). */
  watched() {
    const ids = new Set([...this.viewers].filter((viewer) => !viewer.paused && viewer.tab).map((viewer) => viewer.tab));
    return [...ids].flatMap((tabId) => {
      const tab = this.tabs.get(tabId);
      return tab && /^https?:/.test(tab.url) ? [{ id: tab.id, title: tab.title, url: tab.url }] : [];
    });
  }

  list() {
    const now = Date.now();
    return [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      owner: tab.owner,
      loading: tab.loading,
      ai: now - tab.aiAt < AI_ACTIVE_MS,
      login: tab.login ? { host: tab.login.host, reason: tab.login.reason } : null,
    }));
  }

  emitTabs() {
    clearTimeout(this.tabsTimer);
    this.tabsTimer = setTimeout(() => this.services.events.emit({ type: "browser-tabs", tabs: this.list() }), 80);
  }

  /** A new tab (the browser's first, empty page when it has just started). */
  async newTab({ owner = "user", session = null, url } = {}) {
    const context = await this.context();
    let tab = [...this.tabs.values()].find((item) => item.pristine);
    if (tab) tab.pristine = false;
    else {
      await this.makeRoom();
      tab = this.tabOf(await context.newPage());
    }
    Object.assign(tab, { owner, session });
    if (session) this.sessionTabs.set(session, tab.id);
    this.emitTabs();
    if (url) await this.goto(tab, url);
    return tab;
  }

  /** Too many tabs: the AI's that nobody looks at and nobody used for longest go first. */
  async makeRoom() {
    if (this.tabs.size < MAX_TABS) return;
    const watched = new Set([...this.viewers].map((viewer) => viewer.tab));
    const idle = [...this.tabs.values()].filter((tab) => tab.owner === "ai" && !watched.has(tab.id) && !tab.login).sort((a, b) => a.aiAt - b.aiAt)[0];
    if (idle) await idle.page.close().catch(() => {});
  }

  get(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw notFound(`没有标签页 ${tabId}（可能已经关闭）`);
    return tab;
  }

  /**
   * The tab an AI tool works in: the one named, else the conversation's own (`create`: a new one
   * when it has none). Marks it as in use by the AI.
   */
  async tabFor(session, { tab: tabId, create = false } = {}) {
    await this.context();
    let tab = tabId ? this.get(tabId) : this.tabs.get(this.sessionTabs.get(session));
    if (!tab && create) tab = await this.newTab({ owner: "ai", session });
    if (!tab) throw problem(400, "这个对话还没有打开网页：先用 browser_open 打开一个网址", "NO_TAB");
    tab.aiAt = Date.now();
    this.lastUse = tab.aiAt;
    this.emitTabs();
    setTimeout(() => this.emitTabs(), AI_ACTIVE_MS + 500).unref?.();
    return tab;
  }

  /** Open an address in a tab: http(s) only (no files of the server, no browser pages). */
  async goto(tab, address) {
    const url = normalizeAddress(address);
    tab.loading = true;
    let response;
    try {
      response = await tab.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (error) {
      throw navigationError(error, url);
    }
    if (response?.headers()[GUARD_HEADER]) throw navigationError("ERR_PROXY", url);
    // Most pages draw their content right after; don't wait for every last request.
    await tab.page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
    return response;
  }

  // ---- logins ---------------------------------------------------------------------------

  /** The AI asks the user to log in to a site in this tab: the tab strip and the chat show it. */
  requestLogin(tab, { reason, session }) {
    const host = (() => {
      try {
        return new URL(tab.page.url()).host;
      } catch {
        return "";
      }
    })();
    tab.login = { host, reason, session, at: Date.now() };
    this.emitTabs();
    this.services.events.emit({ type: "browser-login", tab: tab.id, host, reason, session });
    return host;
  }

  /** The user says they logged in: the AI that asked hears it (a message in its conversation). */
  async loginDone(tabId) {
    const tab = this.get(tabId);
    const login = tab.login;
    tab.login = null;
    this.emitTabs();
    if (login?.session && this.services.ai?.sessions?.has(login.session))
      await this.services.ai.prompt(login.session, {
        text: `我已经在浏览器里登录 ${login.host || "了"}（标签页 ${tab.id}），接着做吧。（点「登录好了」自动发的消息）`,
      });
    return { ok: true, notified: Boolean(login?.session) };
  }

  /** Log out of the site a tab shows: its cookies (on all its hosts) and the page's own storage. */
  async signOut(tabId) {
    const tab = this.get(tabId);
    const url = new URL(tab.page.url());
    if (!/^https?:$/.test(url.protocol)) return { ok: true };
    const site = siteOf(url.hostname);
    const context = await this.context();
    const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await context.clearCookies({ domain: new RegExp(`(^|\\.)${escaped}$`) });
    const cdp = await this.cdp(tab);
    await cdp.send("Storage.clearDataForOrigin", { origin: url.origin, storageTypes: "all" }).catch(() => {});
    await tab.page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    return { ok: true, site };
  }

  /** Forget every login: the browser closes and its profile is deleted. */
  async clearAll() {
    await this.close({ keepSession: false });
    fs.rmSync(this.profile, { recursive: true, force: true });
    fs.rmSync(this.sessionCookies, { force: true });
    return { ok: true };
  }

  /** Sites the browser holds cookies for (for the tab's menu): site → number of cookies. */
  async sites() {
    if (!this.contextPromise) return [];
    const cookies = await (await this.context()).cookies();
    const count = new Map();
    for (const cookie of cookies) {
      const site = siteOf(cookie.domain.replace(/^\./, ""));
      count.set(site, (count.get(site) ?? 0) + 1);
    }
    return [...count].map(([site, cookies]) => ({ site, cookies })).sort((a, b) => a.site.localeCompare(b.site));
  }

  /**
   * The cookies of some sites as a cookies.txt for a program the AI runs (yt-dlp `--cookies`):
   * in the data folder's tmp, readable by this user only, deleted after an hour.
   */
  async cookieFile(sites) {
    const context = await this.context();
    const wanted = sites.map((site) => siteOf(String(site).replace(/^https?:\/\//, "").split("/")[0]));
    const cookies = (await context.cookies()).filter((cookie) => wanted.some((site) => cookieFor(cookie, site)));
    fs.mkdirSync(this.cookieDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.cookieDir, `cookies-${randomBytes(6).toString("hex")}.txt`);
    fs.writeFileSync(file, netscapeCookies(cookies), { mode: 0o600 });
    setTimeout(() => fs.rmSync(file, { force: true }), KEEP_MS).unref?.();
    const counts = Object.fromEntries(wanted.map((site) => [site, cookies.filter((cookie) => cookieFor(cookie, site)).length]));
    return { file, counts, total: cookies.length };
  }

  /** Request headers that make a download look like it came from the tab: its cookies for each address, its agent, the page. */
  async headersFor(tab, url) {
    const context = await this.context();
    const cookies = await context.cookies(url.href);
    const headers = { "User-Agent": await tab.page.evaluate(() => navigator.userAgent).catch(() => "Mozilla/5.0") };
    if (cookies.length) headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const referer = tab.page.url();
    if (/^https?:/.test(referer)) headers.Referer = referer;
    return headers;
  }

  // ---- downloads ------------------------------------------------------------------------

  /** A download a page started: kept for an hour, unless a tool waits for it (`tab.awaitDownload`). */
  onDownload(tab, download) {
    if (tab.awaitDownload) {
      const take = tab.awaitDownload;
      tab.awaitDownload = null;
      return take(download);
    }
    const item = { id: id("d"), name: download.suggestedFilename(), url: download.url(), tab: tab.id, state: "downloading", size: 0, at: Date.now() };
    this.downloads.set(item.id, item);
    this.emitDownloads();
    void this.keep(download, item);
  }

  /** Move a finished download out of the browser's hands (it deletes them when it closes). */
  async keep(download, item) {
    try {
      const file = path.join(this.keptDir, item.id);
      await download.saveAs(file);
      await download.delete().catch(() => {});
      item.file = file;
      item.size = fs.statSync(file).size;
      item.state = "done";
    } catch (error) {
      item.state = "failed";
      item.error = (await download.failure().catch(() => null)) || error.message;
    }
    this.emitDownloads();
    return item;
  }

  /** Wait for the download an action in the tab starts (a click on a download button). */
  async expectDownload(tab, action, { timeout = 30000 } = {}) {
    const started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        tab.awaitDownload = null;
        reject(problem(504, `${Math.round(timeout / 1000)} 秒内没有开始下载：这个按钮可能先打开了别的页面或对话框，用 browser_read 看看`, "TIMEOUT"));
      }, timeout);
      tab.awaitDownload = (download) => {
        clearTimeout(timer);
        resolve(download);
      };
    });
    await action();
    const download = await started;
    const item = { id: id("d"), name: download.suggestedFilename(), url: download.url(), tab: tab.id, state: "downloading", size: 0, at: Date.now() };
    this.downloads.set(item.id, item);
    this.emitDownloads();
    return this.keep(download, item);
  }

  listDownloads() {
    return [...this.downloads.values()].map(({ file: _file, ...item }) => item).sort((a, b) => b.at - a.at);
  }

  emitDownloads() {
    this.services.events.emit({ type: "browser-downloads", downloads: this.listDownloads() });
  }

  download(downloadId) {
    const item = this.downloads.get(downloadId);
    if (!item) throw notFound(`没有下载 ${downloadId}（下载的文件保留一小时）`);
    return item;
  }

  /** A finished download into a work's public/ (with its source noted). */
  async importDownload(work, downloadId, { folder = "public/imports", name, license } = {}) {
    const item = this.download(downloadId);
    if (item.state === "downloading") throw problem(409, `${item.name} 还在下载`, "BUSY");
    if (item.state !== "done") throw problem(400, `${item.name} 没有下载成功：${item.error}`);
    const base = (name || item.name || "download").replace(/[\\/\x00-\x1f?#%*:|"<>]/g, "_");
    const relative = uniquePath(work.dir, `${folder.replace(/\/$/, "")}/${base}`);
    await writeStream(work.dir, relative, fs.createReadStream(item.file), { limit: DOWNLOAD_LIMIT });
    const result = await importedAsset(work, relative, license ?? (item.url && !item.url.startsWith("blob:") ? `下载自 ${item.url}` : undefined));
    this.services.events.emit({ type: "assets", work: work.id, repo: work.repo });
    return result;
  }

  // ---- the user's view ------------------------------------------------------------------

  async cdp(tab) {
    tab.cdp ??= tab.page.context().newCDPSession(tab.page);
    return tab.cdp;
  }

  /**
   * One 浏览器 editor tab connected: it receives the tab it shows as JPEG frames (binary
   * messages) plus the tab list, and sends the user's mouse, keys and text back.
   */
  view(ws, req) {
    const principal = this.services.auth.identify(req);
    // Only a person at the studio: the AI's own tokens use the tools, which keep to their rules.
    if (!["session", "local"].includes(principal?.kind)) return ws.close(4003, "forbidden");
    const url = new URL(req.url, "http://local");
    const viewer = { ws, tab: null, size: sizeFrom(Object.fromEntries(url.searchParams)), paused: url.searchParams.get("paused") === "1", queue: Promise.resolve() };
    this.viewers.add(viewer);
    const send = (message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
    viewer.send = send;
    const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25000);
    ws.on("close", () => {
      clearInterval(ping);
      this.viewers.delete(viewer);
      const tab = viewer.tab && this.tabs.get(viewer.tab);
      viewer.tab = null;
      if (tab) void this.recast(tab);
      this.lastUse = Date.now();
    });
    ws.on("message", (raw, binary) => {
      if (binary) return;
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      // One after another, so a click lands where the mouse moved to.
      viewer.queue = viewer.queue.then(() => this.handle(viewer, message)).catch((error) => send({ type: "error", message: error.message }));
    });
    viewer.queue = viewer.queue
      .then(async () => {
        await this.context();
        send({ type: "tabs", tabs: this.list() });
        const wanted = url.searchParams.get("tab");
        const tab =
          (wanted && this.tabs.get(wanted)) ||
          [...this.tabs.values()].find((item) => item.login) ||
          [...this.tabs.values()].sort((a, b) => b.aiAt - a.aiAt)[0] ||
          (await this.newTab({ owner: "user" }));
        await this.show(viewer, tab.id);
      })
      .catch((error) => send({ type: "error", message: error.message }));
  }

  /** Point a viewer at a tab (null: none) and keep both tabs' screencasts right. */
  async show(viewer, tabId) {
    const before = viewer.tab && this.tabs.get(viewer.tab);
    viewer.tab = tabId;
    if (before && before.id !== tabId) await this.recast(before);
    const tab = tabId && this.tabs.get(tabId);
    viewer.send?.({ type: "view", tab: tabId });
    if (!tab) return;
    await this.recast(tab, { restart: true });
    viewer.send?.({ type: "viewport", tab: tab.id, width: tab.viewport.width, height: tab.viewport.height });
  }

  /**
   * Start, restart or stop a tab's screencast for the viewers looking at it: the page takes the
   * size of the one who looked last (sharp on a phone: device pixels up to 2×). One change at a
   * time per tab; `restart` sends a first frame at once (otherwise one comes only when the page
   * changes), for a viewer that just arrived.
   */
  recast(tab, { restart = false } = {}) {
    tab.casting = (tab.casting ?? Promise.resolve()).then(() => this.applyCast(tab, restart)).catch(() => {});
    return tab.casting;
  }

  async applyCast(tab, restart) {
    if (!this.tabs.has(tab.id)) return;
    const watching = [...this.viewers].filter((viewer) => viewer.tab === tab.id && !viewer.paused);
    const cdp = await this.cdp(tab);
    if (!tab.framed) {
      tab.framed = true;
      cdp.on("Page.screencastFrame", (frame) => {
        void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
        const data = Buffer.from(frame.data, "base64");
        for (const viewer of this.viewers)
          // A slow connection skips frames rather than falling behind.
          if (viewer.tab === tab.id && !viewer.paused && viewer.ws.bufferedAmount < 1.5 * 1024 * 1024) viewer.ws.send(data, { binary: true });
      });
    }
    if (!watching.length) {
      if (tab.cast) {
        tab.cast = null;
        await cdp.send("Page.stopScreencast").catch(() => {});
        // Back to the AI's size when nobody watches.
        await this.resize(tab, { ...DEFAULT_VIEWPORT, dpr: 1 }).catch(() => {});
      }
      return;
    }
    const size = watching.at(-1).size;
    const key = `${size.width}x${size.height}@${size.dpr}`;
    if (tab.cast === key && !restart) return;
    if (tab.cast !== key) await this.resize(tab, size);
    if (tab.cast) await cdp.send("Page.stopScreencast").catch(() => {});
    tab.cast = key;
    const scale = Math.min(2, size.dpr);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 72, maxWidth: Math.round(size.width * scale), maxHeight: Math.round(size.height * scale), everyNthFrame: 1 });
    for (const viewer of watching) viewer.send({ type: "viewport", tab: tab.id, width: size.width, height: size.height });
  }

  /** The page's size in CSS pixels, drawn at up to 2× for a sharp picture on high-density screens. */
  async resize(tab, { width, height, dpr }) {
    tab.viewport = { width, height, dpr };
    await tab.page.setViewportSize({ width, height });
    if (dpr > 1) {
      const cdp = await this.cdp(tab);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: Math.min(2, dpr), mobile: false, screenWidth: width, screenHeight: height });
    }
  }

  async handle(viewer, message) {
    this.lastUse = Date.now();
    const tab = viewer.tab ? this.tabs.get(viewer.tab) : null;
    const page = tab?.page;
    switch (message.type) {
      case "size":
        viewer.size = sizeFrom(message);
        if (tab) await this.recast(tab);
        return;
      case "pause":
      case "resume":
        viewer.paused = message.type === "pause";
        if (tab) await this.recast(tab);
        return;
      case "show":
        return this.show(viewer, this.get(message.tab).id);
      case "new": {
        const created = await this.newTab({ owner: "user" });
        await this.show(viewer, created.id);
        if (message.url) await this.goto(created, message.url);
        return;
      }
      case "close":
        await this.get(message.tab).page.close();
        return;
      case "login-done":
        await this.loginDone(message.tab);
        return;
    }
    if (!page) return;
    switch (message.type) {
      case "go":
        await this.goto(tab, message.url);
        return;
      case "back":
        await page.goBack({ timeout: 15000 }).catch(() => {});
        return;
      case "forward":
        await page.goForward({ timeout: 15000 }).catch(() => {});
        return;
      case "reload":
        await page.reload({ timeout: 15000 }).catch(() => {});
        return;
      case "mouse": {
        const x = Number(message.x) || 0,
          y = Number(message.y) || 0;
        const button = ["left", "right", "middle"].includes(message.button) ? message.button : "left";
        if (message.action === "move") await page.mouse.move(x, y);
        else if (message.action === "down") {
          await page.mouse.move(x, y);
          await page.mouse.down({ button, clickCount: Math.min(3, Math.max(1, Number(message.clicks) || 1)) });
        } else if (message.action === "up") {
          await page.mouse.move(x, y);
          await page.mouse.up({ button, clickCount: Math.min(3, Math.max(1, Number(message.clicks) || 1)) });
          viewer.send({ type: "focus", editable: await editableFocus(page) });
        }
        return;
      }
      case "wheel":
        await page.mouse.move(Number(message.x) || 0, Number(message.y) || 0);
        await page.mouse.wheel(Number(message.dx) || 0, Number(message.dy) || 0);
        return;
      case "key": {
        const modifiers = (Array.isArray(message.modifiers) ? message.modifiers : []).filter((item) => ["Control", "Shift", "Alt", "Meta"].includes(item));
        const key = String(message.key || "");
        if (!key) return;
        try {
          await page.keyboard.press([...modifiers, key].join("+"));
        } catch {
          // A character the US layout does not have (é, ，): typed as text.
          if ([...key].length === 1 && !modifiers.some((item) => item !== "Shift")) await page.keyboard.insertText(key);
        }
        return;
      }
      case "text":
        if (message.text) await page.keyboard.insertText(String(message.text).slice(0, 10000));
        return;
    }
  }

  // ---- lifetime -------------------------------------------------------------------------

  sweep() {
    const now = Date.now();
    for (const [key, item] of this.downloads)
      if (item.state !== "downloading" && now - item.at > KEEP_MS) {
        if (item.file) fs.rmSync(item.file, { force: true });
        this.downloads.delete(key);
      }
    const downloading = [...this.downloads.values()].some((item) => item.state === "downloading");
    // A 浏览器 tab left open out of sight does not keep the browser running.
    const watched = [...this.viewers].some((viewer) => !viewer.paused);
    if (this.contextPromise && !watched && !downloading && now - this.lastUse > IDLE_MS) void this.close();
  }

  /** Close the browser; session cookies (logins without an expiry) are kept for the next start unless `keepSession` is false. */
  async close({ keepSession = true } = {}) {
    const pending = this.contextPromise;
    if (!pending) return;
    let context;
    try {
      context = await pending;
    } catch {
      this.contextPromise = null;
      return;
    }
    this.forget();
    try {
      if (keepSession) {
        const { cookies } = await context.storageState();
        const session = cookies.filter((cookie) => cookie.expires === -1);
        fs.writeFileSync(this.sessionCookies, JSON.stringify(session), { mode: 0o600 });
      }
    } catch {}
    await context.close().catch(() => {});
  }

  async shutdown() {
    clearInterval(this.sweeper);
    await this.close();
    await this.proxy?.close();
    this.proxy = null;
  }
}

/** An address typed into the address bar or given to a tool: http(s) only; a bare name gets https://, words become a search. */
export function normalizeAddress(address) {
  const text = String(address || "").trim();
  if (!text) throw problem(400, "网址不能为空");
  if (/^about:blank$/i.test(text)) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^\s:/]+:\d+(\/|$)/.test(text)) {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw problem(400, "只能打开 http/https 网址");
    return url.href;
  }
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return new URL("https://" + text).href;
  if (/^(localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?(\/.*)?$/i.test(text)) return new URL("http://" + text).href;
  return "https://www.bing.com/search?q=" + encodeURIComponent(text);
}

/** A viewer's size from its message or query: CSS pixels within sane bounds, and its device pixel ratio. */
function sizeFrom({ width, height, dpr, w, h }) {
  const clamp = (value, low, high, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Math.min(high, Math.max(low, Number(value)))) : fallback);
  return {
    width: clamp(width ?? w, 240, 2560, DEFAULT_VIEWPORT.width),
    height: clamp(height ?? h, 240, 1600, DEFAULT_VIEWPORT.height),
    dpr: Math.min(3, Math.max(1, Number(dpr) || 1)),
  };
}

/** Whether what has the focus after a click takes typing (so a phone can bring up its keyboard). */
async function editableFocus(page) {
  return page
    .evaluate(() => {
      const element = document.activeElement;
      if (!element) return false;
      if (element.tagName === "IFRAME") return true;
      if (element.isContentEditable || element.tagName === "TEXTAREA") return true;
      return element.tagName === "INPUT" && !["button", "checkbox", "radio", "submit", "reset", "file", "image", "range", "color"].includes(element.type);
    })
    .catch(() => false);
}

export function browserPlugin(services) {
  const { router } = services;
  const browser = (services.browser = new WebBrowser(services));
  services.closers.push(() => browser.shutdown());
  services.sockets.set("/api/browser/view", (ws, req) => browser.view(ws, req));

  router.get("/api/browser", async () => ({ running: browser.running, tabs: browser.list(), downloads: browser.listDownloads(), sites: await browser.sites() }));
  router.post("/api/browser/tabs/:tab/login-done", ({ params }) => browser.loginDone(params.tab));
  router.post("/api/browser/tabs/:tab/sign-out", ({ params }) => browser.signOut(params.tab));
  router.post("/api/browser/clear", () => browser.clearAll());
  router.get("/api/browser/downloads/:id", ({ req, res, params }) => {
    const item = browser.download(params.id);
    if (item.state !== "done") throw problem(409, "还没有下载完", "BUSY");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(item.name || "download")}`);
    sendFile(req, res, item.file, { type: "application/octet-stream" });
  });
  router.post("/api/browser/downloads/:id/import", async ({ req, params }) => {
    const { repo, work: workId } = await readJson(req);
    const work = await services.openEditable(workId, repo);
    return browser.importDownload(work, params.id);
  });

  registerBrowserTools(services.tools);
}
