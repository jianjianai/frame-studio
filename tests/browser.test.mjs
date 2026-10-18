import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { startGuardProxy } from "../server/browser-proxy.mjs";
import { Browsers, netscapeCookies, normalizeAddress, siteOf } from "../server/browser.mjs";

/** Repository browsers outside an app: `required` is a studio with a password (the guard proxy on). */
const hub = (required) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-browsers-"));
  return new Browsers({ auth: { required }, repos: { get: () => ({}) }, config: { home, dirs: { tmp: path.join(home, "tmp") } }, events: { emit() {} } });
};

/** A plain server on loopback answering every request with its path. */
async function echoServer() {
  const server = http.createServer((req, res) => res.end(`echo ${req.url}`));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

/** One raw request through the proxy: what comes back first. */
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("error", reject);
  });
}

describe("the logged-in browser's guard proxy", () => {
  it("lets public addresses through and refuses the server's own network", async () => {
    const { server, port } = await echoServer();
    const guard = await startGuardProxy();
    const open = await startGuardProxy({ blocked: () => false });
    try {
      const proxyPort = (proxy) => Number(new URL(proxy.url).port);
      // Plain http and tunnels (https, wss) to loopback: refused.
      expect(await rawRequest(proxyPort(guard), `GET http://127.0.0.1:${port}/x HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)).toMatch(/^HTTP\/1\.1 403/);
      expect(await rawRequest(proxyPort(guard), `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)).toMatch(/^HTTP\/1\.1 403/);
      expect(await rawRequest(proxyPort(guard), `CONNECT localhost:${port} HTTP/1.1\r\n\r\n`)).toMatch(/^HTTP\/1\.1 403/);
      // Where the address is allowed, the request arrives.
      const passed = await rawRequest(proxyPort(open), `GET http://127.0.0.1:${port}/hello HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      expect(passed).toMatch(/^HTTP\/1\.1 200/);
      const tunnel = await rawRequest(proxyPort(open), `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`);
      expect(tunnel).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    } finally {
      await guard.close();
      await open.close();
      server.close();
    }
  });

  it("keeps a studio on the network out of its own network", async () => {
    const { server, port } = await echoServer();
    const browsers = hub(true);
    try {
      const browser = browsers.of("local");
      const tab = await browser.newTab({ owner: "ai", session: "s" });
      for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`]) await expect(browser.goto(tab, url)).rejects.toThrow(/内网地址/);
    } finally {
      await browsers.shutdown();
      server.close();
    }
  });

  it("opens only web addresses and finds the site a login belongs to", () => {
    expect(normalizeAddress("sketchfab.com/models")).toBe("https://sketchfab.com/models");
    expect(normalizeAddress("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeAddress("动森 大头菜")).toMatch(/^https:\/\/www\.bing\.com\/search\?q=/);
    for (const bad of ["file:///data/secrets.json", "chrome://settings", "javascript:alert(1)"]) expect(() => normalizeAddress(bad)).toThrow(/http/);
    expect(siteOf("www.sketchfab.com")).toBe("sketchfab.com");
    expect(siteOf("member.bilibili.com")).toBe("bilibili.com");
    expect(siteOf("a.b.com.cn")).toBe("b.com.cn");
    const text = netscapeCookies([{ name: "sid", value: "1", domain: ".youtube.com", path: "/", expires: -1, httpOnly: true, secure: true }]);
    expect(text).toContain("#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tsid\t1");
  });
});

/**
 * A site that needs a login: /login sets a cookie, /secret.png and /file.bin answer only with
 * it; the front page has a search box, a login form, a comment box and a download link.
 */
const PAGE = `<!doctype html><html><head><title>素材站</title></head><body>
<h1>素材站</h1>
<form action="/search" role="search"><input type="search" name="q" aria-label="搜索素材"></form>
<form action="/session" method="post"><input type="email" name="user" aria-label="邮箱"><input type="password" name="password" aria-label="密码"></form>
<textarea aria-label="写评论"></textarea>
<a href="/file.bin" download="模型.bin">下载模型</a>
<a href="/login">登录</a>
<button onclick="document.title='点到了'" style="position:fixed;left:0;top:0;width:200px;height:120px">按钮</button>
<img src="/secret.png" alt="预览图">
</body></html>`;

describe("the logged-in browser for the AI", () => {
  let app, base, site, siteUrl, work;
  const seen = [];
  const call = (name, args) => app.services.tools.call(name, args, { session: "s1", work: work.id, repo: work.repo, agent: true });
  const browser = () => app.services.browsers.of(work.repo);

  beforeAll(async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
    site = http.createServer((req, res) => {
      const loggedIn = /(^|;\s*)sid=abc/.test(req.headers.cookie || "");
      seen.push({ url: req.url, loggedIn });
      if (req.url === "/login") return res.writeHead(302, { "Set-Cookie": "sid=abc; Path=/; HttpOnly", Location: "/" }).end();
      if (req.url.startsWith("/search")) return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<title>搜索</title><p>结果：${new URL(req.url, "http://x").searchParams.get("q")}</p>`);
      if (req.url === "/secret.png") return loggedIn ? res.writeHead(200, { "Content-Type": "image/png" }).end(png) : res.writeHead(403).end();
      if (req.url === "/file.bin")
        return loggedIn ? res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="model.bin"' }).end("MODEL") : res.writeHead(403).end();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
    });
    await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
    siteUrl = `http://127.0.0.1:${site.address().port}`;
    app = await createApp({ env: { FRAME_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "frame-browser-")), FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    work = await app.services.works.create({ title: "素材下载" });
  });
  afterAll(async () => {
    await app?.close();
    site?.close();
  });

  it("browses, refuses to fill in what is the user's, and downloads with the login", async () => {
    const opened = await call("browser_open", { url: siteUrl });
    expect(opened.text).toMatch(/标签页 t[0-9a-f]{6}：素材站/);
    const ref = (text, label) => new RegExp(`${label}"? \\[ref=(\\w+)\\]`).exec(text)?.[1];
    // The password, the login form's other field and the comment box are the user's.
    await expect(call("browser_act", { action: "type", ref: ref(opened.text, "密码"), text: "x" })).rejects.toThrow(/browser_login/);
    await expect(call("browser_act", { action: "type", ref: ref(opened.text, "邮箱"), text: "a@b.c" })).rejects.toThrow(/browser_login/);
    await expect(call("browser_act", { action: "type", ref: ref(opened.text, "写评论"), text: "好" })).rejects.toThrow(/不替用户发言/);
    // A search box is fine.
    const searched = await call("browser_act", { action: "type", ref: ref(opened.text, "搜索素材"), text: "大头菜", submit: true });
    expect(searched.text).toContain("结果：大头菜");

    // Logged out, the picture is refused; the user logs in (here: the page sets the cookie).
    await expect(call("browser_download", { url: `${siteUrl}/secret.png` })).rejects.toThrow(/403/);
    const login = await call("browser_login", { url: `${siteUrl}/login`, reason: "下载模型需要登录" });
    expect(login.text).toContain("登录好了");
    expect(browser().list().find((tab) => tab.id === login.data.tab).login.reason).toBe("下载模型需要登录");
    await browser().loginDone(login.data.tab);

    const media = await call("browser_read", { what: "media" });
    expect(media.text).toContain(`${siteUrl}/secret.png`);
    const picture = await call("browser_download", { url: `${siteUrl}/secret.png`, license: "测试站，自有" });
    expect(picture.data).toMatchObject({ path: "public/imports/secret.png", kind: "image" });
    expect(seen.filter((item) => item.url === "/secret.png").at(-1).loggedIn).toBe(true);
    expect(fs.readFileSync(path.join(work.dir, "production", "licenses.md"), "utf8")).toContain("public/imports/secret.png: 测试站，自有");

    // A download button: clicked, saved into the work.
    const page = await call("browser_read", {});
    const button = await call("browser_download", { ref: ref(page.text, "下载模型") });
    // The server names the file (Content-Disposition wins over the link's download name, as in any browser).
    expect(button.data.path).toBe("public/imports/model.bin");
    expect(fs.readFileSync(path.join(work.dir, button.data.path), "utf8")).toBe("MODEL");

    // The login for a program the AI runs.
    const cookies = await call("browser_cookies", { sites: ["127.0.0.1"] });
    expect(fs.readFileSync(cookies.data.file, "utf8")).toMatch(/\tsid\tabc/);
    expect(fs.statSync(cookies.data.file).mode & 0o077).toBe(0);
  });

  it("keeps each repository's logins to itself", async () => {
    const browsers = hub(false);
    try {
      const mine = browsers.of("a");
      const theirs = browsers.of("b");
      await mine.goto(await mine.newTab({ owner: "user" }), `${siteUrl}/login`);
      expect((await mine.cookieFile([siteUrl])).total).toBe(1);
      expect((await theirs.cookieFile([siteUrl])).total).toBe(0);
      const tab = await theirs.newTab({ owner: "ai", session: "s" });
      await expect(theirs.goto(tab, `${siteUrl}/secret.png`)).rejects.toThrow(/要先登录/);
      // A tab of one repository is not there for the other.
      expect(() => theirs.get([...mine.tabs.keys()][0])).toThrow(/没有标签页/);
    } finally {
      await browsers.shutdown();
    }
  });

  it("is hidden from read-only grants", async () => {
    await expect(app.services.tools.call("browser_read", {}, { readOnly: true })).rejects.toThrow(/只读/);
  });

  it("streams the tab to the user's view and takes their clicks", async () => {
    const tabs = browser().list();
    const target = tabs.find((tab) => tab.owner === "ai");
    await browser().goto(browser().get(target.id), siteUrl);
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/browser/view?repo=${work.repo}&tab=${target.id}&width=800&height=600&dpr=1`);
    const messages = [];
    const frame = new Promise((resolve, reject) => {
      ws.on("message", (data, binary) => (binary ? resolve(data) : messages.push(JSON.parse(data))));
      ws.on("error", reject);
    });
    const jpeg = await frame;
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    expect(messages.find((item) => item.type === "view").tab).toBe(target.id);
    // The viewer's size is the page's.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(browser().get(target.id).page.viewportSize()).toEqual({ width: 800, height: 600 });
    ws.send(JSON.stringify({ type: "mouse", action: "down", x: 50, y: 50, button: "left", clicks: 1 }));
    ws.send(JSON.stringify({ type: "mouse", action: "up", x: 50, y: 50, button: "left", clicks: 1 }));
    await expect.poll(() => browser().get(target.id).page.title(), { timeout: 5000 }).toBe("点到了");
    ws.close();
    // Nobody watching: back to the AI's size.
    await expect.poll(() => browser().get(target.id).page.viewportSize()?.width, { timeout: 5000 }).toBe(1280);
  });
});
