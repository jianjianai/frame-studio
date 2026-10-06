import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    const manifest = async () => {
      const response = await server.call(`/api/works/local/${created.body.id}/precache`);
      return Object.fromEntries(response.body.files.map((item) => [item.path, item]));
    };
    const first = await manifest();
    expect((await server.call(`/api/works/local/${created.body.id}/precache`)).body.base).toBe(`/files/local/${created.body.id}/films/${created.body.slug}/`);
    expect(first["sub/声音.wav"]).toMatchObject({ size: 8, version: expect.stringMatching(/^[0-9a-f]{32}$/) });
    // Equal content, equal version: the browser copies instead of downloading again.
    expect(first["copy.wav"].version).toBe(first["sub/声音.wav"].version);
    // A new mtime alone does not make it a new version; new content does.
    fs.utimesSync(file("sub/声音.wav"), new Date(), new Date(Date.now() + 5000));
    expect((await manifest())["sub/声音.wav"].version).toBe(first["sub/声音.wav"].version);
    fs.writeFileSync(file("sub/声音.wav"), "RIFFother");
    expect((await manifest())["sub/声音.wav"].version).not.toBe(first["sub/声音.wav"].version);
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
    const response = await post(["a.txt", "空.bin", "logo.svg"]);
    const bytes = Buffer.from(await response.arrayBuffer());
    const parsed = [];
    for (let offset = 0; offset < bytes.length; ) {
      const length = bytes.readUInt32BE(offset);
      const header = JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString());
      offset += 4 + length;
      parsed.push({ ...header, body: bytes.subarray(offset, offset + header.size).toString() });
      offset += header.size;
    }
    expect(parsed.map((item) => item.path)).toEqual(["a.txt", "空.bin", "logo.svg"]);
    expect(parsed[0]).toMatchObject({ size: 5, body: "hello", type: expect.stringContaining("text/plain"), version: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(parsed[1]).toMatchObject({ size: 0, body: "" });
    expect(parsed[2].body).toContain("<svg");
    expect((await post(["../project.ts"])).status).toBe(400);
    expect((await post(["missing.png"])).status).toBe(404);
  });

  it("answers missing work files with 404 and keeps serving", async () => {
    const created = await server.call("/api/works", { method: "POST", body: { title: "缺失文件" } });
    for (const route of [`/files/local/${created.body.id}/films/${created.body.slug}/missing.png`, "/files/local/nope/films/x/y.png", "/films/nope/missing.png"])
      expect((await server.call(route)).status).toBe(404);
    expect((await server.call("/api/state")).status).toBe(200);
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
      expect(await attempt("/", "vite-hmr")).toBe(401);
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
