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
    ws.sent.push(message);
    if (!answer) return;
    const value = message.op === "eval" ? { drawn: message.arg } : true;
    setImmediate(() => ws.emit("message", zlib.gzipSync(JSON.stringify({ type: "result", id: message.id, ok: true, value })), true));
  };
  // What the page says about itself: the work it has open, and whether it draws ("gpu"), chose the server or cannot.
  ws.hello = ({ work = null, mode = "gpu" } = {}) =>
    ws.emit("message", Buffer.from(JSON.stringify({ type: "state", mode, gpu, work, visible, active: true })), false);
  return ws;
}

// A socket's sign-in comes with its request (`login`, "me" when not given).
const services = () => ({
  sockets: new Map(),
  auth: { identify: (req) => ({ kind: "session", login: req.login ?? "me" }), issueInternal: () => "token" },
  events: { subscribe: () => {} },
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
    expect(on.gpu).toBe("NVIDIA GeForce RTX 3060");
    const page = await (await on.newContext()).newPage();
    await page.goto("http://127.0.0.1:4310/preview/render.html?module=x");
    expect(await page.evaluate((arg) => arg, 7)).toEqual({ drawn: 7 });
    // Heard from just now (its state): used without asking whether it is awake.
    const [goto, evaluate] = shown.sent;
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
    // Not heard from for a while: asked first, and passed over when it does not answer.
    for (const page of gpus.browsers.values()) page.heardAt = 0;
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

  it("draws where the work is open, the writer's page before others', with or without a conversation", async () => {
    const gpus = new GpuBrowsers(services());
    const mine = fakePage({ gpu: "My GPU", visible: false });
    const friends = fakePage({ gpu: "Friend's GPU" });
    const elsewhere = fakePage({ gpu: "Friend's other tab" });
    gpus.accept(mine, { login: "me" });
    gpus.accept(friends, { login: "friend" });
    gpus.accept(elsewhere, { login: "friend" });
    mine.hello({ work: "local/w1" });
    friends.hello({ work: "local/w1" }); // in view, used last
    elsewhere.hello({ work: "local/w2" });
    expect((await gpus.pick({ login: "me", repo: "local", work: "w1" })).gpu).toBe("My GPU");
    expect((await gpus.pick({ repo: "local", work: "w1" })).gpu).toBe("Friend's GPU");
    expect((await gpus.pick({ repo: "local", work: "w2" })).gpu).toBe("Friend's other tab");
    // Not open anywhere: the writer's own page, else the server.
    expect((await gpus.pick({ login: "me", repo: "local", work: "w9" })).gpu).toBe("My GPU");
    expect(await gpus.pick({ repo: "local", work: "w9" })).toBe(null);
    // Files of the work (asset_view): only a page with the work open keeps them.
    expect((await gpus.pick({ login: "me", repo: "local", work: "w1", opened: true })).gpu).toBe("My GPU");
    expect(await gpus.pick({ login: "me", repo: "local", work: "w9", opened: true })).toBe(null);
  });

  it("draws on the server for someone who chose it, and lets a phone's conversation draw where the work is open", async () => {
    const gpus = new GpuBrowsers(services());
    const mine = fakePage({ gpu: "My GPU" });
    const friends = fakePage({ gpu: "Friend's GPU", visible: false });
    const phone = fakePage({ gpu: null });
    gpus.accept(mine, { login: "me" });
    gpus.accept(friends, { login: "friend" });
    gpus.accept(phone, { login: "phone" });
    mine.hello({ work: "local/w1", mode: "server" });
    friends.hello({ work: "local/w1" });
    phone.hello({ work: "local/w1", mode: "none" });
    expect(await gpus.pick({ login: "me", repo: "local", work: "w1" })).toBe(null);
    expect((await gpus.pick({ repo: "local", work: "w1" })).gpu).toBe("Friend's GPU");
    expect((await gpus.pick({ login: "phone", repo: "local", work: "w1" })).gpu).toBe("Friend's GPU");
    expect(mine.sent.filter((message) => message.op)).toEqual([]);
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

describe("making way for the preview playing on the user's computer", () => {
  const gone = () => Object.assign(new Error("gone"), { code: "GPU_PAGE_GONE" });

  it("does not give up on a page that waits for its preview to pause, and counts the wait apart", async () => {
    const gpus = new GpuBrowsers(services());
    const ws = fakePage({ answer: false });
    gpus.accept(ws, {});
    ws.hello();
    const [on] = gpus.browsers.values();
    const say = (message) => ws.emit("message", Buffer.from(JSON.stringify(message)), false);
    say({ type: "waiting", waiting: true });
    const drawing = on.call({ op: "eval", page: "p", code: "() => 1" }, 50);
    // A quick question is answered at once, waiting or not: it times out as usual.
    await expect(on.call({ op: "ping" }, 50)).rejects.toMatchObject({ code: "GPU_PAGE_GONE" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    say({ type: "waiting", waiting: false });
    expect(on.waitedMs()).toBeGreaterThanOrEqual(100);
    ws.emit("message", zlib.gzipSync(JSON.stringify({ type: "result", id: ws.sent[0].id, ok: true, value: 7 })), true);
    expect(await drawing).toBe(7);
    // Its clock runs again once the page goes on.
    say({ type: "waiting", waiting: true });
    const late = on.call({ op: "eval", page: "p", code: "() => 2" }, 30);
    say({ type: "waiting", waiting: false });
    await expect(late).rejects.toMatchObject({ code: "GPU_PAGE_GONE" });
  });

  it("tells how long a call waited for the preview to pause", async () => {
    const renderer = new Renderer(services());
    clearInterval(renderer.sweeper);
    let waited = 400;
    renderer.gpu = { pick: async () => ({ id: "page", waitedMs: () => waited }) };
    const result = await renderer.anywhere(async () => {
      waited += 1500;
      return { drawn: true };
    }, { login: "me" });
    expect(result).toEqual({ drawn: true, paused: 1500 });
  });

  it("loads work_check's run on the user's computer, and here when that page goes away", async () => {
    const renderer = new Renderer({ ...services(), works: { meta: () => ({ ok: true, meta: { duration: 10, composition: { width: 1920, height: 1080 } } }) } });
    clearInterval(renderer.sweeper);
    const on = { id: "page", gpu: "My GPU", waitedMs: () => 0 };
    renderer.gpu = { pick: async (who) => (who?.login === "me" ? on : null) };
    renderer.freshen = () => {};
    renderer.sourceOf = () => ({ module: "/w1/project.ts", assetBase: "/files/local/w1/" });
    const opened = [];
    renderer.openPage = async (_source, options) => {
      opened.push(options.on ?? null);
      return {
        page: { evaluate: async () => (options.on && opened.length === 1 ? Promise.reject(gone()) : null) },
        errors: [],
        logs: [],
        size: { width: 640, height: 360 },
        close: async () => {},
      };
    };
    const work = { repo: "local", id: "w1" };
    // Gone halfway: not the work's fault, checked again here.
    expect(await renderer.check(work, { who: { login: "me", repo: "local", work: "w1" } })).toMatchObject({ ok: true, errors: [], gpu: null });
    expect(opened).toEqual([on, null]);
    expect(await renderer.check(work, { who: { login: "me", repo: "local", work: "w1" } })).toMatchObject({ ok: true, gpu: "My GPU", paused: 0 });
    // Without a person to draw for (the server's own checks): here.
    opened.length = 0;
    await renderer.check(work);
    expect(opened).toEqual([null]);
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
