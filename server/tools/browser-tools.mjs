import sharp from "sharp";
import { z } from "zod";
import { workArg } from "./registry.mjs";
import { importFromUrl, importedAsset } from "./asset-tools.mjs";
import { fieldKind, pageLinks, pageMedia, pageText } from "../browser-page.mjs";
import { problem } from "../util.mjs";

const tabArg = z
  .string()
  .regex(/^(t[0-9a-f]{6}|x\d+)$/)
  .optional()
  .describe("标签页 id（结果里写的：t… 是服务器上的浏览器，x… 是用户电脑上的浏览器）；不写就是这个对话自己的标签页");
const refArg = z
  .string()
  .regex(/^(f\d+)?e\d+$/)
  .optional()
  .describe("元素：页面结构里的 [ref=…]（例如 e12）");
const whereArg = z
  .enum(["auto", "computer", "server"])
  .default("auto")
  .describe(
    "用哪个浏览器：computer 是用户电脑上的浏览器（装了 FRAME 连接器扩展，用户自己已经登录的网站都能用）；server 是服务器上的浏览器（每个作品库一个，用户在「浏览器」标签页里登录；browser_cookies 导出的是它的登录）；auto 先用这个对话已经在用的，否则电脑上的浏览器连着就用它，不然用服务器上的",
  );

/** Size in words. */
const bytes = (size) => (size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`);

/** A picture for the AI: at most 1280 wide (a phone viewer or a high-density screen draws it larger). */
async function fit(image) {
  const meta = await sharp(image.data).metadata();
  return meta.width > 1280 ? { data: await sharp(image.data).resize({ width: 1280 }).jpeg({ quality: 70 }).toBuffer(), mimeType: "image/jpeg" } : image;
}

/**
 * A page's structure for the AI (roles, names, [ref=…] for what can be clicked or typed into).
 * `query` keeps the lines that mention it, with the line above for context; a long one is cut
 * at `max` characters.
 */
export function formatStructure(text, { query, max = 8000 } = {}) {
  if (!text) return "（读不到页面结构：页面可能还在载入，稍后再读，或者看截图）";
  if (query) {
    const lines = text.split("\n");
    const wanted = query.toLowerCase();
    const keep = new Set();
    lines.forEach((line, index) => {
      if (!line.toLowerCase().includes(wanted)) return;
      if (index > 0) keep.add(index - 1);
      keep.add(index);
    });
    if (!keep.size) return `页面结构里没有“${query}”（${lines.length} 行）`;
    text = [...keep]
      .sort((a, b) => a - b)
      .map((index) => lines[index])
      .join("\n");
  }
  if (text.length > max) text = `${text.slice(0, max)}\n…（还有 ${text.length - max} 字没显示：用 query 只看含某些字的部分，max 看更多，或 browser_read 的 text 读正文）`;
  return `页面结构（[ref=…] 是能点、能输入的元素，browser_act 用 ref 指定）：\n${text}`;
}

const staleRef = (error, ref) =>
  error?.code === "STALE_REF" || /aria-ref|not found|No element|resolved to 0/i.test(String(error?.message))
    ? problem(400, `找不到 ${ref}：页面变了，ref 已经失效。用 browser_read 取最新的页面结构`, "STALE_REF")
    : /Timeout/i.test(String(error?.message)) && error?.code !== "TIMEOUT"
      ? problem(504, `${ref} 10 秒内没能操作（被别的东西挡住、看不见或不能用）：用 browser_read（screenshot: true）看看`, "TIMEOUT")
      : error;

/**
 * A tab of the server's browser (Playwright) in the shape the tools use; tabs in the user's own
 * browser have the same (RemoteDriver in browser-bridge.mjs).
 */
class ServerDriver {
  constructor(services, browser, tab) {
    this.services = services;
    this.browser = browser;
    this.tab = tab;
    this.page = tab.page;
    this.id = tab.id;
    this.owner = tab.owner;
    this.where = "server";
    this.label = `服务器上的浏览器${tab.owner === "user" ? "，用户打开的标签页" : ""}`;
    this.viewportHeight = tab.viewport?.height ?? 800;
  }
  element(ref) {
    if (!ref) throw problem(400, "要指定 ref（页面结构里的 [ref=…]）");
    return this.page.locator(`aria-ref=${ref}`);
  }
  async url() {
    return this.page.url();
  }
  title() {
    return this.page.title().catch(() => "");
  }
  async goto(address) {
    const response = await this.browser.goto(this.tab, address);
    return { status: response?.status() };
  }
  evaluate(fn, ...args) {
    return this.page.evaluate(fn, ...args);
  }
  structure() {
    return this.page.ariaSnapshot({ mode: "ai", timeout: 10000 }).catch(() => "");
  }
  async screenshot() {
    return { data: await this.page.screenshot({ type: "jpeg", quality: 70, scale: "css", timeout: 15000 }), mimeType: "image/jpeg" };
  }
  click(ref) {
    return this.element(ref).click({ timeout: 10000 });
  }
  fieldKind(ref) {
    return this.element(ref).evaluate(fieldKind);
  }
  async fill(ref, text, { submit = false } = {}) {
    await this.element(ref).fill(text, { timeout: 10000 });
    if (submit) await this.element(ref).press("Enter");
  }
  press(key, ref) {
    return ref ? this.element(ref).press(key, { timeout: 10000 }) : this.page.keyboard.press(key);
  }
  select(ref, text) {
    return this.element(ref)
      .selectOption({ label: text }, { timeout: 10000 })
      .catch(() => this.element(ref).selectOption(text, { timeout: 10000 }));
  }
  hover(ref) {
    return this.element(ref).hover({ timeout: 10000 });
  }
  scrollTo(ref) {
    return this.element(ref).scrollIntoViewIfNeeded({ timeout: 10000 });
  }
  wheel(dy) {
    return this.page.mouse.wheel(0, dy);
  }
  async history(action) {
    const options = { timeout: 15000 };
    await (action === "back" ? this.page.goBack(options) : action === "forward" ? this.page.goForward(options) : this.page.reload(options)).catch(() => {});
  }
  close() {
    return this.page.close();
  }
  wait(ms) {
    return this.page.waitForTimeout(ms);
  }
  /** Wait for what an action set off: a navigation to show its page, a popup, a download. */
  async settle() {
    await this.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await this.page.waitForTimeout(400);
  }
  mark() {
    return { tabs: new Set(this.browser.tabs.keys()), at: Date.now() };
  }
  /** What an action set off: a new tab (a site's popup), downloads. */
  async effects(before) {
    const notes = [];
    for (const item of this.browser.listDownloads().filter((download) => download.tab === this.id && download.at >= before.at))
      notes.push(`开始下载了 ${item.name}（下载 id ${item.id}，${item.state === "done" ? bytes(item.size) : "还在下载"}）：用 browser_download 的 download 参数放进作品`);
    const opened = [...this.browser.tabs.values()].find((item) => !before.tabs.has(item.id) && item.opener === this.id);
    return { opened: opened ? new ServerDriver(this.services, this.browser, opened) : null, notes };
  }
  /** Download with this tab's cookies, agent and page as the referrer (every address on the way gets its own cookies). */
  async download(work, url, { folder, name, license } = {}) {
    const relative = await importFromUrl(work, url, { name, folder, publicOnly: this.services.auth.required, headers: (address) => this.browser.headersFor(this.tab, address) });
    this.services.events.emit({ type: "assets", work: work.id, repo: work.repo });
    return importedAsset(work, relative, license ?? `下载自 ${url}`);
  }
  async downloadByClick(work, ref, { folder, name, license } = {}) {
    const item = await this.browser.expectDownload(this.tab, () => this.click(ref));
    return this.browser.importDownload(work, item.id, { folder, name, license: license ?? `下载自 ${this.page.url()}` });
  }
}

/** What the tab shows now: which browser and tab, where it is, its structure, optionally its picture. */
async function report(driver, { query, max, screenshot = false, structure = true, notes = [] } = {}) {
  const [title, url] = [await driver.title(), await driver.url()];
  const lines = [`标签页 ${driver.id}（${driver.label}）：${title || "（无标题）"}`, `地址：${url}`, ...notes];
  const parts = [lines.join("\n")];
  if (structure) parts.push(formatStructure(await driver.structure(), { query, max }));
  return {
    data: { tab: driver.id, where: driver.where, title, url },
    text: parts.join("\n\n"),
    images: screenshot ? [await fit(await driver.screenshot())] : [],
  };
}

export function registerBrowserTools(registry) {
  const { services } = registry;
  const sessionOf = (ctx) => ctx.scope.session ?? "external";
  const common = { signedIn: true };

  /**
   * The tab a tool works in, in the browser of the work's repository: the one named (t… on the
   * server, x… on the user's computer), else the conversation's own; `create` opens one when it
   * has none (`newTab`: always), in the browser `where` picks.
   */
  async function driverFor(ctx, { tab, where = "auto", create = false, newTab = false } = {}) {
    const work = await ctx.work();
    const session = sessionOf(ctx);
    const browser = services.browsers.of(work.repo);
    const bridges = services.bridges;
    const onServer = async (options) => new ServerDriver(services, browser, await browser.tabFor(session, options));
    if (tab) return tab.startsWith("x") ? bridges.driver(work.repo, session, { tab }) : onServer({ tab });
    const computer = bridges.connected(work.repo);
    if (where === "computer" && !computer)
      throw problem(409, "用户电脑上的浏览器没有连着 FRAME：请用户打开装了 FRAME 连接器的浏览器，或者在「浏览器」标签页里配对；也可以用服务器上的浏览器（where: \"server\"）", "OFFLINE");
    if (newTab) {
      if (where === "computer" || (where === "auto" && computer)) return bridges.driver(work.repo, session, { create: true });
      const created = await browser.newTab({ owner: "ai", session });
      return onServer({ tab: created.id });
    }
    const remote = where !== "server" && bridges.sessionTab(work.repo, session);
    if (remote) return bridges.driver(work.repo, session, { tab: remote });
    const local = where !== "computer" && browser.sessionTabs.has(session);
    if (local) return onServer({});
    if (!create) throw problem(400, "这个对话还没有打开网页：先用 browser_open 打开一个网址", "NO_TAB");
    if (where === "computer" || (where === "auto" && computer)) return bridges.driver(work.repo, session, { create: true });
    return onServer({ create: true });
  }

  registry.add({
    name: "browser_open",
    title: "打开网页",
    ...common,
    readOnly: true,
    description:
      "在带登录状态的浏览器里打开网页。有两个：用户电脑上的浏览器（装了 FRAME 连接器扩展时，用户自己已经登录的网站都能用，你只能用自己开的标签页和用户交给你的）；服务器上的浏览器（每个作品库一个，用户在「浏览器」标签页里登录）。where 选哪个，默认电脑上的连着就用它。每个对话有自己的标签页（newTab 再开一个）；结果是页面结构（[ref=…] 给 browser_act），screenshot 要截图。要登录时用 browser_login 请用户登录，不要自己填账号密码。只浏览和下载：不发帖、评论、私信、点赞、关注、购买，不改账号设置。",
    input: {
      work: workArg,
      url: z.string().min(1).max(4000).describe("网址"),
      tab: tabArg,
      newTab: z.boolean().default(false).describe("在新标签页打开（同时看几个网页时）"),
      where: whereArg,
      query: z.string().max(200).optional().describe("页面结构只看含这些字的行"),
      max: z.number().int().min(500).max(40000).default(8000).describe("页面结构最多多少字"),
      screenshot: z.boolean().default(false).describe("同时截图"),
    },
    async run({ url, tab, newTab, where, query, max, screenshot }, ctx) {
      const driver = await driverFor(ctx, { tab, where, create: true, newTab });
      const { status } = await driver.goto(url);
      return report(driver, { query, max, screenshot, notes: status && status >= 400 ? [`HTTP ${status}`] : [] });
    },
  });

  registry.add({
    name: "browser_read",
    title: "读网页",
    ...common,
    readOnly: true,
    description:
      "读浏览器标签页里的网页：snapshot 页面结构（默认，带 [ref=…]）；text 正文文字（offset 翻页）；links 链接（文字 → 地址）；media 图片、视频、音频的地址和尺寸（下载用 browser_download 的 url）。query 只看含某些字的部分；screenshot 截图。不写 tab 就是这个对话自己的标签页；用户正在看的服务器标签页写在 [FRAME] 里，用户交给你的电脑上的标签页由 browser_tabs 列出。",
    input: {
      work: workArg,
      tab: tabArg,
      what: z.enum(["snapshot", "text", "links", "media"]).default("snapshot"),
      query: z.string().max(200).optional().describe("只看含这些字的部分（不分大小写）"),
      offset: z.number().int().min(0).default(0).describe("text：从第几个字开始"),
      max: z.number().int().min(500).max(40000).default(10000).describe("最多多少字"),
      screenshot: z.boolean().default(false),
    },
    async run({ tab, what, query, offset, max, screenshot }, ctx) {
      const driver = await driverFor(ctx, { tab });
      if (what === "snapshot") return report(driver, { query, max, screenshot });
      let body;
      if (what === "text") {
        let text = String((await driver.evaluate(pageText).catch(() => "")) ?? "");
        if (query) {
          const wanted = query.toLowerCase();
          text = text
            .split("\n")
            .filter((line) => line.toLowerCase().includes(wanted))
            .join("\n");
        }
        const part = text.slice(offset, offset + max);
        body = `正文（${offset}–${offset + part.length} / ${text.length} 字）：\n${part || "（没有文字）"}${offset + part.length < text.length ? `\n…（接着读：offset ${offset + part.length}）` : ""}`;
      } else if (what === "links") {
        const links = (await driver.evaluate(pageLinks)) ?? [];
        const wanted = query?.toLowerCase();
        const shown = links.filter((link) => !wanted || link.href.toLowerCase().includes(wanted) || link.text.toLowerCase().includes(wanted));
        let lines = shown.map((link) => `- ${link.text || "（无文字）"} → ${link.href}`).join("\n");
        if (lines.length > max) lines = lines.slice(0, max) + "\n…（还有更多：用 query 筛选）";
        body = `链接 ${shown.length} 个${query ? `（含“${query}”，共 ${links.length} 个）` : ""}：\n${lines || "（没有）"}`;
      } else {
        const media = (await driver.evaluate(pageMedia)) ?? [];
        const wanted = query?.toLowerCase();
        const seen = new Set();
        const lines = [];
        for (const item of media) {
          if (seen.has(item.src) || (wanted && !`${item.src} ${item.text ?? ""}`.toLowerCase().includes(wanted))) continue;
          seen.add(item.src);
          const src = item.src.startsWith("data:") ? `data:…（内嵌 ${item.src.length} 字）` : item.src;
          const extra = [item.size, item.duration ? `${item.duration} 秒` : "", item.text ? `“${item.text.slice(0, 60)}”` : "", item.poster ? `封面 ${item.poster}` : ""].filter(Boolean).join("，");
          lines.push(`- ${item.kind}${extra ? `（${extra}）` : ""}：${src}`);
        }
        let text = lines.join("\n");
        if (text.length > max) text = text.slice(0, max) + "\n…（还有更多：用 query 筛选）";
        const blob = media.some((item) => item.src.startsWith("blob:"));
        body = `媒体 ${lines.length} 个：\n${text || "（没有）"}${blob ? "\n\nblob: 地址是网页播放时拼出来的流，不能直接下载：视频网站用 yt-dlp 加 browser_cookies 的登录信息（服务器上的浏览器）下载原视频。" : ""}`;
      }
      const head = await report(driver, { structure: false, screenshot });
      return { ...head, text: `${head.text}\n\n${body}` };
    },
  });

  registry.add({
    name: "browser_tabs",
    title: "列出标签页",
    ...common,
    readOnly: true,
    description:
      "列出你能用的浏览器标签页：服务器上的浏览器的（t…），和用户电脑上的浏览器里你开的、用户交给你的（x…，用户在 FRAME 连接器里点「让 AI 使用这个页面」）。",
    input: { work: workArg },
    async run(_args, ctx) {
      const work = await ctx.work();
      const session = sessionOf(ctx);
      const browser = services.browsers.of(work.repo);
      const own = { server: browser.sessionTabs.get(session), computer: services.bridges.sessionTab(work.repo, session) };
      const server = browser.list().map((tab) => ({ ...tab, where: "server" }));
      const computer = services.bridges.remoteTabs(work.repo).map((tab) => ({ ...tab, where: "computer" }));
      const line = (tab) =>
        `- ${tab.id}：${tab.title || "（无标题）"}（${tab.url}）${tab.owner === "user" ? "，用户的" : ""}${tab.id === own.server || tab.id === own.computer ? "，这个对话在用" : ""}`;
      const online = services.bridges.connected(work.repo);
      const text = [
        `用户电脑上的浏览器：${online ? `连着（${services.bridges.connection(work.repo).bridge.name}）` : "没有连着"}`,
        ...computer.map(line),
        `服务器上的浏览器：${server.length ? "" : "没有打开的标签页"}`,
        ...server.map(line),
      ].join("\n");
      return { data: { computer, server, online }, text };
    },
  });

  registry.add({
    name: "browser_act",
    title: "操作网页",
    ...common,
    readOnly: true,
    description:
      "在浏览器标签页里操作：click 点击、type 在输入框（搜索框等）里输入（submit 再按回车）、press 按键（Enter、Escape、ArrowDown、PageDown…）、select 选下拉选项、hover、scroll 滚动（up/down，或滚到 ref）、back/forward/reload、close 关掉标签页（只关你自己开的）、wait 等一会儿。元素用最新页面结构里的 ref。结果是操作后的页面结构（screenshot 要截图）。只为了浏览和下载而操作：不要点发布、评论、私信、点赞、关注、购买、修改设置这类会以用户身份产生影响的按钮；密码框、登录表单和评论框不能填，登录交给 browser_login。",
    input: {
      work: workArg,
      tab: tabArg,
      action: z.enum(["click", "type", "press", "select", "hover", "scroll", "back", "forward", "reload", "close", "wait"]),
      ref: refArg,
      text: z.string().max(2000).optional().describe("type：要输入的文字；select：选项的文字"),
      submit: z.boolean().default(false).describe("type：输入后按回车"),
      key: z.string().max(40).optional().describe("press：按键，例如 Enter、Escape、ArrowDown、PageDown、Control+A"),
      direction: z.enum(["up", "down"]).default("down").describe("scroll：方向（没有 ref 时滚动整页）"),
      amount: z.number().min(0.1).max(20).default(1).describe("scroll：滚动几屏"),
      ms: z.number().int().min(100).max(15000).default(1500).describe("wait：等多少毫秒"),
      query: z.string().max(200).optional().describe("结果的页面结构只看含这些字的行"),
      max: z.number().int().min(500).max(40000).default(8000),
      screenshot: z.boolean().default(false),
    },
    async run({ tab, action, ref, text, submit, key, direction, amount, ms, query, max, screenshot }, ctx) {
      const session = sessionOf(ctx);
      const driver = await driverFor(ctx, { tab });
      const before = driver.mark();
      try {
        switch (action) {
          case "click":
            await driver.click(ref);
            break;
          case "type": {
            if (text === undefined) throw problem(400, "type 要写 text");
            const kind = await driver.fieldKind(ref);
            if (kind === "password" || kind === "login") throw problem(403, "账号、密码由用户自己填：用 browser_login 请用户登录", "USER_ONLY");
            if (kind === "prose") throw problem(403, "这是写评论、发帖、私信这类内容的输入框：在登录状态的浏览器里 AI 只浏览和下载，不替用户发言。需要的话请用户自己输入", "USER_ONLY");
            if (kind === "other") throw problem(400, `${ref} 不是输入框（选项用 select，按钮用 click）`);
            await driver.fill(ref, text, { submit });
            break;
          }
          case "press":
            if (!key) throw problem(400, "press 要写 key");
            await driver.press(key, ref);
            break;
          case "select":
            if (text === undefined) throw problem(400, "select 要写 text（选项的文字）");
            await driver.select(ref, text);
            break;
          case "hover":
            await driver.hover(ref);
            break;
          case "scroll":
            if (ref) await driver.scrollTo(ref);
            else await driver.wheel((direction === "up" ? -1 : 1) * amount * driver.viewportHeight * 0.85);
            break;
          case "back":
          case "forward":
          case "reload":
            await driver.history(action);
            break;
          case "close": {
            if (driver.owner === "user") throw problem(403, "这是用户的标签页，由用户自己关", "USER_ONLY");
            await driver.close();
            return { data: { closed: driver.id }, text: `已关掉标签页 ${driver.id}` };
          }
          case "wait":
            await driver.wait(ms);
            break;
        }
      } catch (error) {
        throw ref ? staleRef(error, ref) : error;
      }
      await driver.settle();
      const { opened, notes } = await driver.effects(before, session);
      if (opened) {
        await opened.settle();
        notes.push(`网页打开了新标签页 ${opened.id}，下面是它（这个对话之后默认用它；回到原来的写 tab: "${driver.id}"）`);
        return report(opened, { query, max, screenshot, notes });
      }
      return report(driver, { query, max, screenshot, notes });
    },
  });

  registry.add({
    name: "browser_download",
    title: "从网页下载",
    ...common,
    description:
      "用浏览器的登录状态把文件下载进作品的 public/（返回代码里用的 films/... 地址）：url 直接下载一个地址（带上这个网站的登录信息，图片、模型、音频、视频文件的地址用 browser_read 的 media 或 links 找）；ref 点击网页上的下载按钮并保存下载的文件；download 是服务器浏览器里之前点击开始的下载（browser_act 的结果里写了 id）。用哪个浏览器的登录跟着 tab（不写就是这个对话的标签页）。license 写清来源与许可（记在 production/licenses.md）。网页里的 blob: 视频流下载不了：视频网站用 yt-dlp 加 browser_cookies。",
    input: {
      work: workArg,
      tab: tabArg,
      url: z.string().url().max(4000).optional(),
      ref: refArg,
      download: z
        .string()
        .regex(/^d[0-9a-f]{6}$/)
        .optional()
        .describe("服务器浏览器里已经下载好的文件的 id"),
      name: z.string().max(120).optional().describe("保存的文件名"),
      folder: z
        .string()
        .regex(/^public(\/[\w.-]+)*$/)
        .default("public/imports")
        .describe("保存到哪个文件夹"),
      license: z.string().max(500).optional().describe("来源与许可"),
    },
    async run({ tab, url, ref, download, name, folder, license }, ctx) {
      if ([url, ref, download].filter(Boolean).length !== 1) throw problem(400, "url、ref、download 必须且只能写一个");
      const work = await ctx.work();
      const browser = services.browsers.of(work.repo);
      const options = { folder, name, license };
      let result;
      if (download) result = await browser.importDownload(work, download, options);
      else if (url) {
        if (/^(blob|data):/.test(url)) throw problem(400, "blob:/data: 地址是网页里的数据，不能下载：用 ref 点下载按钮，或者用 yt-dlp 加 browser_cookies");
        const driver = await driverFor(ctx, { tab }).catch((error) => {
          if (error.code !== "NO_TAB") throw error;
          return null;
        });
        if (driver) result = await driver.download(work, url, options);
        else {
          // No tab of its own yet: the server browser's cookies still come along.
          const relative = await importFromUrl(work, url, {
            name,
            folder,
            publicOnly: services.auth.required,
            headers: async (address) => {
              const cookies = await (await browser.context()).cookies(address.href);
              return cookies.length ? { Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") } : {};
            },
          });
          result = await importedAsset(work, relative, license ?? `下载自 ${url}`);
          services.events.emit({ type: "assets", work: work.id, repo: work.repo });
        }
      } else {
        const driver = await driverFor(ctx, { tab });
        result = await driver.downloadByClick(work, ref, options).catch((error) => {
          throw staleRef(error, ref);
        });
      }
      const size = result.size ? `，${bytes(result.size)}` : "";
      return { data: result, text: `已下载到 ${result.path}${size}，引用地址 ${result.url}${license ? "" : "（没有写 license：production/licenses.md 里记的是下载地址）"}` };
    },
  });

  registry.add({
    name: "browser_login",
    title: "请用户登录",
    ...common,
    readOnly: true,
    description:
      "请用户自己登录网站或通过验证（“确认你不是机器人”这类）：在这个对话的标签页打开 url（登录页或网站），聊天里出现请用户登录的卡片；在用户电脑上的浏览器里时，那个标签页会出现在用户面前。用户登录好后点「登录好了」，你会收到一条消息。不要让用户把密码、验证码、Token 或 Cookie 发到聊天里，也不要自己填。",
    input: {
      work: workArg,
      url: z.string().min(1).max(4000).describe("登录页，或者要登录的网站"),
      reason: z.string().min(2).max(200).describe("为什么要登录，给用户看，例如：下载这 5 个 CC BY 模型需要 Sketchfab 账号"),
      tab: tabArg,
      where: whereArg,
    },
    async run({ url, reason, tab, where }, ctx) {
      const work = await ctx.work();
      const session = ctx.scope.session ?? null;
      const driver = await driverFor(ctx, { tab, where, create: true });
      await driver.goto(url);
      const address = await driver.url();
      const host = (() => {
        try {
          return new URL(address).host;
        } catch {
          return "";
        }
      })();
      if (driver.where === "computer") {
        services.bridges.requestLogin(work.repo, driver.id, { reason, session, host });
        await services.bridges.focus(work.repo, driver.id).catch(() => {});
      } else services.browsers.of(work.repo).requestLogin(driver.tab, { reason, session });
      const place = driver.where === "computer" ? "用户电脑上的浏览器里（已经切到用户面前）" : "服务器上的浏览器里";
      const text = session
        ? `已在${place}的标签页 ${driver.id} 打开 ${address}，聊天里出现了请用户登录 ${host} 的卡片：用户登录好后点「登录好了」，这条消息在你这一轮结束以后发给你。`
        : `已在${place}的标签页 ${driver.id} 打开 ${address}。请用户登录 ${host}${driver.where === "server" ? "（FRAME 工作台这个作品库里任一作品的「浏览器」，在「素材」视图顶部的地球按钮）" : ""}，登录好后告诉你。`;
      return { data: { tab: driver.id, where: driver.where, host, url: address }, text };
    },
  });

  registry.add({
    name: "browser_cookies",
    title: "导出登录信息",
    ...common,
    readOnly: true,
    description:
      "把服务器上的浏览器（这个作品库的）里某些网站的登录信息（cookie）写成 cookies.txt，给你运行的下载程序用，例如 yt-dlp --cookies <文件> <网址>。文件只有服务器上能读，一小时后自动删除。只导出服务器上的浏览器的登录；用户电脑上的浏览器的登录不会传到服务器。",
    input: {
      work: workArg,
      sites: z.array(z.string().min(3).max(200)).min(1).max(10).describe("网站，例如 youtube.com、bilibili.com"),
    },
    async run({ sites }, ctx) {
      const browser = services.browsers.of((await ctx.work()).repo);
      const { file, counts, total } = await browser.cookieFile(sites);
      const summary = Object.entries(counts)
        .map(([site, count]) => `${site} ${count} 个`)
        .join("、");
      if (!total) return { data: { file: null, counts }, text: `服务器上的浏览器里没有 ${sites.join("、")} 的登录信息：先用 browser_login（where: "server"）请用户登录` };
      return {
        data: { file, counts },
        text: `已写入 ${file}（${summary}），一小时后自动删除。用法：yt-dlp --cookies ${file} <网址>。这是用户的登录凭据：只交给下载程序，不要复制进作品、打印内容或发给别人。${Object.values(counts).some((count) => !count) ? "\n有的网站没有登录信息：需要的话先 browser_login（where: \"server\"）。" : ""}`,
      };
    },
  });
}
