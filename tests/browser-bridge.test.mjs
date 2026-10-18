import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { browserExecutable } from "../server/render.mjs";
import { UPLOAD_HEADER } from "../server/browser-bridge.mjs";

const require = createRequire(import.meta.url);

/** A site that needs a login: the user's own browser has its cookie already. */
const PAGE = `<!doctype html><html><head><title>素材站</title></head><body>
<h1>素材站</h1>
<form action="/search" role="search"><input type="search" name="q" aria-label="搜索素材"></form>
<form action="/session" method="post"><input type="email" name="user" aria-label="邮箱"><input type="password" name="password" aria-label="密码"></form>
<textarea aria-label="写评论"></textarea>
<a href="/file.bin" download>下载模型</a>
<img src="/secret.png" alt="预览图">
</body></html>`;

/**
 * Stands in for the FRAME 连接器 extension in a test: the same socket protocol, carried out in a
 * Playwright browser of its own (the "user's" browser, logged in to the site).
 */
class FakeExtension {
  constructor(base, context) {
    this.base = base;
    this.context = context;
    this.pages = new Map();
    this.next = 1;
    this.calls = [];
  }
  connect(hello) {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(`${this.base.replace("http", "ws")}/api/browser/bridge`));
      ws.on("open", () => ws.send(JSON.stringify({ protocol: 1, name: "测试 Edge", ...hello })));
      ws.on("message", (raw) => {
        const message = JSON.parse(raw);
        if (message.type === "welcome" || message.type === "error") resolve(message);
        if (message.type === "welcome") this.repo = message.repos[0]?.id;
        if (message.type === "call") void this.run(message);
      });
      ws.on("error", reject);
    });
  }
  tabs() {
    return [...this.pages].map(([id, item]) => ({ id, title: "", url: item.page.url(), kind: item.kind, repo: item.repo, loading: false, active: true }));
  }
  async pushTabs() {
    const tabs = await Promise.all(this.tabs().map(async (tab) => ({ ...tab, title: await this.pages.get(tab.id).page.title() })));
    this.ws.send(JSON.stringify({ type: "tabs", tabs }));
  }
  async adopt(page, kind, repo) {
    const id = this.next++;
    this.pages.set(id, { page, kind, repo });
    page.on("close", () => this.pages.delete(id) && void this.pushTabs());
    await this.pushTabs();
    return id;
  }
  async info(id) {
    const { page } = this.pages.get(id);
    return { id, title: await page.title(), url: page.url(), loading: false, active: true };
  }
  async run({ id, op, args }) {
    this.calls.push(op);
    const reply = (data) => this.ws.send(JSON.stringify({ type: "result", id, ok: true, data }));
    try {
      const item = this.pages.get(args.tab);
      if (op !== "create" && (!item || item.repo !== args.repo)) throw new Error("这个标签页没有交给这个作品库的 AI");
      const page = item?.page;
      switch (op) {
        case "create": {
          const created = await this.context.newPage();
          const tab = await this.adopt(created, "ai", args.repo);
          if (args.url !== "about:blank") await created.goto(args.url);
          await this.pushTabs();
          return reply(await this.info(tab));
        }
        case "navigate":
          await page.goto(args.url);
          await this.pushTabs();
          return reply(await this.info(args.tab));
        case "info":
          return reply(await this.info(args.tab));
        case "evaluate":
          return reply(await page.evaluate(args.expression));
        case "input":
          for (const event of args.events) {
            if (event.type === "mouse" && event.action === "move") await page.mouse.move(event.x, event.y);
            if (event.type === "mouse" && event.action === "down") await page.mouse.down();
            if (event.type === "mouse" && event.action === "up") await page.mouse.up();
            if (event.type === "text") await page.keyboard.insertText(event.text);
            if (event.type === "key") await page.keyboard.press(event.key);
          }
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          return reply(true);
        case "screenshot":
          return reply({ data: (await page.screenshot({ type: "jpeg" })).toString("base64"), mime: "image/jpeg" });
        case "focus":
          return reply(true);
        case "history":
          if (args.action === "close") {
            await page.close();
            return reply({ closed: true });
          }
          return reply(await this.info(args.tab));
        case "clickDownload": {
          const [download] = await Promise.all([page.waitForEvent("download"), page.mouse.click(args.x, args.y)]);
          await download.cancel();
          return reply({ url: download.url(), filename: download.suggestedFilename() });
        }
        case "fetch": {
          const response = await this.context.request.get(args.url);
          if (!response.ok()) throw new Error(`下载失败：HTTP ${response.status()}`);
          const body = await response.body();
          const header = Buffer.from(String(args.upload).padEnd(UPLOAD_HEADER), "ascii");
          for (let at = 0; at < body.length; at += 4) this.ws.send(Buffer.concat([header, body.subarray(at, at + 4)]));
          return reply({ status: response.status(), mime: response.headers()["content-type"], name: null, size: body.length });
        }
      }
      throw new Error("unknown op " + op);
    } catch (error) {
      this.ws.send(JSON.stringify({ type: "result", id, ok: false, error: error.message }));
    }
  }
}

describe("the user's own browser through the FRAME 连接器 extension", () => {
  let app, base, site, siteUrl, work, chromium, userBrowser, extension;
  const seen = [];
  const call = (name, args) => app.services.tools.call(name, args, { session: "s1", work: work.id, repo: work.repo, agent: true });
  const api = async (url, init = {}) => {
    const response = await fetch(base + url, { ...init, headers: { "Content-Type": "application/json" } });
    return response.json();
  };

  beforeAll(async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
    site = http.createServer((req, res) => {
      const loggedIn = /(^|;\s*)sid=user/.test(req.headers.cookie || "");
      seen.push({ url: req.url, loggedIn });
      if (req.url.startsWith("/search")) return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<title>搜索</title><p>结果：${new URL(req.url, "http://x").searchParams.get("q")}</p>`);
      if (req.url === "/secret.png") return loggedIn ? res.writeHead(200, { "Content-Type": "image/png" }).end(png) : res.writeHead(403).end();
      if (req.url === "/file.bin") return loggedIn ? res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="model.bin"' }).end("MODEL") : res.writeHead(403).end();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
    });
    await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
    siteUrl = `http://127.0.0.1:${site.address().port}`;
    app = await createApp({ env: { FRAME_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "frame-bridge-")), FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    work = await app.services.works.create({ title: "电脑上的浏览器" });
    // The user's browser, already logged in to the site.
    ({ chromium } = require("playwright-core"));
    userBrowser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
    const context = await userBrowser.newContext({ acceptDownloads: true });
    await context.addCookies([{ name: "sid", value: "user", url: siteUrl }]);
    extension = new FakeExtension(base, context);
  });
  afterAll(async () => {
    extension?.ws?.close();
    await userBrowser?.close();
    await app?.close();
    site?.close();
  });

  it("hands out the extension with manifest.json at the top of the zip and this studio's address", async () => {
    const { unzipSync } = await import("fflate");
    const files = unzipSync(new Uint8Array(await (await fetch(`${base}/api/browser-extension.zip`)).arrayBuffer()));
    // Windows' 全部解压缩 makes the folder: a folder inside would leave the manifest a level too deep.
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["manifest.json", "background.js", "popup.html", "popup.js", "pair.html", "pair.js", "icons/128.png", "defaults.json"]));
    expect(Object.keys(files).every((name) => !name.startsWith("frame-connector/"))).toBe(true);
    const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
    expect(manifest).toMatchObject({ manifest_version: 3, background: { service_worker: "background.js" } });
    // Only this studio's pages may see the extension and open its pairing page; its id is fixed by its key.
    expect(manifest.web_accessible_resources).toEqual([{ resources: ["icons/16.png", "pair.html"], matches: [`http://${new URL(base).hostname}/*`] }]);
    // And ask it which linked computer they are on (render-gpu).
    expect(manifest.externally_connectable).toEqual({ matches: [`http://${new URL(base).hostname}/*`] });
    const { extension } = await api(`/api/browser/${work.repo}`);
    expect(extension.id).toMatch(/^[a-p]{32}$/);
    for (const icon of Object.values(manifest.icons)) expect(files[icon]).toBeTruthy();
    expect(JSON.parse(Buffer.from(files["defaults.json"]).toString())).toEqual({ server: new URL(base).origin });
  });

  it("pairs with a code made in a repository, and comes back with its token", async () => {
    await expect(new FakeExtension(base, null).connect({ type: "pair", code: "WRONGONE" })).resolves.toMatchObject({ type: "error", code: "BAD_CODE" });
    const { code } = await api(`/api/browser/${work.repo}/pair`, { method: "POST" });
    const welcome = await extension.connect({ type: "pair", code });
    expect(welcome).toMatchObject({ type: "welcome", repos: [{ id: work.repo }] });
    expect(welcome.token).toMatch(/^fb_/);
    extension.token = welcome.token;
    // The code is used up; the token is what it keeps.
    await expect(new FakeExtension(base, null).connect({ type: "pair", code })).resolves.toMatchObject({ code: "BAD_CODE" });
    // The key FRAME pages in this browser get from the extension names this computer, and stays when it reconnects.
    expect(welcome.pageKey).toMatch(/^[\w-]{24}$/);
    expect(app.services.bridges.computerOf(welcome.pageKey)).toBe(welcome.bridge);
    expect(app.services.bridges.computerOf("someone else's")).toBe(null);
    expect([...app.services.bridges.linked(work.repo)]).toEqual([welcome.bridge]);
    extension.ws.close();
    await expect(extension.connect({ type: "hello", token: welcome.token })).resolves.toMatchObject({ type: "welcome", pageKey: welcome.pageKey });
    await expect.poll(() => app.services.bridges.connected(work.repo)).toBe(true);
    expect((await api(`/api/browser/${work.repo}`)).computers).toMatchObject([{ name: "测试 Edge", online: true }]);
    // Not a key to anything else.
    expect((await fetch(`${base}/api/tools`, { headers: { Authorization: "Bearer " + welcome.token } })).status).toBe(401);
  });

  it("browses with the user's logins, refuses what is the user's to fill in, and downloads into the work", async () => {
    const opened = await call("browser_open", { url: siteUrl });
    expect(opened.text).toMatch(/标签页 x\d+（用户电脑上的浏览器（测试 Edge））：素材站/);
    const ref = (text, label) => new RegExp(`"${label}" \\[ref=(e\\d+)\\]`).exec(text)?.[1];
    expect(ref(opened.text, "下载模型")).toBeTruthy();
    expect(opened.text).toContain("（密码框）");
    await expect(call("browser_act", { action: "type", ref: ref(opened.text, "密码"), text: "x" })).rejects.toThrow(/browser_login/);
    await expect(call("browser_act", { action: "type", ref: ref(opened.text, "邮箱"), text: "a@b.c" })).rejects.toThrow(/browser_login/);
    await expect(call("browser_act", { action: "type", ref: ref(opened.text, "写评论"), text: "好" })).rejects.toThrow(/不替用户发言/);
    const searched = await call("browser_act", { action: "type", ref: ref(opened.text, "搜索素材"), text: "大头菜", submit: true });
    expect(searched.text).toContain("搜索");
    expect((await call("browser_read", { what: "text" })).text).toContain("结果：大头菜");

    // Downloads: by address and by the page's download link, with the cookie of the user's browser.
    await call("browser_act", { action: "back" });
    await call("browser_open", { url: siteUrl });
    const picture = await call("browser_download", { url: `${siteUrl}/secret.png`, license: "测试站" });
    expect(picture.data).toMatchObject({ path: "public/imports/secret.png", kind: "image" });
    const page = await call("browser_read", {});
    const model = await call("browser_download", { ref: ref(page.text, "下载模型") });
    expect(fs.readFileSync(path.join(work.dir, model.data.path), "utf8")).toBe("MODEL");
    expect(extension.calls).toContain("clickDownload");

    // A login asked for in the user's browser: the tab comes to the front there.
    const login = await call("browser_login", { url: siteUrl, reason: "下载要登录" });
    expect(login.data.where).toBe("computer");
    expect(extension.calls).toContain("focus");
    expect(app.services.bridges.remoteTabs(work.repo).find((tab) => tab.id === login.data.tab).login.reason).toBe("下载要登录");
    await app.services.bridges.loginDone(work.repo, login.data.tab);
    // The server's browser is still there when asked for.
    const server = await call("browser_open", { url: siteUrl, where: "server", newTab: true });
    expect(server.text).toMatch(/标签页 t[0-9a-f]{6}（服务器上的浏览器）/);
  });

  it("keeps to the repositories it was linked to, and stops when unlinked", async () => {
    await expect(app.services.bridges.driver("other", "s1", { create: true })).rejects.toThrow(/没有连着/);
    const [computer] = app.services.bridges.computers(work.repo);
    const closed = new Promise((resolve) => extension.ws.once("message", (raw) => resolve(JSON.parse(raw))));
    await api(`/api/browser/${work.repo}/computers/${computer.id}`, { method: "DELETE" });
    expect(await closed).toMatchObject({ type: "error", code: "UNPAIRED" });
    expect(app.services.bridges.connected(work.repo)).toBe(false);
    await expect(new FakeExtension(base, null).connect({ type: "hello", token: extension.token })).resolves.toMatchObject({ code: "UNPAIRED" });
  });
});
