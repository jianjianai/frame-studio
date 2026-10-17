import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";

const start = async (env = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-app-"));
  const app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0", ...env }, plugins });
  const base = await app.listen();
  const call = async (route, { method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
  };
  return { app, base, call };
};

describe("studio API (local mode)", () => {
  let server;
  beforeAll(async () => (server = await start()));
  afterAll(() => server.app.close());

  it("creates, edits and versions a work over HTTP", async () => {
    const { call } = server;
    const created = await call("/api/works", { method: "POST", body: { title: "接口测试", duration: 4 } });
    expect(created.status).toBe(200);
    const base = `/api/works/local/${created.body.id}`;
    const tree = await call(`${base}/tree`);
    expect(tree.body.map((entry) => entry.path)).toContain("scene.ts");
    const file = await call(`${base}/file?path=scene.ts`);
    const saved = await call(`${base}/file`, {
      method: "PUT",
      body: { path: "scene.ts", content: file.body.content + "\n// edit\n", expectedHash: file.body.hash },
    });
    expect(saved.status).toBe(200);
    const stale = await call(`${base}/file`, { method: "PUT", body: { path: "scene.ts", content: "x", expectedHash: file.body.hash } });
    expect(stale.status).toBe(409);
    expect((await call(`${base}/commit`, { method: "POST", body: { message: "编辑" } })).body.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await call(`${base}/history`)).body[0].message).toBe("编辑");
  });

  it("rejects path traversal", async () => {
    const created = await server.call("/api/works", { method: "POST", body: { title: "安全" } });
    const response = await server.call(`/api/works/local/${created.body.id}/file?path=../../../../etc/passwd`);
    expect(response.status).toBe(400);
  });

  it("lists playback files for the precache with content versions", async () => {
    const created = await server.call("/api/works", { method: "POST", body: { title: "预缓存" } });
    const dir = (await server.app.services.works.open(created.body.id, "local")).dir;
    const file = (name) => path.join(dir, "public", name);
    fs.mkdirSync(file("sub"), { recursive: true });
    fs.writeFileSync(file("sub/声音.wav"), "RIFFdata");
    fs.writeFileSync(file("copy.wav"), "RIFFdata");
    const films = `films/${created.body.slug}/`;
    const manifest = async () => {
      const response = await server.call(`/api/works/local/${created.body.id}/precache`);
      return Object.fromEntries(response.body.files.map((item) => [item.path, item]));
    };
    const first = await manifest();
    expect((await server.call(`/api/works/local/${created.body.id}/precache`)).body).toMatchObject({
      key: `local/${created.body.id}`,
      base: `/files/local/${created.body.id}/`,
      at: expect.any(Number),
    });
    expect(first[films + "sub/声音.wav"]).toMatchObject({ size: 8, version: expect.stringMatching(/^[0-9a-f]{32}$/) });
    // Equal content, equal version: the browser copies instead of downloading again.
    expect(first[films + "copy.wav"].version).toBe(first[films + "sub/声音.wav"].version);
    // A new mtime alone does not make it a new version; new content does.
    fs.utimesSync(file("sub/声音.wav"), new Date(), new Date(Date.now() + 5000));
    expect((await manifest())[films + "sub/声音.wav"].version).toBe(first[films + "sub/声音.wav"].version);
    fs.writeFileSync(file("sub/声音.wav"), "RIFFother");
    expect((await manifest())[films + "sub/声音.wav"].version).not.toBe(first[films + "sub/声音.wav"].version);
  });

  it("bundles small files in one framed response", async () => {
    const created = await server.call("/api/works", { method: "POST", body: { title: "打包" } });
    const dir = (await server.app.services.works.open(created.body.id, "local")).dir;
    fs.mkdirSync(path.join(dir, "public"), { recursive: true });
    fs.writeFileSync(path.join(dir, "public", "a.txt"), "hello");
    fs.writeFileSync(path.join(dir, "public", "空.bin"), "");
    fs.writeFileSync(path.join(dir, "public", "logo.svg"), "<svg/>");
    const url = `${server.base}/api/works/local/${created.body.id}/precache/bundle`;
    const post = (paths) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) });
    const films = `films/${created.body.slug}/`;
    const response = await post([films + "a.txt", films + "空.bin", films + "logo.svg"]);
    const bytes = Buffer.from(await response.arrayBuffer());
    const parsed = [];
    for (let offset = 0; offset < bytes.length; ) {
      const length = bytes.readUInt32BE(offset);
      const header = JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString());
      offset += 4 + length;
      parsed.push({ ...header, body: bytes.subarray(offset, offset + header.size).toString() });
      offset += header.size;
    }
    expect(parsed.map((item) => item.path)).toEqual([films + "a.txt", films + "空.bin", films + "logo.svg"]);
    expect(parsed[0]).toMatchObject({ size: 5, body: "hello", type: expect.stringContaining("text/plain"), version: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(parsed[1]).toMatchObject({ size: 0, body: "" });
    expect(parsed[2].body).toContain("<svg");
    expect((await post([films + "../project.ts"])).status).toBe(400);
    expect((await post(["films/another-work/a.txt"])).status).toBe(404);
    expect((await post([films + "missing.png"])).status).toBe(404);
  });

  it("gives the stage page its modules with their versions, and the work's playback files", async () => {
    const created = await server.call("/api/works", { method: "POST", body: { title: "预加载" } });
    const work = (await server.call(`/api/works/local/${created.body.id}`)).body;
    const query = new URLSearchParams({ work: work.id, module: work.preview.module, assetBase: work.preview.assetBase });
    const response = await fetch(`${server.base}/preview/stage.html?${query}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    const data = JSON.parse(/<script type="application\/json" id="frame-cache">([\s\S]*?)<\/script>/.exec(html)[1]);
    // The work is imported by address (Vite adds ?import), its scene modules dynamically.
    const project = work.preview.module + "?import";
    expect(data.modules).toMatchObject({ "/src/preview/stage.ts": expect.stringMatching(/^W\//), [project]: expect.any(String) });
    expect(Object.keys(data.modules)).toContain(work.preview.module.replace("project.ts", "scene.ts"));
    expect(Object.keys(data.modules).some((url) => url.startsWith("/src/engine/player-session.ts"))).toBe(true);
    // Every module but the page's own scripts is preloaded, so the graph is fetched at once.
    const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((match) => match[1].replace(/&amp;/g, "&"));
    expect(preloaded).toContain(project);
    expect(preloaded).not.toContain("/src/preview/stage.ts");
    // What the browser serves from its own cache is exactly what the server sends now.
    const etag = (await fetch(server.base + "/src/engine/player-session.ts")).headers.get("etag");
    expect(data.modules["/src/engine/player-session.ts"]).toBe(etag);
    expect(data.precache).toMatchObject({ key: `local/${work.id}`, base: `/files/local/${work.id}/`, files: [] });
  });

  it("gives the local export page the work's modules and playback files, like the stage", async () => {
    const created = await server.call("/api/works", { method: "POST", body: { title: "本机导出" } });
    const work = (await server.call(`/api/works/local/${created.body.id}`)).body;
    const query = new URLSearchParams({ job: "x", module: work.preview.module, assetBase: work.preview.assetBase });
    const response = await fetch(`${server.base}/preview/export.html?${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    const data = JSON.parse(/<script type="application\/json" id="frame-cache">([\s\S]*?)<\/script>/.exec(html)[1]);
    expect(Object.keys(data.modules)).toEqual(expect.arrayContaining(["/src/preview/export.ts", work.preview.module + "?import"]));
    expect(Object.keys(data.modules).some((url) => url.startsWith("/src/engine/browser-export.ts"))).toBe(true);
    expect(data.precache).toMatchObject({ key: `local/${work.id}`, base: `/files/local/${work.id}/` });
  });

  it("answers revalidation with 304 for weak tags too (proxies that compress send them)", async () => {
    const created = await server.call("/api/works", { method: "POST", body: { title: "弱标签" } });
    const dir = (await server.app.services.works.open(created.body.id, "local")).dir;
    fs.mkdirSync(path.join(dir, "public"), { recursive: true });
    fs.writeFileSync(path.join(dir, "public", "a.txt"), "hello");
    const url = `${server.base}/files/local/${created.body.id}/films/${created.body.slug}/a.txt`;
    const etag = (await fetch(url)).headers.get("etag");
    expect((await fetch(url, { headers: { "If-None-Match": etag } })).status).toBe(304);
    expect((await fetch(url, { headers: { "If-None-Match": `"other", W/${etag}` } })).status).toBe(304);
    expect((await fetch(url, { headers: { "If-None-Match": `"other"` } })).status).toBe(200);
  });

  it("answers missing work files with 404 and keeps serving", async () => {
    const created = await server.call("/api/works", { method: "POST", body: { title: "缺失文件" } });
    for (const route of [`/files/local/${created.body.id}/films/${created.body.slug}/missing.png`, "/files/local/nope/films/x/y.png", "/films/nope/missing.png"])
      expect((await server.call(route)).status).toBe(404);
    expect((await server.call("/api/state")).status).toBe(200);
  });

  it("downloads picked files: one as it is, more or a folder as a zip", async () => {
    const created = await server.call("/api/works", { method: "POST", body: { title: "导出选中" } });
    const base = `/api/works/local/${created.body.id}`;
    const dir = (await server.app.services.works.open(created.body.id, "local")).dir;
    fs.mkdirSync(path.join(dir, "public/sub/empty"), { recursive: true });
    fs.writeFileSync(path.join(dir, "public/a.png"), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
    fs.writeFileSync(path.join(dir, "public/sub/声音.wav"), "RIFFdata");
    const pick = (paths) => server.call(`${base}/download`, { method: "POST", body: { paths } });

    const one = await pick(["public/a.png"]);
    expect(one.body).toMatchObject({ name: "a.png", size: 7, count: 1 });
    const file = await fetch(server.base + one.body.url);
    expect(file.headers.get("content-disposition")).toContain("attachment");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([137, 80, 78, 71, 0, 1, 2]);

    // Files picked in one folder unpack without it; a picked folder keeps its name, what it holds goes with it.
    const many = await pick(["public/a.png", "public/sub", "public/sub/声音.wav"]);
    expect(many.body).toMatchObject({ name: "public.zip", count: 2, size: 15 });
    const zip = await fetch(server.base + many.body.url);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(zip.headers.get("content-disposition")).toContain("public.zip");
    const bytes = new Uint8Array(await zip.arrayBuffer());
    expect(Number(zip.headers.get("content-length"))).toBe(bytes.length);
    const unpacked = unzipSync(bytes);
    expect(Object.keys(unpacked).sort()).toEqual(["a.png", "sub/", "sub/empty/", "sub/声音.wav"]);
    expect(strFromU8(unpacked["sub/声音.wav"])).toBe("RIFFdata");
    expect([...unpacked["a.png"]]).toEqual([137, 80, 78, 71, 0, 1, 2]);

    const folder = await pick(["public"]);
    expect(folder.body.name).toBe("public.zip");
    expect(Object.keys(unzipSync(new Uint8Array(await (await fetch(server.base + folder.body.url)).arrayBuffer())))).toContain("public/sub/声音.wav");
    const mixed = await pick(["scene.ts", "public/a.png"]);
    expect(mixed.body.name).toBe(`${created.body.slug}.zip`);

    expect((await pick(["public/missing.png"])).status).toBe(404);
    expect((await pick([])).status).toBe(400);
    expect((await pick(["../../etc/passwd"])).status).toBe(400);
    expect((await server.call(`${base}/download/not-a-token`)).status).toBe(404);
  });

  it("takes videos to compare into sheets/, kept with the work but not in the playback precache", async () => {
    const work = await server.app.services.works.create({ title: "对比视频" });
    const base = `/api/works/local/${work.id}`;
    const upload = (file) => fetch(`${server.base}${base}/upload?path=${encodeURIComponent(file)}&unique=1`, { method: "POST", headers: { "Content-Type": "video/webm" }, body: "webm" });
    const first = await (await upload("sheets/参考片.webm")).json();
    const second = await (await upload("sheets/参考片.webm")).json();
    expect([first.path, second.path]).toEqual(["sheets/参考片.webm", "sheets/参考片-2.webm"]);
    expect((await upload("scenes/x.webm")).status).toBe(400);
    const precache = await server.call(`/api/works/local/${work.id}/precache`);
    expect(JSON.stringify(precache.body ?? {})).not.toContain("参考片");
    const raw = await fetch(`${server.base}${base}/raw?path=${encodeURIComponent("sheets/参考片.webm")}`, { headers: { Range: "bytes=0-1" } });
    expect([raw.status, await raw.text()]).toEqual([206, "we"]);
  });

  it("exposes the tool registry", async () => {
    const tools = await server.call("/api/tools");
    expect(tools.body.map((tool) => tool.name)).toEqual(expect.arrayContaining(["work_context", "preview_frames", "speech_synthesize"]));
    const list = await server.call("/api/tools/works_list", { method: "POST", body: {} });
    expect(Array.isArray(list.body.data)).toBe(true);
  });

  it("blocks cross-site writes and foreign Host headers", async () => {
    const cross = await server.call("/api/works", { method: "POST", body: { title: "x" }, headers: { Origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
    // fetch() cannot override Host; DNS rebinding arrives with a foreign Host header.
    const rebinding = await new Promise((resolve, reject) =>
      http.get(server.base + "/api/state", { headers: { Host: "evil.example" } }, (response) => resolve(response.statusCode)).on("error", reject),
    );
    expect(rebinding).toBe(403);
    const form = await fetch(server.base + "/api/works", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(form.status).toBe(415);
  });
});

describe("studio API (password mode)", () => {
  let server;
  beforeAll(async () => (server = await start({ FRAME_PASSWORD: "secret-pass" })));
  afterAll(() => server.app.close());

  it("requires login and issues a session cookie", async () => {
    expect((await server.call("/api/works")).status).toBe(401);
    expect((await server.call("/api/login", { method: "POST", body: { password: "wrong" } })).status).toBe(401);
    const login = await server.call("/api/login", { method: "POST", body: { password: "secret-pass" } });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    expect((await server.call("/api/works", { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("serves any domain the studio is reached through (reverse proxies, tunnels)", async () => {
    const login = await server.call("/api/login", { method: "POST", body: { password: "secret-pass" } });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    // fetch() cannot override Host; Vite serves /@vite/client and blocks unknown hosts by default.
    const status = await new Promise((resolve, reject) =>
      http
        .get(server.base + "/@vite/client", { headers: { Host: "frame.example.com", Cookie: cookie } }, (response) => (response.resume(), resolve(response.statusCode)))
        .on("error", reject),
    );
    expect(status).toBe(200);
  });

  it("accepts MCP tokens and keeps read-only tokens read-only", async () => {
    const login = await server.call("/api/login", { method: "POST", body: { password: "secret-pass" } });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const token = await server.call("/api/mcp/tokens", { method: "POST", body: { name: "ro", readOnly: true }, headers: { Cookie: cookie } });
    const auth = { Authorization: "Bearer " + token.body.token };
    expect((await server.call("/api/tools/works_list", { method: "POST", body: {}, headers: auth })).status).toBe(200);
    expect((await server.call("/api/tools/work_create", { method: "POST", body: { title: "x" }, headers: auth })).status).toBe(403);
  });

  it("serves a work's HTML pages under a signed address that needs no cookie, sandboxed", async () => {
    const login = await server.call("/api/login", { method: "POST", body: { password: "secret-pass" } });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const work = await server.app.services.works.create({ title: "页面" });
    fs.mkdirSync(path.join(work.dir, "public", "page"), { recursive: true });
    fs.writeFileSync(path.join(work.dir, "public", "page", "样片.html"), '<img src="a.svg">');
    fs.writeFileSync(path.join(work.dir, "public", "page", "a.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const route = `/api/works/local/${work.id}`;
    expect((await server.call(`${route}/page-link`)).status).toBe(401);
    const { base } = (await server.call(`${route}/page-link`, { headers: { Cookie: cookie } })).body;
    expect(base).toMatch(new RegExp(`^${route}/page/\\d+\\.[\\w-]+/$`));
    // The page and the files it names by relative paths, without the session cookie.
    const page = await fetch(server.base + base + "public/page/" + encodeURIComponent("样片.html"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-popups allow-modals allow-downloads");
    expect(await page.text()).toBe('<img src="a.svg">');
    expect((await fetch(server.base + base + "public/page/a.svg")).status).toBe(200);
    // Another work, a forged or expired signature, a path out of the work: refused.
    const other = await server.app.services.works.create({ title: "别的" });
    const token = base.split("/").at(-2);
    expect((await fetch(`${server.base}/api/works/local/${other.id}/page/${token}/project.ts`)).status).toBe(403);
    expect((await fetch(`${server.base}${route}/page/${Date.now() + 1000}.forged/project.ts`)).status).toBe(403);
    const expired = Date.now() - 1000;
    expect((await fetch(`${server.base}${route}/page/${expired}.${server.app.services.auth.sign(`page:local/${work.id}:${expired}`)}/project.ts`)).status).toBe(403);
    expect((await fetch(server.base + base + "..%2F..%2F..%2Fsettings.json")).status).toBe(400);
  });

  it("does not hand outside AIs the server's own folder", async () => {
    const work = await server.app.services.works.create({ title: "外部" });
    const context = JSON.parse((await server.app.services.tools.call("work_context", { work: work.id })).text);
    expect(context.work).toMatchObject({ id: work.id, slug: work.slug });
    expect(context.work.dir).toBeUndefined();
  });
});

describe("websocket access", () => {
  it("rejects unauthenticated upgrades, including Vite HMR, in password mode", async () => {
    const server = await start({ FRAME_PASSWORD: "pw-123456" });
    try {
      const { WebSocket } = await import("ws");
      const attempt = (path, protocol) =>
        new Promise((resolve) => {
          const ws = new WebSocket(server.base.replace("http", "ws") + path, protocol);
          ws.on("open", () => (ws.close(), resolve("open")));
          ws.on("unexpected-response", (_, response) => resolve(response.statusCode));
          ws.on("error", () => resolve("error"));
        });
      expect(await attempt("/api/ws")).toBe(401);
      expect(await attempt("/api/speech/listen")).toBe(401);
      expect(await attempt("/", "vite-hmr")).toBe(401);
    } finally {
      await server.app.close();
    }
  });

  it("voice input offers the recognition model while none is installed", async () => {
    const server = await start();
    try {
      const providers = await server.call("/api/speech/providers");
      expect(providers.body.recognition.provider).toBeNull();
      expect(providers.body.recognition.models[0]).toMatchObject({ id: expect.stringMatching(/^sense-voice/), installed: false });
      const { WebSocket } = await import("ws");
      const messages = await new Promise((resolve, reject) => {
        const ws = new WebSocket(server.base.replace("http", "ws") + "/api/speech/listen");
        const received = [];
        ws.on("message", (data) => received.push(JSON.parse(String(data))));
        ws.on("close", () => resolve(received));
        ws.on("error", reject);
      });
      expect(messages).toEqual([expect.objectContaining({ type: "error", code: "NO_RECOGNIZER", model: expect.objectContaining({ id: providers.body.recognition.models[0].id }) })]);
      // A configured service is used once it is the only engine there is.
      await server.call("/api/speech/settings", { method: "PATCH", body: { recognition: { openai: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" } } } });
      expect((await server.call("/api/speech/providers")).body.recognition).toMatchObject({ provider: "openai", openai: { baseUrl: "http://127.0.0.1:9/v1", hasKey: true } });
    } finally {
      await server.app.close();
    }
  });

  it("uses the recognition model that comes with the program, and keeps it", async () => {
    const shipped = fs.mkdtempSync(path.join(os.tmpdir(), "frame-models-"));
    const { RECOGNITION_MODELS } = await import("../server/speech/models.mjs");
    const id = RECOGNITION_MODELS[0].id;
    fs.mkdirSync(path.join(shipped, id));
    fs.writeFileSync(path.join(shipped, id, ".installed"), "");
    const server = await start({ FRAME_SPEECH_MODELS: shipped });
    try {
      const { recognition } = (await server.call("/api/speech/providers")).body;
      expect(recognition.provider).toBe("local:" + id);
      expect(recognition.models[0]).toMatchObject({ id, installed: true, builtin: true });
      expect((await server.call(`/api/speech/models/${id}`, { method: "DELETE" })).status).toBe(400);
      expect(fs.existsSync(path.join(shipped, id, ".installed"))).toBe(true);
    } finally {
      await server.app.close();
    }
  });
});

describe("configuration", () => {
  it("refuses network exposure without a password", async () => {
    const { loadConfig } = await import("../server/config.mjs");
    expect(() => loadConfig({ FRAME_HOME: os.tmpdir(), FRAME_HOST: "0.0.0.0" })).toThrow(/FRAME_PASSWORD/);
    expect(() => loadConfig({ FRAME_HOME: os.tmpdir(), FRAME_PUBLIC_URL: "https://frame.example.com" })).toThrow(/FRAME_PASSWORD/);
    expect(loadConfig({ FRAME_HOME: os.tmpdir(), FRAME_HOST: "0.0.0.0", FRAME_PASSWORD: "x" }).host).toBe("0.0.0.0");
  });

  it("gives internal callers a loopback (secure-context) address when listening on all interfaces", async () => {
    const server = await start({ FRAME_HOST: "0.0.0.0", FRAME_PASSWORD: "secret-pass" });
    try {
      expect(server.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await server.app.close();
    }
  });
});
