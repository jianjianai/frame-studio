// FRAME 连接器 — the service worker. It links this browser to a FRAME Studio and runs what the
// studio's AI asks, but only in the tabs the AI may use: the ones it opened for a repository (in a
// window and tab group of their own) and the ones the user handed over in the popup. Pages run as
// the user, with the user's logins, so the rules are kept here as well as in FRAME: http(s) pages
// only, every other tab out of reach, a tab of one repository out of reach for another, and a
// download carries the user's cookies only to a site the AI's tabs are on.

const PROTOCOL = 1;
/** Each upload chunk starts with the upload's id in this many bytes. */
const HEADER = 16;
const CHUNK = 256 * 1024;
const DETACH_MS = 30 * 1000;

let socket = null;
let status = { state: "unpaired", message: "", repos: [], name: "" };
let reconnect = null;
const waiting = new Set();
/** tab id → timer that detaches the debugger when the AI has left the tab alone for a while */
const attached = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message, status = 400, code = "REMOTE") => Object.assign(new Error(message), { status, code });

// ---- what is kept ----------------------------------------------------------------------------

const settings = () => chrome.storage.local.get(["server", "token", "name"]);
/** The tabs the AI may use (until the browser closes): tab id → { kind: "ai" | "shared", repo, opener } */
const allowed = async () => (await chrome.storage.session.get("tabs")).tabs ?? {};
async function setAllowed(change) {
  const tabs = await allowed();
  change(tabs);
  await chrome.storage.session.set({ tabs });
  queueTabs();
}

function defaultName() {
  const brands = navigator.userAgentData?.brands?.map((brand) => brand.brand).join(" ") ?? navigator.userAgent;
  const browser = /Edge/.test(brands) ? "Edge" : /Chrome|Chromium/.test(brands) ? "Chrome" : "浏览器";
  const platform = navigator.userAgentData?.platform || (/Windows/.test(navigator.userAgent) ? "Windows" : /Mac/.test(navigator.userAgent) ? "macOS" : "Linux");
  return `${browser}（${platform}）`;
}

function setStatus(state, message = "", extra = {}) {
  status = { ...status, state, message, ...extra };
  chrome.action.setBadgeText({ text: state === "online" ? "" : state === "unpaired" ? "" : "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#e3a948" });
  for (const resolve of waiting) resolve();
  waiting.clear();
}
const changed = (timeout = 10000) => new Promise((resolve) => (waiting.add(resolve), setTimeout(resolve, timeout)));

// ---- the connection --------------------------------------------------------------------------

async function connect({ code } = {}) {
  const { server, token, name } = await settings();
  if (!server || (!token && !code)) return setStatus("unpaired");
  if (socket && socket.readyState <= 1) {
    if (!code) return;
    socket.close();
  }
  clearTimeout(reconnect);
  let url;
  try {
    url = new URL("/api/browser/bridge", server);
  } catch {
    return setStatus("unpaired", "FRAME 地址不对");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  socket = ws;
  setStatus("connecting");
  ws.onopen = () => ws.send(JSON.stringify({ type: code ? "pair" : "hello", protocol: PROTOCOL, code, token, name: name || defaultName() }));
  ws.onmessage = (event) => void receive(JSON.parse(event.data));
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    if (status.state === "online" || status.state === "connecting") {
      setStatus("offline", "和 FRAME 断开了，正在重连…");
      reconnect = setTimeout(() => void connect(), 5000);
    }
  };
}

const send = (message) => socket?.readyState === 1 && socket.send(JSON.stringify(message));

async function receive(message) {
  if (message.type === "welcome") {
    if (message.token) await chrome.storage.local.set({ token: message.token });
    setStatus("online", "", { repos: message.repos ?? [], name: message.name });
    await pushTabs();
  } else if (message.type === "ping") send({ type: "pong" });
  else if (message.type === "error") {
    if (message.code === "UNPAIRED") await chrome.storage.local.remove("token");
    setStatus(message.code === "UNPAIRED" ? "unpaired" : "refused", message.message);
  } else if (message.type === "call") {
    try {
      const op = OPS[message.op];
      if (!op) throw fail(`FRAME 连接器不会 ${message.op}：请更新扩展`);
      if (!status.repos.some((repo) => repo.id === message.args?.repo)) throw fail("这个浏览器没有连接这个作品库", 403, "NOT_ALLOWED");
      send({ type: "result", id: message.id, ok: true, data: (await op(message.args)) ?? null });
    } catch (error) {
      send({ type: "result", id: message.id, ok: false, error: error.message, code: error.code, status: error.status });
    }
  }
}

// ---- tabs the AI may use ---------------------------------------------------------------------

let tabsTimer = null;
function queueTabs() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(() => void pushTabs(), 200);
}
async function pushTabs() {
  const tabs = await allowed();
  const list = [];
  for (const [id, entry] of Object.entries(tabs)) {
    const tab = await chrome.tabs.get(Number(id)).catch(() => null);
    if (tab) list.push({ id: tab.id, title: tab.title ?? "", url: tab.url ?? tab.pendingUrl ?? "", loading: tab.status === "loading", active: tab.active, ...entry });
  }
  send({ type: "tabs", tabs: list });
  return list;
}

async function access({ tab: id, repo }, { own = false } = {}) {
  const entry = (await allowed())[id];
  if (!entry || entry.repo !== repo) throw fail("这个标签页没有交给这个作品库的 AI", 403, "NOT_ALLOWED");
  if (own && entry.kind !== "ai") throw fail("这是用户的标签页，由用户自己操作", 403, "USER_ONLY");
  const tab = await chrome.tabs.get(Number(id)).catch(() => null);
  if (!tab) throw fail("标签页已经关了", 404, "NOT_FOUND");
  return { tab, entry };
}

/** Pages the AI may open: the web, nothing of the browser or the computer. */
function web(address) {
  if (address === "about:blank") return address;
  let url;
  try {
    url = new URL(address);
  } catch {
    throw fail("网址不对");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw fail("只能打开 http/https 网址");
  return url.href;
}

/** The part of a host a login belongs to (www.sketchfab.com → sketchfab.com, a.b.com.cn → b.com.cn). */
function siteOf(host) {
  const labels = String(host).toLowerCase().split(".");
  if (labels.length <= 2 || /^\d+$/.test(labels.at(-1))) return labels.join(".");
  const keep = labels.at(-1).length === 2 && /^(com|net|org|gov|edu|co|ac|or|ne)$/.test(labels.at(-2)) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** The AI's own window: its tabs open there, out of the user's way. */
async function aiWindow() {
  const { aiWindow: id } = await chrome.storage.session.get("aiWindow");
  if (id && (await chrome.windows.get(id).catch(() => null))) return id;
  const created = await chrome.windows.create({ url: "about:blank", focused: false });
  await chrome.storage.session.set({ aiWindow: created.id, aiGroup: null });
  return { created };
}

async function group(tab) {
  try {
    const { aiGroup } = await chrome.storage.session.get("aiGroup");
    const groupId = await chrome.tabs.group(aiGroup && (await chrome.tabGroups.get(aiGroup).catch(() => null)) ? { tabIds: tab.id, groupId: aiGroup } : { tabIds: tab.id, createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: "FRAME AI", color: "purple" });
    await chrome.storage.session.set({ aiGroup: groupId });
  } catch {}
}

/** Load an address in a tab and wait until it has loaded (at most 30 seconds). */
function go(tabId, url) {
  return new Promise((resolve) => {
    let started = false;
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, change) => {
      if (id !== tabId) return;
      if (change.status === "loading") started = true;
      if (change.status === "complete" && started) done();
    };
    const timer = setTimeout(done, 30000);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(done);
  });
}

async function info(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return { id: tab.id, title: tab.title ?? "", url: tab.url ?? tab.pendingUrl ?? "", loading: tab.status === "loading", active: tab.active };
}

// ---- the page, through the DevTools protocol -------------------------------------------------

async function cdp(tabId, method, params = {}) {
  const target = { tabId: Number(tabId) };
  if (!attached.has(target.tabId)) {
    try {
      await chrome.debugger.attach(target, "1.3");
    } catch (error) {
      if (!/already attached/i.test(error.message)) throw fail(`不能操作这个标签页：${error.message}`, 409);
    }
  }
  clearTimeout(attached.get(target.tabId));
  attached.set(
    target.tabId,
    setTimeout(() => {
      attached.delete(target.tabId);
      chrome.debugger.detach(target).catch(() => {});
    }, DETACH_MS),
  );
  return chrome.debugger.sendCommand(target, method, params);
}
chrome.debugger.onDetach.addListener((source) => {
  clearTimeout(attached.get(source.tabId));
  attached.delete(source.tabId);
});

async function evaluate(tabId, expression) {
  const result = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw fail("网页里的脚本出错：" + (result.exceptionDetails.exception?.description || result.exceptionDetails.text), 500);
  return result.result?.value;
}

const KEYS = { Enter: [13, "\r"], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], PageUp: [33], PageDown: [34], Home: [36], End: [35], Space: [32, " "], " ": [32, " "] };
const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

async function dispatch(tabId, event) {
  if (event.type === "mouse") {
    const type = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" }[event.action];
    const button = event.action === "move" ? "none" : event.button || "left";
    await cdp(tabId, "Input.dispatchMouseEvent", { type, x: event.x, y: event.y, button, buttons: event.action === "down" ? 1 : 0, clickCount: event.clicks || (event.action === "move" ? 0 : 1) });
  } else if (event.type === "wheel") {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: event.x, y: event.y, deltaX: event.dx || 0, deltaY: event.dy || 0 });
  } else if (event.type === "text") {
    await cdp(tabId, "Input.insertText", { text: String(event.text) });
  } else if (event.type === "key") {
    const parts = String(event.key).split("+");
    const key = parts.pop() || "+";
    const modifiers = parts.reduce((sum, name) => sum | (MODIFIERS[name] ?? 0), 0);
    const known = KEYS[key];
    const code = known?.[0] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const text = modifiers & ~MODIFIERS.Shift ? undefined : (known?.[1] ?? (key.length === 1 ? key : undefined));
    await cdp(tabId, "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, windowsVirtualKeyCode: code, modifiers, ...(text ? { text } : {}) });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code, modifiers });
  }
}

// ---- what FRAME asks -------------------------------------------------------------------------

const OPS = {
  /** A new tab for a repository's AI, in the AI's window. */
  async create({ repo, url }) {
    const target = web(url || "about:blank");
    const place = await aiWindow();
    const tab = place.created ? place.created.tabs[0] : await chrome.tabs.create({ windowId: place, url: "about:blank", active: true });
    await setAllowed((tabs) => (tabs[tab.id] = { kind: "ai", repo }));
    await group(tab);
    if (target !== "about:blank") await go(tab.id, target);
    // FRAME looks the tab up in the list right after: send it first.
    await pushTabs();
    return info(tab.id);
  },
  async navigate(args) {
    const { tab } = await access(args);
    await go(tab.id, web(args.url));
    return info(tab.id);
  },
  async info(args) {
    const { tab } = await access(args);
    return info(tab.id);
  },
  async evaluate(args) {
    const { tab } = await access(args);
    return evaluate(tab.id, String(args.expression));
  },
  async input(args) {
    const { tab } = await access(args);
    for (const event of args.events ?? []) await dispatch(tab.id, event);
    return true;
  },
  async screenshot(args) {
    const { tab, entry } = await access(args);
    // A tab in the back draws nothing: the AI's own come to the front of the AI's window.
    if (!tab.active) {
      if (entry.kind !== "ai") throw fail("用户的这个标签页不在前台，截不了图：请用户切到它，或者只读页面结构", 409);
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(400);
    }
    const shot = await cdp(tab.id, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
    return { data: shot.data, mime: "image/jpeg" };
  },
  async history(args) {
    const { tab } = await access(args, { own: args.action === "close" });
    if (args.action === "close") {
      await chrome.tabs.remove(tab.id);
      return { closed: true };
    }
    if (args.action === "back") await chrome.tabs.goBack(tab.id).catch(() => {});
    else if (args.action === "forward") await chrome.tabs.goForward(tab.id).catch(() => {});
    else await chrome.tabs.reload(tab.id);
    await sleep(800);
    return info(tab.id);
  },
  /** Bring a tab in front of the user (to log in there). */
  async focus(args) {
    const { tab } = await access(args);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  },
  /** Click a download button and take the download it starts: its address goes to FRAME instead of the disk. */
  async clickDownload(args) {
    const { tab } = await access(args);
    const started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.downloads.onCreated.removeListener(listener);
        reject(fail("30 秒内没有开始下载：这个按钮可能先打开了别的页面或对话框", 504, "TIMEOUT"));
      }, 30000);
      const listener = async (item) => {
        chrome.downloads.onCreated.removeListener(listener);
        clearTimeout(timer);
        await chrome.downloads.cancel(item.id).catch(() => {});
        await chrome.downloads.erase({ id: item.id }).catch(() => {});
        const url = item.finalUrl || item.url;
        if (/^(blob|data):/.test(url)) return reject(fail("这是网页自己生成的文件（blob:），不能转给 FRAME：请用户自己下载后上传", 400));
        resolve({ url, filename: (item.filename || "").split(/[\\/]/).pop(), mime: item.mime, size: item.totalBytes });
      };
      chrome.downloads.onCreated.addListener(listener);
    });
    for (const action of ["move", "down", "up"]) await dispatch(tab.id, { type: "mouse", action, x: args.x, y: args.y, button: "left", clicks: 1 });
    return started;
  },
  /**
   * Download a file and stream it to FRAME (binary messages: the upload id, then the bytes). It is
   * loaded by the tab's own page, the way DevTools loads a resource, so the site's cookies come
   * along as for the page itself — but only for a site one of this repository's AI tabs is on.
   */
  async fetch(args) {
    const { tab } = await access(args);
    const target = web(args.url);
    const sites = new Set();
    for (const [id, entry] of Object.entries(await allowed())) {
      if (entry.repo !== args.repo) continue;
      const other = await chrome.tabs.get(Number(id)).catch(() => null);
      if (other?.url && /^https?:/.test(other.url)) sites.add(siteOf(new URL(other.url).hostname));
    }
    const includeCredentials = sites.has(siteOf(new URL(target).hostname));
    const { frameTree } = await cdp(tab.id, "Page.getFrameTree");
    const { resource } = await cdp(tab.id, "Network.loadNetworkResource", { frameId: frameTree.frame.id, url: target, options: { disableCache: false, includeCredentials } });
    const code = resource.httpStatusCode;
    if (!resource.success || !resource.stream || code >= 400)
      throw fail(`下载失败：${code ? `HTTP ${code}` : resource.netErrorName || "连不上"}${code === 401 || code === 403 ? "（可能要先登录）" : ""}`, 502);
    const header = new TextEncoder().encode(String(args.upload).padEnd(HEADER).slice(0, HEADER));
    let size = 0;
    try {
      for (;;) {
        const chunk = await cdp(tab.id, "IO.read", { handle: resource.stream, size: CHUNK });
        const part = chunk.base64Encoded ? Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0)) : new TextEncoder().encode(chunk.data);
        if (part.length) {
          const frame = new Uint8Array(HEADER + part.length);
          frame.set(header);
          frame.set(part, HEADER);
          while (socket && socket.bufferedAmount > 8 * 1024 * 1024) await sleep(50);
          if (!socket || socket.readyState !== 1) throw fail("和 FRAME 断开了", 409, "OFFLINE");
          socket.send(frame);
          size += part.length;
        }
        if (chunk.eof) break;
      }
    } finally {
      await cdp(tab.id, "IO.close", { handle: resource.stream }).catch(() => {});
    }
    const headers = Object.fromEntries(Object.entries(resource.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const disposition = headers["content-disposition"] || "";
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
    return { status: code, mime: headers["content-type"] ?? null, name: encoded ? decodeURIComponent(encoded) : plain || null, size };
  },
};

// ---- tabs come and go ------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener(async (id, change) => {
  if ((change.title || change.url || change.status) && (await allowed())[id]) queueTabs();
});
chrome.tabs.onRemoved.addListener(async (id) => {
  if ((await allowed())[id]) await setAllowed((tabs) => delete tabs[id]);
});
// A page the AI uses opened another (a login window, a new tab): it goes with its opener.
chrome.tabs.onCreated.addListener(async (tab) => {
  const opener = tab.openerTabId && (await allowed())[tab.openerTabId];
  if (opener) await setAllowed((tabs) => (tabs[tab.id] = { kind: opener.kind, repo: opener.repo, opener: tab.openerTabId }));
});

// ---- the popup -------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  (async () => {
    if (message.type === "pair") {
      await chrome.storage.local.set({ server: message.server, name: message.name || defaultName() });
      void connect({ code: message.code });
      await changed();
      while (status.state === "connecting") await changed();
    } else if (message.type === "share") await setAllowed((tabs) => (tabs[message.tab] = { kind: "shared", repo: message.repo }));
    else if (message.type === "unshare") await setAllowed((tabs) => delete tabs[message.tab]);
    else if (message.type === "unpair") {
      await chrome.storage.local.remove("token");
      await chrome.storage.session.set({ tabs: {} });
      socket?.close();
      socket = null;
      setStatus("unpaired");
    } else if (message.type === "reconnect") void connect();
    const { server, token } = await settings();
    const tabs = [];
    for (const [id, entry] of Object.entries(await allowed())) {
      const tab = await chrome.tabs.get(Number(id)).catch(() => null);
      if (tab) tabs.push({ id: tab.id, title: tab.title, url: tab.url, ...entry });
    }
    reply({ status, server, paired: Boolean(token), tabs, defaultName: defaultName() });
  })().catch((error) => reply({ error: error.message }));
  return true;
});

// ---- staying connected -----------------------------------------------------------------------

// The service worker stops when idle; the socket's pings keep it awake, the alarm brings it back.
chrome.alarms.create("frame-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
void connect();
