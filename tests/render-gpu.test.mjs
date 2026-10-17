import { EventEmitter } from "node:events";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { GpuBrowsers } from "../server/render-gpu.mjs";
import { Renderer } from "../server/render.mjs";

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
  ws.hello = () => ws.emit("message", Buffer.from(JSON.stringify({ type: "state", gpu, visible, active: true })), false);
  return ws;
}

const services = () => ({ sockets: new Map(), auth: { identify: () => ({ kind: "session" }), issueInternal: () => "token" }, events: { subscribe: () => {} } });

describe("drawing on the user's GPU", () => {
  it("picks a shown page that answers, and drives it like a Playwright page", async () => {
    const gpus = new GpuBrowsers(services());
    const hidden = fakePage({ visible: false });
    const shown = fakePage({ gpu: "NVIDIA GeForce RTX 3060" });
    gpus.accept(hidden, {});
    gpus.accept(shown, {});
    hidden.hello();
    shown.hello();
    const on = await gpus.pick();
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
    expect(await gpus.pick()).toBe(null);
    expect(silent.sent.map((message) => message.op)).toEqual(["ping"]);
    expect(software.sent).toEqual([]);
  }, 10000);

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
    renderer.gpu = { pick: async () => on };
    const tried = [];
    const result = await renderer.anywhere(async (where) => {
      tried.push(where);
      if (where) throw Object.assign(new Error("gone"), { code: "GPU_PAGE_GONE" });
      return "drawn here";
    });
    expect(result).toBe("drawn here");
    expect(tried).toEqual([on, null]);
    // Other failures are the work's: not drawn again.
    await expect(renderer.anywhere(async () => Promise.reject(new Error("scene threw")))).rejects.toThrow("scene threw");
  });
});
