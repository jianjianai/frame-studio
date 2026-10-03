import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createServer } from "vite";
import { launchBrowser } from "../../scripts/browser.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = path.resolve(".");
const base = "/preview-live/cache-fixture/";
function wav() {
  const bytes = Buffer.alloc(44 + 9600);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(9600, 40);
  for (let i = 0; i < 4800; i++)
    bytes.writeInt16LE(
      Math.round(Math.sin(((i * 440) / 48000) * 2 * Math.PI) * 10000),
      44 + i * 2,
    );
  return bytes;
}
test(
  "opaque preview cache persists, serves ranges/media/workers/worklets and refreshes revisions without network",
  { timeout: 120000 },
  async () => {
    const files = new Map(),
      counts = new Map();
    let revision = 1;
    files.set(
      "assets/shared.js",
      Buffer.from(
        "export const singleton=globalThis.__singleton??={stamp:Math.random()};",
      ),
    );
    files.set(
      "assets/project-v1.js",
      Buffer.from(
        "import {singleton} from './shared.js';export {singleton};export const version=1;export const picture=new URL('../films/cache-film/picture.png',import.meta.url).href;",
      ),
    );
    files.set(
      "assets/worker.js",
      Buffer.from(
        "onmessage=async()=>{const r=await fetch(self.__FRAME_LIVE_ASSET_BASE__+'films/cache-film/voice.wav');postMessage((await r.arrayBuffer()).byteLength);};",
      ),
    );
    files.set(
      "assets/worklet.js",
      Buffer.from(
        "class Quiet extends AudioWorkletProcessor{process(inputs,outputs){return true;}}registerProcessor('frame-cache-quiet',Quiet);",
      ),
    );
    files.set(
      "films/cache-film/picture.png",
      await sharp({
        create: { width: 32, height: 20, channels: 4, background: "#58aa75" },
      })
        .png()
        .toBuffer(),
    );
    files.set("films/cache-film/voice.wav", wav());
    files.set("films/cache-film/bank.sf2", Buffer.alloc(1024 * 1024, 7));
    files.set(
      "vendor/cache/test.wasm",
      Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    const fontDirectory = path.join(root, "public/fonts");
    let font;
    try {
      font = (await fs.readdir(fontDirectory)).find((name) =>
        /\.woff2?$/.test(name),
      );
      if (font)
        files.set(
          "fonts/" + font,
          await fs.readFile(path.join(fontDirectory, font)),
        );
    } catch {}
    const manifest = () => ({
      revision,
      resources: [...files].map(([item, bytes]) => {
        const hash = sha(bytes);
        return {
          path: item,
          url: base + item + "?v=" + hash,
          originalUrl: base + item + "?v=" + hash,
          sha256: hash,
          revision: hash,
          bytes: bytes.length,
          type: item.endsWith(".js")
            ? "application/javascript"
            : item.endsWith(".png")
              ? "image/png"
              : item.endsWith(".wav")
                ? "audio/wav"
                : item.endsWith(".wasm")
                  ? "application/wasm"
                  : item.endsWith(".woff2")
                    ? "font/woff2"
                    : "application/octet-stream",
          kind: item.startsWith("assets/")
            ? "module"
            : item.startsWith("films/")
              ? "media"
              : "runtime",
        };
      }),
      projectUrl: "assets/project-v" + revision + ".js",
    });
    const child = `<!doctype html><div id="root"></div><script type="module">
 import {createLivePreviewCache} from '/src/engine/live-preview-cache.ts';
 import {singleton} from '${base}assets/shared.js';
 window.singleton=singleton;window.events=[];window.cacheURLs=new Set();const createURL=URL.createObjectURL.bind(URL),revokeURL=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=createURL(blob);cacheURLs.add(url);return url;};URL.revokeObjectURL=url=>{cacheURLs.delete(url);revokeURL(url);};
 const cache=window.cache=createLivePreviewCache(s=>{window.cacheStatus=s;events.push(s.state)});
 cache.setMode("cached");await cache.prepare(await(await fetch("manifest.json")).json(),new AbortController().signal);
 const project=await import("${base}assets/project-v1.js");window.project=project;
 cache.committed();window.ready=true;
 </script>`;
    const parent = `<!doctype html><iframe id="preview" sandbox="allow-scripts" src="${base}index.html"></iframe><script type="module">
 import {previewCacheBridge} from '/studio/preview-cache.js';
 window.release=previewCacheBridge({current:document.getElementById("preview")},"${base}index.html");
 </script>`;
    const cacheDir = path.join(
      root,
      ".cache",
      "preview-cache-browser-" + process.pid,
    );
    const vite = await createServer({
      root,
      cacheDir,
      optimizeDeps: { noDiscovery: true, include: [] },
      configFile: false,
      server: {
        host: "127.0.0.1",
        port: 0,
        cors: true,
        watch: null,
      },
      plugins: [
        {
          name: "cache-fixture",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              const url = new URL(req.url, "http://localhost");
              if (url.pathname === "/cache-parent") {
                res.setHeader("Content-Type", "text/html");
                res.end(parent);
                return;
              }
              if (!url.pathname.startsWith(base)) return next();
              res.setHeader("Access-Control-Allow-Origin", "*");
              const relative = url.pathname.slice(base.length);
              if (relative === "index.html") {
                res.setHeader("Content-Type", "text/html");
                res.setHeader(
                  "Content-Security-Policy",
                  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; connect-src 'self' blob:; img-src 'self' blob:; media-src 'self' blob:; font-src 'self' blob:; worker-src 'self' blob:; style-src 'unsafe-inline'",
                );
                res.end(child);
                return;
              }
              if (relative === "manifest.json") {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(manifest()));
                return;
              }
              const bytes = files.get(relative);
              if (!bytes) {
                res.statusCode = 404;
                res.end("missing");
                return;
              }
              counts.set(relative, (counts.get(relative) || 0) + 1);
              res.setHeader(
                "Content-Type",
                manifest().resources.find((r) => r.path === relative).type,
              );
              res.setHeader("Content-Length", bytes.length);
              res.end(bytes);
            });
          },
        },
      ],
    });
    let browser;
    try {
      await vite.listen();
      const address = vite.httpServer.address(),
        url = "http://127.0.0.1:" + address.port;
      browser = await launchBrowser({ headless: true });
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/studio/live-resource-cache.js", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1800));
        await route.continue();
      });
      await page.goto(url + "/cache-parent");
      const frame = page.frames().find((f) => f.url().includes(base));
      await frame.waitForFunction(
        () => window.ready || window.cacheStatus?.state === "error",
        { timeout: 60000 },
      );
      assert.deepEqual(errors, []);
      assert.equal(
        await frame.evaluate(
          () => window.project.singleton === window.singleton,
        ),
        true,
        "cache imports retain already loaded singleton modules",
      );
      const cached = await frame.evaluate(() => cache.state());
      assert.equal(cached.state, "ready");
      assert.equal(cached.persistentFiles, cached.totalFiles);
      assert.equal(cached.remaining.length, 0);
      await page.route("**/preview-live/**", (route) =>
        route.request().url().includes("manifest.json")
          ? route.continue()
          : route.abort(),
      );
      const result = await frame.evaluate(
        async ({ base, font }) => {
          const blobUrl = window.__FRAME_PREVIEW_ASSET_URL__(
            new URL("films/cache-film/voice.wav", location.href).href,
          );
          const range = await fetch(
            new URL("films/cache-film/voice.wav", location.href),
            { headers: { Range: "bytes=0-3" } },
          );
          const image = new Image();
          image.src = window.project.picture;
          await image.decode();
          const context = new AudioContext({ sampleRate: 48000 });
          const audio = await context.decodeAudioData(
            await (await fetch(blobUrl)).arrayBuffer(),
          );
          const wasm = await WebAssembly.compile(
            await (
              await fetch(new URL("vendor/cache/test.wasm", location.href))
            ).arrayBuffer(),
          );
          const worker = window.__FRAME_PREVIEW_WORKER__(
            new URL("assets/worker.js", location.href),
          );
          const workerBytes = await new Promise((resolve, reject) => {
            worker.onmessage = (e) => resolve(e.data);
            worker.onerror = (e) => reject(Error(e.message));
            worker.postMessage("go");
          });
          worker.terminate();
          await context.audioWorklet.addModule(
            new URL("assets/worklet.js", location.href),
          );
          const node = new AudioWorkletNode(context, "frame-cache-quiet");
          node.disconnect();
          if (font) {
            const face = new FontFace(
              "cache-font",
              "url(" +
                window.__FRAME_PREVIEW_ASSET_URL__(
                  new URL("fonts/" + font, location.href).href,
                ) +
                ")",
            );
            await face.load();
          }
          await context.close();
          return {
            range: range.status,
            bytes: await range.text(),
            width: image.width,
            audioFrames: audio.length,
            workerBytes,
            wasm: !!wasm,
          };
        },
        { base, font },
      );
      assert.equal(result.range, 206);
      assert.equal(result.bytes, "RIFF");
      assert.equal(result.width, 32);
      assert.equal(result.audioFrames, 4800);
      assert.equal(result.workerBytes, wav().length);
      assert.equal(result.wasm, true);
      await page.unroute("**/preview-live/**");
      const before = new Map(counts);
      files.set(
        "assets/project-v2.js",
        Buffer.from(
          "import {singleton} from './shared.js';export {singleton};export const version=2;export const empty=``;export const load=()=>import(`./shared.js`);export const computed=name=>import(`./${name}.js`);",
        ),
      );
      files.set(
        "films/cache-film/picture.png",
        await sharp({
          create: { width: 40, height: 24, channels: 4, background: "#8058aa" },
        })
          .png()
          .toBuffer(),
      );
      revision = 2;
      await frame.evaluate(async () => {
        await cache.prepare(
          await (await fetch("manifest.json")).json(),
          new AbortController().signal,
        );
        window.project = await import(
          new URL("assets/project-v2.js", location.href)
        );
        cache.committed();
      });
      assert.equal(await frame.evaluate(() => project.version), 2);
      assert.equal(
        await frame.evaluate(
          async () => (await project.load()).singleton === singleton,
        ),
        true,
        "static template import paths retain their source base",
      );
      assert.equal(
        await frame.evaluate(
          async () =>
            (await project.computed("shared")).singleton === singleton,
        ),
        true,
        "computed import paths resolve against original module",
      );
      assert.equal(
        counts.get("films/cache-film/voice.wav"),
        before.get("films/cache-film/voice.wav"),
        "unchanged audio reused by SHA",
      );
      assert.equal(
        counts.get("films/cache-film/bank.sf2"),
        before.get("films/cache-film/bank.sf2"),
        "unchanged soundbank reused",
      );
      assert.ok(
        counts.get("films/cache-film/picture.png") >
          before.get("films/cache-film/picture.png"),
        "updated asset downloaded before commit",
      );
      await page.route("**/preview-live/**", (route) =>
        route.request().url().includes("manifest.json")
          ? route.continue()
          : route.abort(),
      );
      const width = await frame.evaluate(async () => {
        const img = new Image();
        img.src = window.__FRAME_PREVIEW_ASSET_URL__(
          new URL("films/cache-film/picture.png", location.href).href,
        );
        await img.decode();
        return img.width;
      });
      assert.equal(width, 40);
      assert.deepEqual(errors, []);
      let settledUrls;
      for (revision = 3; revision <= 9; revision++) {
        await frame.evaluate(async () => {
          await cache.prepare(
            await (await fetch("manifest.json")).json(),
            new AbortController().signal,
          );
          cache.committed();
        });
        const urls = await frame.evaluate(() => cacheURLs.size);
        if (revision === 7) settledUrls = urls;
        if (revision === 9)
          assert.equal(
            urls,
            settledUrls,
            "unchanged revisions reuse module and worker Blob URLs",
          );
      }
      await page.evaluate(async () => {
        const cache = await caches.open("unrelated-project-cache");
        await cache.put("/unrelated-resource", new Response("keep"));
      });
      await frame.evaluate(() => cache.clear());
      assert.equal(
        await page.evaluate(async () =>
          (
            await (
              await caches.open("unrelated-project-cache")
            ).match("/unrelated-resource")
          ).text(),
        ),
        "keep",
        "clear is scoped to this work",
      );
      assert.equal(
        await frame.evaluate(async () => {
          const image = new Image();
          image.src = new URL(
            "films/cache-film/picture.png",
            location.href,
          ).href;
          await image.decode();
          return image.width;
        }),
        40,
        "native image property remains backed by live Blob after durable clear",
      );
      const leaving = await frame.evaluate(async () => {
        cache.setMode("cached");
        const waiting = cache.waitReady(10000).then(
          () => null,
          (error) => error.message,
        );
        cache.setMode("original");
        return await waiting;
      });
      assert.match(leaving, /已离开/);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await vite.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  },
);
