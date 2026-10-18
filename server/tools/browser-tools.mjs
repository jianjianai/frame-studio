import sharp from "sharp";
import { z } from "zod";
import { workArg } from "./registry.mjs";
import { importFromUrl, importedAsset } from "./asset-tools.mjs";
import { problem } from "../util.mjs";

const tabArg = z
  .string()
  .regex(/^t[0-9a-f]{6}$/)
  .optional()
  .describe("标签页 id（结果里写的，例如 t1a2b3c）；不写就是这个对话自己的标签页");
const refArg = z
  .string()
  .regex(/^(f\d+)?e\d+$/)
  .optional()
  .describe("元素：页面结构里的 [ref=…]（例如 e12）");

/** Size in words. */
const bytes = (size) => (size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`);

/** The tab's picture for the AI: CSS pixels (a phone viewer may draw it at 2×), at most 1280 wide. */
async function screenshot(page) {
  const image = await page.screenshot({ type: "jpeg", quality: 70, scale: "css", timeout: 15000 });
  const meta = await sharp(image).metadata();
  const data = meta.width > 1280 ? await sharp(image).resize({ width: 1280 }).jpeg({ quality: 70 }).toBuffer() : image;
  return { data, mimeType: "image/jpeg" };
}

/**
 * The page's structure as Playwright writes it for AI (roles, names, texts, [ref=…] for what can
 * be clicked or typed into). `query` keeps the lines that mention it, with the line above for
 * context; a long one is cut at `max` characters.
 */
async function structure(page, { query, max = 8000 } = {}) {
  let text = await page.ariaSnapshot({ mode: "ai", timeout: 10000 }).catch(() => "");
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

/** What the tab shows now: where it is, its structure, optionally its picture. */
async function report(tab, { query, max, screenshot: picture = false, structure: withStructure = true, notes = [] } = {}) {
  const { page } = tab;
  const title = await page.title().catch(() => "");
  const lines = [`标签页 ${tab.id}${tab.owner === "user" ? "（用户打开的）" : ""}：${title || "（无标题）"}`, `地址：${page.url()}`, ...notes];
  const parts = [lines.join("\n")];
  if (withStructure) parts.push(await structure(page, { query, max }));
  return {
    data: { tab: tab.id, title, url: page.url() },
    text: parts.join("\n\n"),
    images: picture ? [await screenshot(page)] : [],
  };
}

/** A locator for a ref of the latest structure; a stale ref says so. */
function element(page, ref) {
  if (!ref) throw problem(400, "要指定 ref（页面结构里的 [ref=…]）");
  return page.locator(`aria-ref=${ref}`);
}
const staleRef = (error, ref) =>
  /aria-ref|not found|No element|resolved to 0/i.test(String(error?.message))
    ? problem(400, `找不到 ${ref}：页面变了，ref 已经失效。用 browser_read 取最新的页面结构`, "STALE_REF")
    : /Timeout/i.test(String(error?.message))
      ? problem(504, `${ref} 10 秒内没能操作（被别的东西挡住、看不见或不能用）：用 browser_read（screenshot: true）看看`, "TIMEOUT")
      : error;

/**
 * Where typing would go: an ordinary field, a password, a login form, or a box for writing
 * prose (comments, posts) — the last three are the user's to fill in.
 */
async function fieldKind(locator) {
  return locator.evaluate((element) => {
    const form = element.closest("form");
    const visiblePassword = (root) => [...root.querySelectorAll('input[type="password"]')].some((input) => input.offsetParent !== null);
    if (element.tagName === "INPUT") {
      if (element.type === "password") return "password";
      if (!["text", "search", "url", "email", "tel", "number", ""].includes(element.type)) return "other";
      return form && visiblePassword(form) ? "login" : "field";
    }
    const role = element.getAttribute("role");
    const search = role === "searchbox" || role === "combobox" || element.closest('[role="search"], search');
    if (element.tagName === "TEXTAREA" || element.isContentEditable) return search ? "field" : "prose";
    return "other";
  });
}

/** Wait for what an action set off: a navigation to show its page, a popup, a download. */
async function settle(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
}

export function registerBrowserTools(registry) {
  const { services } = registry;
  /** The browser of the work's repository: each repository has its own logins, tabs and downloads. */
  const browserFor = async (ctx) => services.browsers.of((await ctx.work()).repo);
  const sessionOf = (ctx) => ctx.scope.session ?? "external";
  const common = { signedIn: true };

  registry.add({
    name: "browser_open",
    title: "打开网页",
    ...common,
    readOnly: true,
    description:
      "在 FRAME 浏览器里打开网页。这是服务器上一个带登录状态的浏览器，每个作品库一个：用户在这个作品库的「浏览器」标签页里登录过的网站（Sketchfab、YouTube、B 站、抖音……）这里也是登录的，用户也能在标签页里看到你在做什么。普通的公开网页用你自己的联网工具更快；要登录才能看或下载、或者你自己的请求被网站拦下时用这个。每个对话有自己的标签页（newTab 再开一个）；结果是页面结构（[ref=…] 给 browser_act），screenshot 要截图。要登录时用 browser_login 请用户登录，不要自己填账号密码。只浏览和下载：不发帖、评论、私信、点赞、关注、购买，不改账号设置。",
    input: {
      work: workArg,
      url: z.string().min(1).max(4000).describe("网址"),
      tab: tabArg,
      newTab: z.boolean().default(false).describe("在新标签页打开（同时看几个网页时）"),
      query: z.string().max(200).optional().describe("页面结构只看含这些字的行"),
      max: z.number().int().min(500).max(40000).default(8000).describe("页面结构最多多少字"),
      screenshot: z.boolean().default(false).describe("同时截图"),
    },
    async run({ url, tab: tabId, newTab, query, max, screenshot }, ctx) {
      const browser = await browserFor(ctx);
      const session = sessionOf(ctx);
      const tab = newTab ? await browser.newTab({ owner: "ai", session }) : await browser.tabFor(session, { tab: tabId, create: true });
      if (newTab) await browser.tabFor(session, { tab: tab.id });
      const response = await browser.goto(tab, url);
      const status = response?.status();
      return report(tab, { query, max, screenshot, notes: status && status >= 400 ? [`HTTP ${status}`] : [] });
    },
  });

  registry.add({
    name: "browser_read",
    title: "读网页",
    ...common,
    readOnly: true,
    description:
      "读 FRAME 浏览器标签页里的网页：snapshot 页面结构（默认，带 [ref=…]）；text 正文文字（offset 翻页）；links 链接（文字 → 地址）；media 图片、视频、音频的地址和尺寸（下载用 browser_download 的 url）。query 只看含某些字的部分；screenshot 截图（看登录状态、验证、布局时用）。不写 tab 就是这个对话自己的标签页；用户说“这个网页”时，[FRAME] 里写着用户正在看的标签页。",
    input: {
      work: workArg,
      tab: tabArg,
      what: z.enum(["snapshot", "text", "links", "media"]).default("snapshot"),
      query: z.string().max(200).optional().describe("只看含这些字的部分（不分大小写）"),
      offset: z.number().int().min(0).default(0).describe("text：从第几个字开始"),
      max: z.number().int().min(500).max(40000).default(10000).describe("最多多少字"),
      screenshot: z.boolean().default(false),
    },
    async run({ tab: tabId, what, query, offset, max, screenshot }, ctx) {
      const browser = await browserFor(ctx);
      const tab = await browser.tabFor(sessionOf(ctx), { tab: tabId });
      const { page } = tab;
      if (what === "snapshot") return report(tab, { query, max, screenshot });
      let body;
      if (what === "text") {
        let text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
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
        const links = await page.evaluate(() => {
          const seen = new Map();
          for (const anchor of document.querySelectorAll("a[href]")) {
            const href = anchor.href;
            if (!/^https?:/.test(href)) continue;
            const text = (anchor.innerText || anchor.getAttribute("aria-label") || anchor.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
            if (!seen.has(href) || (!seen.get(href) && text)) seen.set(href, text);
          }
          return [...seen].map(([href, text]) => ({ href, text }));
        });
        const wanted = query?.toLowerCase();
        const shown = links.filter((link) => !wanted || link.href.toLowerCase().includes(wanted) || link.text.toLowerCase().includes(wanted));
        let lines = shown.map((link) => `- ${link.text || "（无文字）"} → ${link.href}`).join("\n");
        if (lines.length > max) lines = lines.slice(0, max) + "\n…（还有更多：用 query 筛选）";
        body = `链接 ${shown.length} 个${query ? `（含“${query}”，共 ${links.length} 个）` : ""}：\n${lines || "（没有）"}`;
      } else {
        const media = await page.evaluate(() => {
          const items = [];
          const add = (kind, src, extra = {}) => src && items.push({ kind, src, ...extra });
          for (const image of document.images) add("图片", image.currentSrc || image.src, { size: image.naturalWidth ? `${image.naturalWidth}×${image.naturalHeight}` : "", text: image.alt || "" });
          for (const video of document.querySelectorAll("video"))
            add("视频", video.currentSrc || video.src || video.querySelector("source")?.src, {
              size: video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "",
              duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
              poster: video.poster || "",
            });
          for (const audio of document.querySelectorAll("audio")) add("音频", audio.currentSrc || audio.src || audio.querySelector("source")?.src);
          for (const meta of document.querySelectorAll('meta[property="og:image"], meta[property="og:video"], meta[property="og:audio"]'))
            add(meta.getAttribute("property").replace("og:", "页面声明的"), meta.content);
          return items;
        });
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
        body = `媒体 ${lines.length} 个：\n${text || "（没有）"}${blob ? "\n\nblob: 地址是网页播放时拼出来的流，不能直接下载：视频网站用 yt-dlp 加 browser_cookies 的登录信息下载原视频。" : ""}`;
      }
      const head = await report(tab, { structure: false, screenshot });
      return { ...head, text: `${head.text}\n\n${body}` };
    },
  });

  registry.add({
    name: "browser_act",
    title: "操作网页",
    ...common,
    readOnly: true,
    description:
      "在 FRAME 浏览器的标签页里操作：click 点击、type 在输入框（搜索框等）里输入（submit 再按回车）、press 按键（Enter、Escape、ArrowDown、PageDown…）、select 选下拉选项、hover、scroll 滚动（up/down，或滚到 ref）、back/forward/reload、close 关掉标签页、wait 等一会儿。元素用最新页面结构里的 ref。结果是操作后的页面结构（screenshot 要截图）。只为了浏览和下载而操作：不要点发布、评论、私信、点赞、关注、购买、修改设置这类会以用户身份产生影响的按钮；密码框、登录表单和评论框不能填，登录交给 browser_login。",
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
    async run({ tab: tabId, action, ref, text, submit, key, direction, amount, ms, query, max, screenshot }, ctx) {
      const browser = await browserFor(ctx);
      const session = sessionOf(ctx);
      const tab = await browser.tabFor(session, { tab: tabId });
      const { page } = tab;
      const notes = [];
      const before = new Set(browser.tabs.keys());
      const started = Date.now();
      try {
        switch (action) {
          case "click":
            await element(page, ref).click({ timeout: 10000 });
            break;
          case "type": {
            if (text === undefined) throw problem(400, "type 要写 text");
            const locator = element(page, ref);
            const kind = await fieldKind(locator);
            if (kind === "password" || kind === "login") throw problem(403, "账号、密码由用户自己填：用 browser_login 请用户在「浏览器」标签页里登录", "USER_ONLY");
            if (kind === "prose")
              throw problem(403, "这是写评论、发帖、私信这类内容的输入框：在登录状态的浏览器里 AI 只浏览和下载，不替用户发言。需要的话请用户自己在「浏览器」标签页里输入", "USER_ONLY");
            if (kind === "other") throw problem(400, `${ref} 不是输入框（选项用 select，按钮用 click）`);
            await locator.fill(text, { timeout: 10000 });
            if (submit) await locator.press("Enter");
            break;
          }
          case "press":
            if (!key) throw problem(400, "press 要写 key");
            await (ref ? element(page, ref).press(key, { timeout: 10000 }) : page.keyboard.press(key));
            break;
          case "select":
            if (text === undefined) throw problem(400, "select 要写 text（选项的文字）");
            await element(page, ref)
              .selectOption({ label: text }, { timeout: 10000 })
              .catch(() => element(page, ref).selectOption(text, { timeout: 10000 }));
            break;
          case "hover":
            await element(page, ref).hover({ timeout: 10000 });
            break;
          case "scroll":
            if (ref) await element(page, ref).scrollIntoViewIfNeeded({ timeout: 10000 });
            else await page.mouse.wheel(0, (direction === "up" ? -1 : 1) * amount * (tab.viewport?.height ?? 800) * 0.85);
            break;
          case "back":
            await page.goBack({ timeout: 15000 }).catch(() => {});
            break;
          case "forward":
            await page.goForward({ timeout: 15000 }).catch(() => {});
            break;
          case "reload":
            await page.reload({ timeout: 15000 }).catch(() => {});
            break;
          case "close": {
            await page.close();
            const next = browser.tabs.get(browser.sessionTabs.get(session));
            return { data: { closed: tab.id, tab: next?.id ?? null }, text: `已关掉标签页 ${tab.id}${next ? `，这个对话现在用标签页 ${next.id}（${next.title || next.url}）` : ""}` };
          }
          case "wait":
            await page.waitForTimeout(ms);
            break;
        }
      } catch (error) {
        throw ref ? staleRef(error, ref) : error;
      }
      await settle(page);
      // What the action set off: a new tab (a site's popup), a download.
      const opened = [...browser.tabs.values()].find((item) => !before.has(item.id) && item.opener === tab.id);
      const downloads = browser
        .listDownloads()
        .filter((item) => item.tab === tab.id && item.at >= started);
      for (const item of downloads)
        notes.push(`开始下载了 ${item.name}（下载 id ${item.id}，${item.state === "done" ? bytes(item.size) : "还在下载"}）：用 browser_download 的 download 参数放进作品`);
      if (opened) {
        await settle(opened.page);
        notes.push(`网页打开了新标签页 ${opened.id}，下面是它（这个对话之后默认用它；回到原来的写 tab: "${tab.id}"）`);
        return report(opened, { query, max, screenshot, notes });
      }
      return report(tab, { query, max, screenshot, notes });
    },
  });

  registry.add({
    name: "browser_download",
    title: "从网页下载",
    ...common,
    description:
      "用 FRAME 浏览器的登录状态把文件下载进作品的 public/（返回代码里用的 films/... 地址）：url 直接下载一个地址（带上这个网站的登录信息，图片、模型、音频、视频文件的地址用 browser_read 的 media 或 links 找）；ref 点击网页上的下载按钮并保存下载的文件；download 是之前点击开始的下载（browser_act 的结果里写了 id）。license 写清来源与许可（记在 production/licenses.md）。网页里的 blob: 视频流下载不了：视频网站用 yt-dlp 加 browser_cookies。",
    input: {
      work: workArg,
      tab: tabArg,
      url: z.string().url().max(4000).optional(),
      ref: refArg,
      download: z
        .string()
        .regex(/^d[0-9a-f]{6}$/)
        .optional()
        .describe("已经下载好的文件的 id"),
      name: z.string().max(120).optional().describe("保存的文件名"),
      folder: z
        .string()
        .regex(/^public(\/[\w.-]+)*$/)
        .default("public/imports")
        .describe("保存到哪个文件夹"),
      license: z.string().max(500).optional().describe("来源与许可"),
    },
    async run({ tab: tabId, url, ref, download, name, folder, license }, ctx) {
      if ([url, ref, download].filter(Boolean).length !== 1) throw problem(400, "url、ref、download 必须且只能写一个");
      const work = await ctx.work();
      const browser = services.browsers.of(work.repo);
      const session = sessionOf(ctx);
      let result;
      if (url) {
        if (/^(blob|data):/.test(url)) throw problem(400, "blob:/data: 地址是网页里的数据，不能下载：用 ref 点下载按钮，或者用 yt-dlp 加 browser_cookies");
        // Without a tab of its own the conversation still has the browser's cookies.
        const tab = tabId || browser.sessionTabs.has(session) ? await browser.tabFor(session, { tab: tabId }) : null;
        const relative = await importFromUrl(work, url, {
          name,
          folder,
          publicOnly: services.auth.required,
          headers: async (address) => {
            if (tab) return browser.headersFor(tab, address);
            const cookies = await (await browser.context()).cookies(address.href);
            return cookies.length ? { Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") } : {};
          },
        });
        result = await importedAsset(work, relative, license ?? `下载自 ${url}`);
        services.events.emit({ type: "assets", work: work.id, repo: work.repo });
      } else if (ref) {
        const tab = await browser.tabFor(session, { tab: tabId });
        const page = tab.page;
        const item = await browser
          .expectDownload(tab, () => element(page, ref).click({ timeout: 10000 }))
          .catch((error) => {
            throw staleRef(error, ref);
          });
        result = await browser.importDownload(work, item.id, { folder, name, license: license ?? `下载自 ${page.url()}` });
      } else result = await browser.importDownload(work, download, { folder, name, license });
      const size = result.size ? `，${bytes(result.size)}` : "";
      return { data: result, text: `已下载到 ${result.path}${size}，引用地址 ${result.url}${license ? "" : "（来源记在了 production/licenses.md，许可写清楚了再补上）"}` };
    },
  });

  registry.add({
    name: "browser_login",
    title: "请用户登录",
    ...common,
    readOnly: true,
    description:
      "网页要登录（下载要账号、内容要登录才看得到、网站要求“确认你不是机器人”）时，请用户自己在 FRAME 浏览器里登录或通过验证：在这个对话的标签页打开 url（登录页或网站），聊天里出现请用户登录的卡片。用户登录好后点「登录好了」，你会收到一条消息。不要让用户把密码、验证码、Token 或 Cookie 发到聊天里，也不要自己填。",
    input: {
      work: workArg,
      url: z.string().min(1).max(4000).describe("登录页，或者要登录的网站"),
      reason: z.string().min(2).max(200).describe("为什么要登录，给用户看，例如：下载这 5 个 CC BY 模型需要 Sketchfab 账号"),
      tab: tabArg,
    },
    async run({ url, reason, tab: tabId }, ctx) {
      const browser = await browserFor(ctx);
      const session = ctx.scope.session ?? null;
      const tab = await browser.tabFor(sessionOf(ctx), { tab: tabId, create: true });
      await browser.goto(tab, url);
      const host = browser.requestLogin(tab, { reason, session });
      const text = session
        ? `已在标签页 ${tab.id} 打开 ${tab.page.url()}，聊天里出现了请用户登录 ${host} 的卡片：用户点「打开浏览器」登录，登录好后点「登录好了」，你会收到一条消息。现在先做不需要登录的部分，做完就结束这一轮，在回复里说清楚要登录哪个网站、为什么。用户说登录好了以后用 browser_read 确认已经登录。`
        : `已在 FRAME 浏览器的标签页 ${tab.id} 打开 ${tab.page.url()}。请用户在 FRAME 工作台打开这个作品库里任一作品的「浏览器」（「素材」视图顶部的地球按钮）登录 ${host}，登录好后告诉你。`;
      return { data: { tab: tab.id, host, url: tab.page.url() }, text };
    },
  });

  registry.add({
    name: "browser_cookies",
    title: "导出登录信息",
    ...common,
    readOnly: true,
    description:
      "把 FRAME 浏览器里某些网站的登录信息（cookie）写成 cookies.txt，给你运行的下载程序用，例如 yt-dlp --cookies <文件> <网址>（YouTube 说“Sign in to confirm you’re not a bot”、B 站要登录才有高清时）。文件只有服务器上能读，一小时后自动删除。还没登录的网站先 browser_login。",
    input: {
      work: workArg,
      sites: z.array(z.string().min(3).max(200)).min(1).max(10).describe("网站，例如 youtube.com、bilibili.com"),
    },
    async run({ sites }, ctx) {
      const browser = await browserFor(ctx);
      const { file, counts, total } = await browser.cookieFile(sites);
      const summary = Object.entries(counts)
        .map(([site, count]) => `${site} ${count} 个`)
        .join("、");
      if (!total) return { data: { file: null, counts }, text: `浏览器里没有 ${sites.join("、")} 的登录信息：先用 browser_login 请用户登录` };
      return {
        data: { file, counts },
        text: `已写入 ${file}（${summary}），一小时后自动删除。用法：yt-dlp --cookies ${file} <网址>。这是用户的登录凭据：只交给下载程序，不要复制进作品、打印内容或发给别人。${Object.values(counts).some((count) => !count) ? "\n有的网站没有登录信息：需要的话先 browser_login。" : ""}`,
      };
    },
  });
}
