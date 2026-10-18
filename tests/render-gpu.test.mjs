import { EventEmitter } from "node:events";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { GpuBrowsers } from "../server/render-gpu.mjs";
import { Renderer } from "../server/render.mjs";
import { Auth } from "../server/http.mjs";

/** A studio page's socket: what the server sends, and replies the way web/lib/gpu-render.ts does. */
function fakePage({ gpu = "Test GPU", visible = true, answer = true } = {}) {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, sent: [], ping() {}, terminate() {}, close() {} });
  ws.send = (text) => {
    const message = JSON.parse(text);
    // The server's first word: which extension to ask for the computer.
    if (message.type === "hello") return void (ws.connector = message.connector);
    ws.sent.push(message);
    if (!answer) return;
    const value = message.op === "eval" ? { drawn: message.arg } : true;
    setImmediate(() => ws.emit("message", zlib.gzipSync(JSON.stringify({ type: "result", id: message.id, ok: true, value })), true));
  };
  ws.hello = (computer = null) => ws.emit("message", Buffer.from(JSON.stringify({ type: "state", gpu, visible, active: true, computer })), false);
  return ws;
}

// A socket's sign-in comes with its request (`login`, "me" when not given); the repository "mine"
// is linked to one computer, whose extension gives its pages the key "my-key".
const services = () => ({
  sockets: new Map(),
  auth: { identify: (req) => ({ kind: "session", login: req.login ?? "me" }), issueInternal: () => "token" },
  events: { subscribe: () => {} },
  bridges: { linked: (repo) => new Set(repo === "mine" ? ["my-computer"] : []), computerOf: (key) => (key === "my-key" ? "my-computer" : null) },
});

describe("drawing on the user's GPU", () => {
  it("picks a shown page that answers, and drives it like a Playwright page", async () => {
    const gpus = new GpuBrowsers(services());
    const hidden = fakePage({ visible: false });
    const shown = fakePage({ gpu: "NVIDIA GeForce RTX 3060" });
    gpus.accept(hidden, {});
    gpus.accept(shown, {});
    hidden.hello();
    shown.hello();
    const on = await gpus.pick({ login: "me" });
    expect(shown.connector).toMatch(/^[a-p]{32}$/);
    expect(on.gpu).toBe("NVIDIA GeForce RTX 3060");
    const page = await (await on.newContext()).newPage();
    await page.goto("http://127.0.0.1:4310/preview/render.html?module=x");
    expect(await page.evaluate((arg) => arg, 7)).toEqual({ drawn: 7 });
    const [goto, evaluate] = shown.sent.slice(1);
    expect(goto).toMatchObject({ op: "goto", url: "/preview/render.html?module=x" });
    expect(evaluate).toMatchObject({ op: "eval", code: "(arg) => arg", arg: 7 });
    expect(hidden.sent).toEqual([]);
  });

  it("passes over a page without a GPU or that does not answer, and draws here when none is left", async () => {
    const gpus = new GpuBrowsers(services());
    const silent = fakePage({ answer: false });
    const software = fakePage({ gpu: null });
    gpus.accept(silent, {});
    gpus.accept(software, {});
    silent.hello();
    software.hello();
    expect(await gpus.pick({ login: "me" })).toBe(null);
    expect(silent.sent.map((message) => message.op)).toEqual(["ping"]);
    expect(software.sent).toEqual([]);
  }, 10000);

  it("never draws on another sign-in's page, nor for a caller without one", async () => {
    const gpus = new GpuBrowsers(services());
    const mine = fakePage({ visible: false });
    const friends = fakePage({ gpu: "Friend's GPU" });
    gpus.accept(mine, { login: "me" });
    gpus.accept(friends, { login: "friend" });
    friends.hello(); // in view and used last
    mine.hello();
    expect((await gpus.pick({ login: "me" })).gpu).toBe("Test GPU");
    expect(await gpus.pick({})).toBe(null);
    expect(await gpus.pick({ login: "someone else" })).toBe(null);
    expect(friends.sent).toEqual([]);
  });

  it("draws on the computer the work's repository is linked to, whoever writes and with no conversation", async () => {
    const gpus = new GpuBrowsers(services());
    const linked = fakePage({ gpu: "Linked GPU", visible: false });
    const writer = fakePage({ gpu: "Writer's GPU" });
    gpus.accept(linked, { login: "someone" });
    gpus.accept(writer, { login: "me" });
    linked.hello("my-key");
    writer.hello("a key FRAME never gave");
    expect((await gpus.pick({ login: "me", repo: "mine" })).gpu).toBe("Linked GPU");
    expect((await gpus.pick({ repo: "mine" })).gpu).toBe("Linked GPU");
    // A repository linked nowhere: the browser writing in the conversation.
    expect((await gpus.pick({ login: "me", repo: "other" })).gpu).toBe("Writer's GPU");
    expect(await gpus.pick({ repo: "other" })).toBe(null);
  });

  it("refuses sockets that are not a person's studio page", () => {
    const gpus = new GpuBrowsers({ ...services(), auth: { identify: () => ({ kind: "token" }) } });
    const ws = fakePage();
    let closed = null;
    ws.close = (code) => (closed = code);
    gpus.accept(ws, {});
    expect(closed).toBe(4003);
  });

  it("reports the page's errors as page events, and a closed page as gone", async () => {
    const gpus = new GpuBrowsers(services());
    const ws = fakePage({ answer: false });
    gpus.accept(ws, {});
    ws.hello();
    const [on] = gpus.browsers.values();
    expect(on.login).toBe("me");
    const page = await (await on.newContext()).newPage();
    const seen = [];
    page.on("pageerror", (error) => seen.push(error.message));
    page.on("console", (message) => seen.push(`${message.type()}: ${message.text()}`));
    page.on("response", (response) => seen.push(`${response.status()} ${response.url()} ${JSON.stringify(response.request().headers())}`));
    for (const event of [
      { kind: "pageerror", message: "boom" },
      { kind: "console", level: "warning", text: "careful" },
      { kind: "response", status: 404, url: "http://x/files/a.png" },
    ])
      ws.emit("message", Buffer.from(JSON.stringify({ type: "event", page: page.id, ...event })), false);
    await new Promise(setImmediate);
    expect(seen).toEqual(["boom", "warning: careful", "404 http://x/files/a.png {}"]);
    const pending = page.evaluate(() => 1);
    ws.emit("close");
    await expect(pending).rejects.toMatchObject({ code: "GPU_PAGE_GONE" });
  });

  it("draws here when the page goes away halfway", async () => {
    const renderer = new Renderer(services());
    clearInterval(renderer.sweeper);
    const on = { id: "page" };
    renderer.gpu = { pick: async (who) => (who?.login === "me" ? on : null) };
    const tried = [];
    const result = await renderer.anywhere(
      async (where) => {
        tried.push(where);
        if (where) throw Object.assign(new Error("gone"), { code: "GPU_PAGE_GONE" });
        return "drawn here";
      },
      { login: "me" },
    );
    expect(result).toBe("drawn here");
    expect(tried).toEqual([on, null]);
    // Other failures are the work's: not drawn again.
    await expect(renderer.anywhere(async () => Promise.reject(new Error("scene threw")))).rejects.toThrow("scene threw");
  });
});

describe("telling sign-ins apart", () => {
  const auth = (password) => {
    const secrets = new Map();
    return new Auth({
      config: { password },
      settings: { secret: (key) => secrets.get(key), setSecret: (key, value) => secrets.set(key, value), get: () => ({ tokens: [] }) },
    });
  };
  const request = (cookie) => ({ url: "/api/render/gpu", headers: { cookie } });
  it("gives each browser's sign-in its own stable login, and the local studio one", () => {
    const studio = auth("secret-pass");
    const first = studio.sessionCookie().split(";")[0];
    const second = studio.sessionCookie().split(";")[0];
    const login = (cookie) => studio.identify(request(cookie)).login;
    expect(login(first)).toMatch(/^[0-9a-f]{16}$/);
    expect(login(first)).toBe(login(first));
    expect(login(second)).not.toBe(login(first));
    expect(auth("").identify(request("")).login).toBe("local");
  });
});
