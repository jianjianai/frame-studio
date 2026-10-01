import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createServer } from "vite";
import { launchBrowser } from "../../scripts/browser.mjs";

const root = path.resolve("."),
  base = "/preview-live/pixi-cache-fixture/";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test(
  "cached preview retains semantic URLs for Pixi worker/main/image loaders and native resources",
  { timeout: 120000 },
  async (t) => {
    const owned = path.join(root, ".cache/pixi-cache", randomUUID());
    await fs.mkdir(owned, { recursive: true });
    const files = new Map();
    for (const name of ["first", "second", "third"])
      files.set(
        `films/pixi/${name}.png`,
        await sharp({
          create: { width: 8, height: 8, channels: 4, background: "#ff0000" },
        })
          .png()
          .toBuffer(),
      );
    files.set(
      "films/pixi/vector.svg",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><view id="whole" viewBox="0 0 8 8"/><rect width="8" height="8" fill="red"/></svg>',
      ),
    );
    files.set(
      "vendor/pixi/test.wasm",
      Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    let font;
    try {
      font = (await fs.readdir(path.join(root, "public/fonts"))).find((name) =>
        /\.woff2?$/.test(name),
      );
      if (font)
        files.set(
          "fonts/" + font,
          await fs.readFile(path.join(root, "public/fonts", font)),
        );
    } catch {}
    const manifest = {
      revision: 1,
      resources: [...files].map(([name, bytes]) => ({
        path: name,
        url: base + name + "?v=" + hash(bytes),
        originalUrl: base + name + "?v=" + hash(bytes),
        sha256: hash(bytes),
        bytes: bytes.length,
        type: name.endsWith(".png")
          ? "image/png"
          : name.endsWith(".svg")
            ? "image/svg+xml"
            : name.endsWith(".wasm")
              ? "application/wasm"
              : "font/woff2",
      })),
    };
    const entry = `import {Assets,Sprite,WorkerManager,loadTextures} from 'pixi.js';
import {createLivePreviewCache} from '/src/engine/live-preview-cache.ts';
const cache=window.cache=createLivePreviewCache(s=>window.cacheStatus=s);cache.setMode('original');
window.resolve=path=>window.__FRAME_PREVIEW_ASSET_URL__(new URL(path,location.href).href);
window.pixels=async(path)=>{const texture=await Assets.load(resolve(path));const sprite=new Sprite(texture);const canvas=document.createElement('canvas');canvas.width=canvas.height=8;const ctx=canvas.getContext('2d');ctx.drawImage(texture.source.resource,0,0);return {width:sprite.width,height:sprite.height,pixel:[...ctx.getImageData(0,0,1,1).data],resource:texture.source.resource.constructor.name}};
window.original=await pixels('films/pixi/first.png');window.workerCount=WorkerManager._createdWorkers;
window.prepare=async()=>{cache.setMode('cached');await cache.prepare(await(await fetch('manifest.json')).json(),new AbortController().signal);cache.committed();};
window.workerPixels=path=>{loadTextures.config.preferWorkers=true;loadTextures.config.preferCreateImageBitmap=true;return pixels(path)};
window.mainPixels=async(path)=>{loadTextures.config.preferWorkers=false;return pixels(path)};
window.imagePixels=async(path)=>{loadTextures.config.preferCreateImageBitmap=false;return pixels(path)};
window.moduleWorker=async(type="classic")=>{const source=URL.createObjectURL(new Blob([(type==="module"?"await new Promise(r=>setTimeout(r,50));":"")+"self.onmessage=async e=>{const r=await fetch(new Request(e.data,{headers:{Range:'bytes=0-3'}}));postMessage({status:r.status,bytes:[...new Uint8Array(await r.arrayBuffer())]})}"],{type:'application/javascript'}));const worker=new Worker(source,{type});try{return await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=e=>reject(Error(JSON.stringify({message:e.message,filename:e.filename,lineno:e.lineno,error:String(e.error)})));worker.postMessage(new URL('vendor/pixi/test.wasm#fragment',location.href).href)})}finally{worker.terminate();URL.revokeObjectURL(source)}};
window.cleanup=()=>{WorkerManager.reset();cache.dispose()};window.ready=true;`;
    await fs.writeFile(path.join(owned, "entry.js"), entry);
    const child = `<script type="module" src="/${path.relative(root, path.join(owned, "entry.js")).replaceAll(path.sep, "/")}"></script>`;
    const parent = `<iframe id="preview" sandbox="allow-scripts" src="${base}index.html"></iframe><script type="module">import{previewCacheBridge}from'/studio/preview-cache.js';window.release=previewCacheBridge({current:document.getElementById('preview')},'${base}index.html');</script>`;
    const vite = await createServer({
      configFile: false,
      root,
      cacheDir: path.join(owned, "vite-cache"),
      optimizeDeps: { include: ["pixi.js"], entries: [] },
      server: {
        host: "127.0.0.1",
        port: 0,
        cors: true,
        fs: {
          allow: [root, await fs.realpath(path.join(root, "node_modules"))],
        },
        watch: { ignored: ["**/.cache/**"] },
      },
      plugins: [
        {
          name: "pixi-cache-fixture",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              const url = new URL(req.url, "http://localhost");
              if (url.pathname === "/pixi-parent") {
                res.setHeader("Content-Type", "text/html");
                res.end(parent);
                return;
              }
              if (!url.pathname.startsWith(base)) return next();
              res.setHeader("Access-Control-Allow-Origin", "*");
              const key = url.pathname.slice(base.length);
              if (key === "index.html" || key === "trusted.html") {
                res.setHeader("Content-Type", "text/html");
                if (key === "index.html")
                  res.setHeader(
                    "Content-Security-Policy",
                    "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; connect-src 'self' blob: data:; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self' blob:; worker-src 'self' blob:; style-src 'unsafe-inline'",
                  );
                res.end(child);
                return;
              }
              if (key === "manifest.json") {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(manifest));
                return;
              }
              const bytes = files.get(key);
              if (!bytes) {
                res.statusCode = 404;
                res.end();
                return;
              }
              res.setHeader(
                "Content-Type",
                manifest.resources.find((r) => r.path === key).type,
              );
              res.end(bytes);
            });
          },
        },
      ],
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      await vite.close();
      await fs.rm(owned, { recursive: true, force: true });
    });
    await vite.listen();
    browser = await launchBrowser();
    const context = await browser.newContext(),
      page = await context.newPage(),
      errors = [],
      blocked = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.log("PAGE ERROR", error.message);
    });

    await page.goto(
      "http://127.0.0.1:" + vite.httpServer.address().port + "/pixi-parent",
    );
    const frame = page.frames().find((frame) => frame.url().includes(base));
    await frame.waitForFunction(() => window.ready, undefined, {
      timeout: 60000,
    });
    assert.deepEqual(
      await frame.evaluate(() => original.pixel),
      [255, 0, 0, 255],
    );
    assert.ok(
      await frame.evaluate(() => workerCount > 0),
      "original mode actually creates Pixi's worker pool",
    );
    await frame.evaluate(() => prepare());
    await context.route("**/preview-live/**", (route) => {
      blocked.push(route.request().url());
      return route.abort();
    });
    const second = manifest.resources.find((r) =>
      r.path.endsWith("second.png"),
    );
    const semantic = await frame.evaluate(
      (url) => resolve(url),
      second.url + "#texture",
    );
    assert.equal(new URL(semantic).pathname, second.url.split("?")[0]);
    assert.equal(
      new URL(semantic).search,
      new URL(second.url, "http://localhost").search,
    );
    assert.equal(new URL(semantic).hash, "#texture");
    const worker = await frame.evaluate(
      (url) => workerPixels(url),
      second.url + "#texture",
    );
    const main = await frame.evaluate(
      (url) => mainPixels(url),
      second.url + "#main",
    );
    const htmlImage = await frame.evaluate(
      (url) => imagePixels(url),
      second.url + "#html",
    );
    for (const result of [worker, main, htmlImage]) {
      assert.equal(result.width, 8);
      assert.equal(result.height, 8);
      assert.deepEqual(result.pixel, [255, 0, 0, 255]);
    }
    assert.equal(worker.resource, "ImageBitmap");
    assert.equal(main.resource, "ImageBitmap");
    assert.equal(htmlImage.resource, "HTMLImageElement");
    assert.deepEqual(await frame.evaluate(() => moduleWorker()), {
      status: 206,
      bytes: [0, 97, 115, 109],
    });
    const native = await frame.evaluate(async (font) => {
      const element = document.createElement("div");
      element.style.backgroundImage =
        'url("' + resolve("films/pixi/third.png#background") + '")';
      document.body.append(element);
      const background = element.style.backgroundImage;
      const wasm = await WebAssembly.compile(
        await (
          await fetch(resolve("vendor/pixi/test.wasm#wasm"))
        ).arrayBuffer(),
      );
      let fontStatus;
      if (font) {
        const face = new FontFace(
          "cache-font",
          'url("' + resolve("fonts/" + font) + '")',
        );
        await face.load();
        fontStatus = face.status;
      }
      element.remove();
      return { background, wasm: !!wasm, fontStatus };
    }, font);
    const svg = await frame.evaluate(async () => {
      const ns = "http://www.w3.org/2000/svg",
        svg = document.createElementNS(ns, "svg");
      svg.id = "cached-vector";
      svg.setAttribute("width", "8");
      svg.setAttribute("height", "8");
      const image = document.createElementNS(ns, "image");
      image.setAttribute("width", "8");
      image.setAttribute("height", "8");
      const ready = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(Error("cached SVG did not load"));
      });
      image.setAttribute("href", window.resolve("films/pixi/vector.svg#whole"));
      svg.append(image);
      document.body.append(svg);
      await ready;
      const first = image.href.baseVal;
      const readyAgain = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(Error("cached SVG baseVal did not load"));
      });
      image.href.baseVal = window.resolve("films/pixi/vector.svg#whole");
      await readyAgain;
      return { first, second: image.href.baseVal };
    });
    assert.match(svg.first, /^blob:.*#whole$/);
    assert.match(svg.second, /^blob:.*#whole$/);
    const vector = await sharp(
      await frame.locator("#cached-vector").screenshot(),
    )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const center = (Math.floor(vector.info.height / 2) * vector.info.width + Math.floor(vector.info.width / 2)) * 4;
    assert.deepEqual([...vector.data.subarray(center, center + 4)], [255, 0, 0, 255], JSON.stringify({ width: vector.info.width, height: vector.info.height, pixels: [...vector.data] }));
    assert.match(native.background, /blob:/);
    assert.equal(native.wasm, true);
    if (font) assert.equal(native.fontStatus, "loaded");
    const oldSemantic = await frame.evaluate(() =>
      resolve("films/pixi/second.png"),
    );
    assert.deepEqual(
      (await frame.evaluate((url) => workerPixels(url), oldSemantic)).pixel,
      [255, 0, 0, 255],
    );
    await context.unroute("**/preview-live/**");
    const green = await sharp({
      create: { width: 8, height: 8, channels: 4, background: "#00ff00" },
    })
      .png()
      .toBuffer();
    files.set("films/pixi/second.png", green);
    manifest.revision++;
    const updated = manifest.resources.find((resource) =>
      resource.path.endsWith("second.png"),
    );
    Object.assign(updated, {
      url: base + updated.path + "?v=" + hash(green),
      originalUrl: base + updated.path + "?v=" + hash(green),
      sha256: hash(green),
      bytes: green.length,
    });
    await frame.evaluate(() => prepare());
    await context.route("**/preview-live/**", (route) => {
      blocked.push(route.request().url());
      return route.abort();
    });
    const newSemantic = await frame.evaluate(() =>
      resolve("films/pixi/second.png"),
    );
    assert.notEqual(
      newSemantic,
      oldSemantic,
      "new resource content changes the SDK's own asset cache key",
    );
    assert.equal(new URL(newSemantic).pathname, new URL(oldSemantic).pathname);
    assert.deepEqual(
      (await frame.evaluate((url) => workerPixels(url), newSemantic)).pixel,
      [0, 255, 0, 255],
    );
    assert.deepEqual(
      (await frame.evaluate((url) => workerPixels(url), oldSemantic)).pixel,
      [255, 0, 0, 255],
      "previous accepted texture remains valid",
    );
    // Chromium blocks module Blob workers in an opaque sandbox even without this
    // adapter; exercise their queue/Range bridge in a trusted standalone preview.
    const trustedContext = await browser.newContext();
    const trustedPage = await trustedContext.newPage();
    await trustedPage.goto(
      "http://127.0.0.1:" +
        vite.httpServer.address().port +
        base +
        "trusted.html",
    );
    await trustedPage.waitForFunction(() => window.ready);
    await trustedPage.evaluate(() => prepare());
    const trustedBlocked = [];
    await trustedContext.route("**/preview-live/**", (route) => {
      trustedBlocked.push(route.request().url());
      return route.abort();
    });
    assert.deepEqual(await trustedPage.evaluate(() => moduleWorker("module")), {
      status: 206,
      bytes: [0, 97, 115, 109],
    });
    await trustedPage.evaluate(() => cleanup());
    await trustedContext.close();
    assert.deepEqual(trustedBlocked, []);
    await frame.evaluate(() => cleanup());
    assert.deepEqual(
      blocked,
      [],
      "all cached resource consumers avoid HTTP, including pre-existing Pixi workers",
    );
    assert.deepEqual(errors, []);
  },
);
