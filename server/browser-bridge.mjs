import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { problem, notFound, sha256 } from "./util.mjs";
import { uniquePath, writeStream } from "./files.mjs";
import { importedAsset } from "./tools/asset-tools.mjs";
import { fieldKind, findRef, elementPoint, focusField, chooseOption, pageOutline } from "./browser-page.mjs";

/** What the extension and this server speak; an extension of another version is told to update. */
export const BRIDGE_PROTOCOL = 1;
const PAIR_MS = 10 * 60 * 1000;
const CALL_MS = 60 * 1000;
const DOWNLOAD_LIMIT = 2 * 1024 * 1024 * 1024;
/** Upload chunks start with the upload's id in this many bytes. */
export const UPLOAD_HEADER = 16;
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const tabKey = (id) => "x" + id;
const chromeId = (key) => Number(String(key).slice(1));

/**
 * The user's own browsers (Edge, Chrome) connected through the FRAME 连接器 extension. A pairing
 * code made in a repository's 浏览器 tab links that browser to the repository; the extension then
 * keeps a socket open (`/api/browser/bridge`, authenticated by its own token, not a session) and
 * runs what the browser_* tools ask in the tabs it lets the AI use: the tabs it opened for a
 * repository's AI and the ones the user handed over. The logins never leave that browser; the
 * extension itself refuses other tabs, other repositories' tabs and pages that are not http(s).
 */
export class Bridges {
  constructor(services) {
    this.services = services;
    /** code → { repo, expires } */
    this.codes = new Map();
    /** bridge id → Connection */
    this.connections = new Map();
    /** `${repo}\n${session}` → tab key ("x123"): the AI conversation's own tab in the user's browser. */
    this.sessionTabs = new Map();
    /** tab key → { repo, host, reason, session } */
    this.logins = new Map();
    /** bridge id → the key its FRAME pages show (computerOf); kept while the studio runs, so a reconnect keeps it */
    this.pageKeys = new Map();
  }

  list() {
    return this.services.settings.get("browserBridges") ?? [];
  }
  save(list) {
    this.services.settings.update("browserBridges", list);
  }

  /** A code the user types into the extension within ten minutes to link it to this repository. */
  pairCode(repo) {
    this.services.repos.get(repo);
    const now = Date.now();
    for (const [code, item] of this.codes) if (item.expires < now) this.codes.delete(code);
    const code = Array.from({ length: 8 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");
    this.codes.set(code, { repo, expires: now + PAIR_MS });
    return { code, expires: new Date(now + PAIR_MS).toISOString() };
  }

  /** The browsers linked to a repository (for its 浏览器 tab). */
  computers(repo) {
    return this.list()
      .filter((bridge) => bridge.repos.includes(repo))
      .map((bridge) => ({ id: bridge.id, name: bridge.name, online: this.connections.has(bridge.id), lastSeen: bridge.lastSeen ?? null, repos: bridge.repos.length }));
  }

  /** Unlink a browser from a repository (the extension forgets the pairing when no repository is left). */
  unlink(bridgeId, repo) {
    const list = this.list();
    const bridge = list.find((item) => item.id === bridgeId && item.repos.includes(repo));
    if (!bridge) throw notFound("这台电脑没有连接这个作品库");
    bridge.repos = bridge.repos.filter((item) => item !== repo);
    this.save(bridge.repos.length ? list : list.filter((item) => item !== bridge));
    for (const [key, value] of this.sessionTabs) if (key.startsWith(repo + "\n")) this.sessionTabs.delete(key);
    const connection = this.connections.get(bridgeId);
    if (connection) {
      if (bridge.repos.length) connection.welcome(bridge);
      else connection.refuse("这个浏览器已经和 FRAME 断开（在 FRAME 里删除了配对）", "UNPAIRED");
    }
    this.emit(repo);
    return { ok: true };
  }

  /** A repository leaves this machine: no browser stays linked to it. */
  forget(repo) {
    for (const bridge of this.list()) if (bridge.repos.includes(repo)) this.unlink(bridge.id, repo);
  }

  /** The browsers (bridge ids) linked to a repository. */
  linked(repo) {
    return new Set(this.list().filter((bridge) => bridge.repos.includes(repo)).map((bridge) => bridge.id));
  }

  /** The connected browser the AI of a repository uses: of several, the one used last. */
  connection(repo) {
    const linked = this.linked(repo);
    return [...this.connections.values()].filter((item) => linked.has(item.bridge.id)).sort((a, b) => b.active - a.active)[0] ?? null;
  }

  /**
   * Which linked browser a FRAME page is in: the page asks the extension next to it for the key
   * this connection was given (render-gpu.mjs), so that computer's GPU draws for the AI of the
   * repositories linked to it. Null for a key no open connection has.
   */
  computerOf(key) {
    if (typeof key !== "string" || !key) return null;
    for (const connection of this.connections.values()) if (connection.pageKey === key) return connection.bridge.id;
    return null;
  }
  connected(repo) {
    return Boolean(this.connection(repo));
  }

  /** The tabs of a repository the AI may use in the connected browser, for the UI. */
  remoteTabs(repo) {
    const connection = this.connection(repo);
    if (!connection) return [];
    return connection.tabs
      .filter((tab) => tab.repo === repo)
      .map((tab) => {
        const login = this.logins.get(tabKey(tab.id));
        return { id: tabKey(tab.id), title: tab.title, url: tab.url, owner: tab.kind === "shared" ? "user" : "ai", loading: tab.loading, ai: false, login: login ? { host: login.host, reason: login.reason } : null };
      });
  }

  emit(repo) {
    this.services.events.emit({ type: "browser-computer", repo, computers: this.computers(repo), tabs: this.remoteTabs(repo) });
  }

  sessionTab(repo, session) {
    const key = this.sessionTabs.get(`${repo}\n${session}`);
    const connection = this.connection(repo);
    return key && connection?.tabs.some((tab) => tabKey(tab.id) === key && tab.repo === repo) ? key : null;
  }

  /**
   * A driver for a tab in the user's browser: the one named, the conversation's own, or (with
   * `create`) a new one the extension opens for this repository's AI.
   */
  async driver(repo, session, { tab, create = false, url } = {}) {
    const connection = this.connection(repo);
    if (!connection) throw problem(409, "用户电脑上的浏览器没有连着 FRAME（FRAME 连接器扩展不在线）：用服务器上的浏览器（where: \"server\"），或者请用户打开电脑上的浏览器", "OFFLINE");
    let key = tab ?? this.sessionTab(repo, session);
    if (!key && create) {
      const info = await connection.call("create", { repo, url: url ?? "about:blank" });
      key = tabKey(info.id);
      // Known before the extension's next list of tabs arrives.
      if (!connection.tabs.some((item) => item.id === info.id)) connection.tabs.push({ ...info, kind: "ai", repo });
    }
    if (!key) throw problem(400, "这个对话还没有打开网页：先用 browser_open 打开一个网址", "NO_TAB");
    const info = connection.tabs.find((item) => tabKey(item.id) === key && item.repo === repo);
    if (!info) throw notFound(`用户电脑上的浏览器里没有标签页 ${key}（可能已经关了，或者没有交给 AI）`);
    if (!tab || info.kind === "ai") this.sessionTabs.set(`${repo}\n${session}`, key);
    connection.active = Date.now();
    return new RemoteDriver(this, connection, repo, info);
  }

  requestLogin(repo, key, { reason, session, host }) {
    this.logins.set(key, { repo, reason, session, host });
    this.emit(repo);
    this.services.events.emit({ type: "browser-login", repo, tab: key, host, reason, session });
  }

  async loginDone(repo, key) {
    const login = this.logins.get(key);
    this.logins.delete(key);
    this.emit(repo);
    if (login?.session && this.services.ai?.sessions?.has(login.session))
      await this.services.ai.prompt(login.session, { text: `我已经在电脑上的浏览器里登录 ${login.host || "了"}（标签页 ${key}），接着做吧。（点「登录好了」自动发的消息）` });
    return { ok: true, notified: Boolean(login?.session) };
  }

  /** Bring a tab to the front on the user's computer (for logging in there). */
  async focus(repo, key) {
    const connection = this.connection(repo);
    if (!connection) throw problem(409, "电脑上的浏览器不在线", "OFFLINE");
    await connection.call("focus", { repo, tab: chromeId(key) });
    return { ok: true };
  }

  // ---- the extension's socket ---------------------------------------------------------------

  /** `/api/browser/bridge`: the first message proves who it is (a pairing code or the token it got then). */
  socket(ws) {
    let connection = null;
    const timer = setTimeout(() => !connection && ws.close(4001, "no hello"), 10000);
    ws.on("message", (raw, binary) => {
      if (connection) return connection.receive(raw, binary);
      if (binary) return ws.close(4001, "no hello");
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return ws.close(4001, "bad hello");
      }
      try {
        connection = this.authenticate(ws, message);
        clearTimeout(timer);
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", message: error.message, code: error.code }));
        ws.close(4003, error.code || "refused");
      }
    });
    ws.on("close", () => clearTimeout(timer));
  }

  authenticate(ws, message) {
    if (message.protocol !== BRIDGE_PROTOCOL) throw problem(400, `FRAME 连接器的版本和 FRAME 不一致：请到 FRAME 的「浏览器」标签页重新下载扩展`, "VERSION");
    const name = String(message.name || "电脑上的浏览器").slice(0, 60);
    const list = this.list();
    const known = message.token ? list.find((bridge) => verify(message.token, bridge.hash)) : null;
    let bridge = known;
    let token = null;
    if (message.type === "pair") {
      const code = String(message.code || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      const pairing = this.codes.get(code);
      if (!pairing || pairing.expires < Date.now()) throw problem(403, "配对码不对或已经过期：在 FRAME 的「浏览器」标签页里重新生成一个", "BAD_CODE");
      this.codes.delete(code);
      if (!bridge) {
        token = "fb_" + randomBytes(24).toString("base64url");
        bridge = { id: "b" + randomBytes(4).toString("hex"), name, hash: sha256(token), repos: [], createdAt: new Date().toISOString() };
        list.push(bridge);
      }
      if (!bridge.repos.includes(pairing.repo)) bridge.repos.push(pairing.repo);
    } else if (message.type !== "hello" || !bridge) throw problem(401, "这个浏览器的配对已经失效：在 FRAME 的「浏览器」标签页里重新配对", "UNPAIRED");
    bridge.name = name;
    bridge.lastSeen = new Date().toISOString();
    this.save(list);
    // One socket per browser: a new one (the extension restarted) replaces the old.
    this.connections.get(bridge.id)?.close();
    const connection = new Connection(this, ws, bridge);
    this.connections.set(bridge.id, connection);
    connection.welcome(bridge, token);
    for (const repo of bridge.repos) this.emit(repo);
    return connection;
  }

  closed(connection) {
    if (this.connections.get(connection.bridge.id) !== connection) return;
    this.connections.delete(connection.bridge.id);
    const list = this.list();
    const bridge = list.find((item) => item.id === connection.bridge.id);
    if (bridge) {
      bridge.lastSeen = new Date().toISOString();
      this.save(list);
    }
    for (const repo of connection.bridge.repos) this.emit(repo);
  }

  close() {
    for (const connection of this.connections.values()) connection.close();
  }
}

function verify(token, hash) {
  const a = Buffer.from(sha256(String(token)));
  const b = Buffer.from(String(hash || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One connected extension: requests out, results and upload chunks in. */
class Connection {
  constructor(bridges, ws, bridge) {
    this.bridges = bridges;
    this.ws = ws;
    this.bridge = bridge;
    this.tabs = [];
    this.pending = new Map();
    this.uploads = new Map();
    this.next = 1;
    this.active = Date.now();
    this.seen = Date.now();
    /** Handed to FRAME pages in this browser (through the extension) to tell which computer they are on. */
    if (!bridges.pageKeys.has(bridge.id)) bridges.pageKeys.set(bridge.id, randomBytes(18).toString("base64url"));
    this.pageKey = bridges.pageKeys.get(bridge.id);
    this.ping = setInterval(() => {
      // The extension answers pings; silence means it is gone (its service worker was stopped).
      if (Date.now() - this.seen > 70000) return this.close();
      this.send({ type: "ping" });
    }, 20000);
    ws.on("close", () => this.closed());
  }

  send(message) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  welcome(bridge, token) {
    const repos = bridge.repos.map((id) => {
      let title = id;
      try {
        const repo = this.bridges.services.repos.get(id);
        title = id === "local" ? "本地" : repo.name || id;
      } catch {}
      return { id, title };
    });
    this.send({ type: "welcome", bridge: bridge.id, name: bridge.name, repos, pageKey: this.pageKey, ...(token ? { token } : {}) });
  }

  refuse(message, code) {
    this.send({ type: "error", message, code });
    this.ws.close(4003, code);
  }

  receive(raw, binary) {
    this.seen = Date.now();
    if (binary) return this.chunk(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === "result") {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.ok) call.resolve(message.data);
      else call.reject(problem(message.status || 400, message.error || "电脑上的浏览器没能完成", message.code || "REMOTE"));
    } else if (message.type === "tabs") {
      this.tabs = Array.isArray(message.tabs) ? message.tabs.filter((tab) => this.bridge.repos.includes(tab.repo)) : [];
      for (const repo of this.bridge.repos) this.bridges.emit(repo);
    }
  }

  call(op, args, { timeout = CALL_MS } = {}) {
    if (this.ws.readyState !== this.ws.OPEN) return Promise.reject(problem(409, "电脑上的浏览器断开了", "OFFLINE"));
    const id = this.next++;
    this.active = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(problem(504, `电脑上的浏览器 ${Math.round(timeout / 1000)} 秒内没有完成（${op}）`, "TIMEOUT"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: "call", id, op, args });
    });
  }

  /** A file the extension downloads with the user's login, streamed here into a temporary file. */
  upload(dir) {
    const id = randomBytes(8).toString("hex");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `upload-${id}`);
    const out = fs.createWriteStream(file, { mode: 0o600 });
    const upload = { id, file, out, size: 0, error: null };
    this.uploads.set(id, upload);
    return upload;
  }
  chunk(data) {
    const id = data.subarray(0, UPLOAD_HEADER).toString("ascii").trim();
    const upload = this.uploads.get(id);
    if (!upload || upload.error) return;
    upload.size += data.length - UPLOAD_HEADER;
    if (upload.size > DOWNLOAD_LIMIT) {
      upload.error = problem(413, "文件过大");
      return;
    }
    upload.out.write(data.subarray(UPLOAD_HEADER));
  }
  async finish(upload) {
    this.uploads.delete(upload.id);
    await new Promise((resolve) => upload.out.end(resolve));
    if (upload.error) {
      fs.rmSync(upload.file, { force: true });
      throw upload.error;
    }
    return upload;
  }

  closed() {
    clearInterval(this.ping);
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(problem(409, "电脑上的浏览器断开了", "OFFLINE"));
    }
    this.pending.clear();
    for (const upload of this.uploads.values()) {
      upload.out.destroy();
      fs.rmSync(upload.file, { force: true });
    }
    this.uploads.clear();
    this.bridges.closed(this);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/** A page script with the element of a ref as its first argument; a ref that is gone says so. */
const onRef = (fn, ref, ...args) => `(() => { const element = (${findRef})(${JSON.stringify(ref)}); if (!element) return { stale: true }; return { value: (${fn})(element, ...${JSON.stringify(args)}) }; })()`;

/**
 * A tab in the user's browser, in the shape the browser_* tools use (the server's tabs have the
 * same, see tools/browser-tools.mjs). Everything is a request to the extension; page scripts go
 * as text (browser-page.mjs) and input as DevTools events.
 */
export class RemoteDriver {
  constructor(bridges, connection, repo, info) {
    this.bridges = bridges;
    this.connection = connection;
    this.repo = repo;
    this.info = info;
    this.id = tabKey(info.id);
    this.owner = info.kind === "shared" ? "user" : "ai";
    this.where = "computer";
    this.label = `用户电脑上的浏览器（${connection.bridge.name}）${this.owner === "user" ? "，用户交给你的标签页" : ""}`;
    this.viewportHeight = 800;
  }
  call(op, args = {}, options) {
    return this.connection.call(op, { repo: this.repo, tab: this.info.id, ...args }, options);
  }
  async refresh() {
    this.info = { ...this.info, ...(await this.call("info")) };
    return this.info;
  }
  async url() {
    return (await this.refresh()).url;
  }
  async title() {
    return (await this.refresh()).title ?? "";
  }
  async goto(address) {
    const info = await this.call("navigate", { url: address });
    this.info = { ...this.info, ...info };
    return { status: info.status };
  }
  async evaluate(fn, ...args) {
    return this.call("evaluate", { expression: `(${fn})(...${JSON.stringify(args)})` });
  }
  async onElement(ref, fn, ...args) {
    const result = await this.call("evaluate", { expression: onRef(fn, ref, ...args) });
    if (result?.stale) throw problem(400, `找不到 ${ref}：页面变了，ref 已经失效。用 browser_read 取最新的页面结构`, "STALE_REF");
    return result.value;
  }
  async structure() {
    const outline = await this.call("evaluate", { expression: `(${pageOutline})()` });
    return outline || "- （页面上没有标题、链接、按钮或输入框；正文用 browser_read 的 text 读）";
  }
  async screenshot() {
    const shot = await this.call("screenshot", {}, { timeout: 20000 });
    return { data: Buffer.from(shot.data, "base64"), mimeType: shot.mime || "image/jpeg" };
  }
  async point(ref) {
    const point = await this.onElement(ref, elementPoint);
    if (!point.width && !point.height) throw problem(400, `${ref} 现在看不见（大小为 0），点不了：先滚动或打开它所在的菜单`, "HIDDEN");
    return point;
  }
  async click(ref) {
    const { x, y } = await this.point(ref);
    await this.call("input", {
      events: [
        { type: "mouse", action: "move", x, y },
        { type: "mouse", action: "down", x, y, button: "left", clicks: 1 },
        { type: "mouse", action: "up", x, y, button: "left", clicks: 1 },
      ],
    });
  }
  fieldKind(ref) {
    return this.onElement(ref, fieldKind);
  }
  async fill(ref, text, { submit = false } = {}) {
    await this.onElement(ref, focusField);
    await this.call("input", { events: [{ type: "text", text }, ...(submit ? [{ type: "key", key: "Enter" }] : [])] });
  }
  async press(key, ref) {
    if (ref) await this.onElement(ref, focusField);
    await this.call("input", { events: [{ type: "key", key }] });
  }
  async select(ref, text) {
    const result = await this.onElement(ref, chooseOption, text);
    if (!result.ok) throw problem(400, `${ref} 里没有“${text}”这个选项（有：${result.options.join("、") || "无"}）`);
  }
  async hover(ref) {
    const { x, y } = await this.point(ref);
    await this.call("input", { events: [{ type: "mouse", action: "move", x, y }] });
  }
  async scrollTo(ref) {
    await this.point(ref);
  }
  async wheel(dy) {
    await this.call("input", { events: [{ type: "wheel", x: 400, y: 300, dx: 0, dy }] });
  }
  async history(action) {
    await this.call("history", { action });
  }
  async close() {
    await this.call("history", { action: "close" });
  }
  async wait(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  async settle() {
    await this.wait(600);
  }
  /** Tabs to tell apart after an action: a page that opened a new one (the extension gives it to the same AI). */
  mark() {
    return new Set(this.connection.tabs.map((tab) => tab.id));
  }
  async effects(before, session) {
    const opened = this.connection.tabs.find((tab) => !before.has(tab.id) && tab.repo === this.repo && tab.opener === this.info.id);
    if (!opened) return { opened: null, notes: [] };
    return { opened: await this.bridges.driver(this.repo, session, { tab: tabKey(opened.id) }), notes: [] };
  }

  /** Download into the work: the extension fetches with the user's login and streams the file here. */
  async download(work, url, { folder = "public/imports", name, license } = {}) {
    const dir = path.join(this.bridges.services.config.dirs.tmp, "browser", work.repo, "uploads");
    const upload = this.connection.upload(dir);
    let meta;
    try {
      meta = await this.call("fetch", { url, upload: upload.id.padEnd(UPLOAD_HEADER) }, { timeout: 10 * 60 * 1000 });
      await this.connection.finish(upload);
    } catch (error) {
      upload.out.destroy();
      this.connection.uploads.delete(upload.id);
      fs.rmSync(upload.file, { force: true });
      throw error;
    }
    try {
      let base = name || meta.name || decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || "download";
      base = base.replace(/[\\/\x00-\x1f?#%*:|"<>]/g, "_");
      const relative = uniquePath(work.dir, `${folder.replace(/\/$/, "")}/${base}`);
      await writeStream(work.dir, relative, fs.createReadStream(upload.file), { limit: DOWNLOAD_LIMIT });
      this.bridges.services.events.emit({ type: "assets", work: work.id, repo: work.repo });
      return await importedAsset(work, relative, license ?? `下载自 ${url}`);
    } finally {
      fs.rmSync(upload.file, { force: true });
    }
  }

  /** Click a download button: the extension takes the download it starts and hands over its address. */
  async downloadByClick(work, ref, options) {
    const { x, y } = await this.point(ref);
    const started = await this.call("clickDownload", { x, y }, { timeout: 40000 });
    return this.download(work, started.url, { ...options, name: options.name ?? started.filename, license: options.license ?? `下载自 ${await this.url()}` });
  }
}
