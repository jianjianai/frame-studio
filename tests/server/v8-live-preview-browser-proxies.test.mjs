import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import sharp from "sharp";
import { LivePreviewSessions } from "../../server/live-preview.mjs";
import { installLivePreview } from "../../server/live-preview-routes.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { repo as root } from "../mcp/helpers.mjs";

const meta = {
  id: "test-film",
  title: "Preview proxies",
  subtitle: "",
  description: "",
  renderer: "canvas",
  duration: 8,
  fps: 24,
  accent: "#123456",
  poster: "films/test-film/image.png",
  tags: [],
  status: "draft",
  beats: [],
  subtitles: [],
  credits: [],
  composition: { width: 720, height: 360 },
};
const scene = `import {assetUrl,previewAssetUrl} from '../../src/engine/types';
import {openImageSource,videoSourceDiagnostics} from '../../src/engine/media-source';
export function createScene({width,height}){const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return{canvas,render(){canvas.getContext('2d').fillRect(0,0,width,height);},dispose(){canvas.width=canvas.height=1;}};}
export function probe(){const raw='films/test-film/source.mp4',image='films/test-film/image.png',pinned=assetUrl(raw);return{
  pinned,absolute:new URL(pinned,location.href).href,
  video:{economy:previewAssetUrl(raw,'draft'),standard:previewAssetUrl(raw,'standard'),high:previewAssetUrl(raw,'high'),pinned:previewAssetUrl(pinned,'standard'),absolute:previewAssetUrl(new URL(pinned,location.href).href,'standard')},
  image:{economy:previewAssetUrl(image,'draft'),standard:previewAssetUrl(image,'standard'),high:previewAssetUrl(image,'high')},
  svg:previewAssetUrl('films/test-film/vector.svg','draft'),animated:previewAssetUrl('films/test-film/animated.webp','draft')};}
async function waitForWorker(worker){try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Worker asset probe timed out')),12000);worker.onmessage=event=>{clearTimeout(timer);resolve(event.data);};worker.onerror=event=>{clearTimeout(timer);reject(Error(event.message));};});}finally{worker.terminate();}}
export function workerProbe(){return waitForWorker(new Worker(new URL('./asset-worker.ts',import.meta.url),{name:'frozen-assets'}));}
export function moduleWorkerProbe(){return waitForWorker(new Worker(new URL('./asset-worker.ts',import.meta.url),{type:'module',name:'frozen-module-assets'}));}
export async function imageFrame(quality){const bitmap=await openImageSource(assetUrl('films/test-film/image.png'),undefined,320,180,quality);const result={width:bitmap.width,height:bitmap.height,bytes:videoSourceDiagnostics().images.bitmapBytes};bitmap.close();result.released=videoSourceDiagnostics().images.bitmapBytes;return result;}
`;
function ffprobe(file) {
  return JSON.parse(
    execFileSync(
      process.env.FFPROBE_PATH || "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,width,height,r_frame_rate:format=duration",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8", timeout: 15000 },
    ),
  );
}

test(
  "V8 real frozen bundle chooses reusable economy/standard video and static image proxies and normalizes pinned source URLs",
  { timeout: 180000 },
  async (t) => {
    const owned = path.join(root, ".cache/v8-proxy-browser", randomUUID()),
      data = path.join(owned, "data"),
      projectDir = path.join(owned, "projects/test-film");
    await fsp.mkdir(path.join(projectDir, "public"), { recursive: true });
    await fsp.writeFile(
      path.join(projectDir, "project.ts"),
      "export default " +
        JSON.stringify(meta).slice(0, -1) +
        ',load:()=>import("./scene")};',
    );
    await fsp.writeFile(path.join(projectDir, "scene.ts"), scene);
    await fsp.writeFile(path.join(projectDir, "asset-worker.ts"),
      "import {assetUrl,previewAssetUrl} from '../../src/engine/types';" +
      "const raw='films/test-film/source.mp4',pinned=assetUrl(raw),proxy=previewAssetUrl(pinned,'standard');" +
      "Promise.all([pinned,proxy].map(async url=>{const response=await fetch(url,{headers:{Range:'bytes=0-127'}});return{url,status:response.status,bytes:(await response.arrayBuffer()).byteLength};})).then(fetches=>self.postMessage({pinned,proxy,fetches,name:self.name})).catch(error=>{throw error;});");
    await fsp.writeFile(
      path.join(projectDir, "public/vector.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><path d="M0 0H100V50H0Z" fill="red"/></svg>',
    );
    const movie = path.join(projectDir, "public/source.mp4"),
      image = path.join(projectDir, "public/image.png");
    execFileSync(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=720x360:rate=12:duration=8",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-b:v",
        "1500k",
        "-maxrate",
        "1500k",
        "-bufsize",
        "3000k",
        "-g",
        "12",
        "-movflags",
        "+faststart",
        "-an",
        "-y",
        movie,
      ],
      { timeout: 45000 },
    );
    execFileSync(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=720x360:rate=8:duration=2",
        "-c:v",
        "libwebp_anim",
        "-lossless",
        "1",
        "-loop",
        "0",
        "-y",
        path.join(projectDir, "public/animated.webp"),
      ],
      { timeout: 30000 },
    );
    await sharp(randomBytes(1800 * 1200 * 4), {
      raw: { width: 1800, height: 1200, channels: 4 },
    })
      .png()
      .toFile(image);
    const work = {
      id: randomUUID(),
      repo: randomUUID(),
      project: "test-film",
      deleted: false,
    };
    const manager = new LivePreviewSessions({
      data,
      root,
      db: { one: async () => ({ deleted: false }) },
      repos: { project: async () => ({ dir: projectDir }) },
    });
    const app = Fastify();
    installLivePreview(app, manager);
    let browser;
    try {
      const link = await manager.start({ work }),
        session = manager.sessions.get(link.sessionId);
      await manager.ready(session);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const origin = "http://127.0.0.1:" + app.server.address().port,
        base = link.url.slice(0, -"index.html".length);
      browser = await launchBrowser();
      const page = await browser.newPage();
      const requested = [];
      page.on("request", request => requested.push(request.url()));
      page.setDefaultTimeout(45000);
      await page.goto(origin + link.url);
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const result = await page.evaluate(async () => {
        const config = window.__FRAME_LIVE_PREVIEW__,
          manifest = await (await fetch(config.manifestUrl)).json();
        const module = await import(
            new URL(manifest.projectUrl, location.href).href
          ),
          loaded = await module.default.load();
        return loaded.probe();
      });
      const videoHash =
          session.manifest.assetRevisions["films/test-film/source.mp4"],
        imageHash =
          session.manifest.assetRevisions["films/test-film/image.png"];
      assert.match(
        result.video.economy,
        new RegExp("video/" + videoHash + "/economy$"),
      );
      assert.match(
        result.video.standard,
        new RegExp("video/" + videoHash + "/preview$"),
      );
      assert.equal(
        result.video.pinned,
        result.video.standard,
        "already-pinned assetUrl values select the same proxy",
      );
      assert.equal(
        result.video.absolute,
        result.video.standard,
        "resolved absolute asset URLs preserve the frozen proxy revision",
      );
      assert.match(
        result.video.high,
        new RegExp("films/test-film/source\\.mp4\\?v=" + videoHash + "$"),
      );
      assert.match(
        result.image.economy,
        new RegExp("image/" + imageHash + "/economy$"),
      );
      assert.match(
        result.image.standard,
        new RegExp("image/" + imageHash + "/preview$"),
      );
      assert.match(
        result.svg,
        /vector\.svg\?v=/,
        "SVG retains its original rendering semantics",
      );
      assert.match(
        result.animated,
        /animated\.webp\?v=/,
        "animated WebP retains original pages and timing",
      );
      let converted = 0;
      const convert = manager.media.transcode;
      manager.media.transcode = (...args) => {
        converted++;
        return convert(...args);
      };
      const profiles = {};
      for (const kind of ["video", "image"])
        for (const profile of ["economy", "preview"]) {
          const url =
            base +
            kind +
            "/" +
            (kind === "video" ? videoHash : imageHash) +
            "/" +
            profile;
          const first = await app.inject({
            url,
            headers: { range: "bytes=0-127" },
          });
          assert.equal(first.statusCode, 206, first.body);
          assert.equal(first.rawPayload.length, 128);
          assert.match(first.headers["cache-control"], /immutable/);
          const asset = session.assets.get(
              kind === "video" ? videoHash : imageHash,
            ),
            file = await manager.media.rendition(session, asset, profile, kind);
          profiles[kind + "-" + profile] = {
            bytes: fs.statSync(file).size,
            ...(kind === "video"
              ? ffprobe(file)
              : await sharp(file).metadata()),
          };
          const again = await app.inject({
            url,
            headers: { range: "bytes=64-127" },
          });
          assert.equal(again.statusCode, 206);
          assert.equal(again.rawPayload.length, 64);
        }
      assert.equal(
        converted,
        4,
        "each content/profile is converted once and reused by Range seeks",
      );
      assert.ok(profiles["video-economy"].streams[0].width <= 320);
      assert.ok(profiles["video-preview"].streams[0].width <= 640);
      assert.equal(profiles["video-preview"].streams[0].codec_name, "h264");
      assert.ok(profiles["video-economy"].bytes < fs.statSync(movie).size);
      assert.ok(profiles["video-preview"].bytes < fs.statSync(movie).size);
      assert.ok(profiles["image-economy"].width <= 480);
      assert.ok(profiles["image-preview"].width <= 1280);
      assert.equal(profiles["image-preview"].hasAlpha, true);
      assert.ok(profiles["image-economy"].bytes < fs.statSync(image).size);
      assert.ok(profiles["image-preview"].bytes < fs.statSync(image).size);
      const workerResult = await page.evaluate(async () => {
        const manifest = await (await fetch(window.__FRAME_LIVE_PREVIEW__.manifestUrl)).json();
        const module = await import(new URL(manifest.projectUrl, location.href).href);
        return (await module.default.load()).workerProbe();
      });
      assert.equal(workerResult.name, "frozen-assets", "authored worker options must retain their name");
      const nativeModule = await page.evaluate(async () => {
        const url = URL.createObjectURL(new Blob(["self.postMessage('module-ready');"], { type: "application/javascript" }));
        const worker = new Worker(url, { type: "module" });
        try {
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error("Native module Worker probe timed out")), 5000);
            worker.onmessage = () => { clearTimeout(timer); resolve({ supported: true, origin: window.origin }); };
            worker.onerror = () => { clearTimeout(timer); resolve({ supported: false, origin: window.origin }); };
          });
        } finally { worker.terminate(); URL.revokeObjectURL(url); }
      });
      assert.deepEqual(nativeModule, { supported: false, origin: "null" },
        "the supported opaque Chromium sandbox must demonstrate its native module Worker restriction");
      await assert.rejects(page.evaluate(async () => {
        const manifest = await (await fetch(window.__FRAME_LIVE_PREVIEW__.manifestUrl)).json();
        const module = await import(new URL(manifest.projectUrl, location.href).href);
        return (await module.default.load()).moduleWorkerProbe();
      }), /Opaque live preview supports classic bundled workers/,
      "module worker requests must report the opaque sandbox limitation explicitly");
      assert.equal(workerResult.pinned, result.pinned, "worker assetUrl must use the frozen session root and media revision");
      assert.equal(workerResult.proxy, result.video.standard, "worker media proxies must preserve the same frozen content hash");
      assert.ok(workerResult.fetches.every(item => item.status === 206 && item.bytes === 128),
        "bundled browser workers must actually fetch both frozen original media and the lazy reusable proxy");
      const frames = await page.evaluate(async () => {
        const manifest = await (
          await fetch(window.__FRAME_LIVE_PREVIEW__.manifestUrl)
        ).json();
        const module = await import(
            new URL(manifest.projectUrl, location.href).href
          ),
          loaded = await module.default.load();
        return [
          await loaded.imageFrame("standard"),
          await loaded.imageFrame("draft"),
        ];
      });
      assert.ok(
        frames.every(
          (frame) =>
            frame.width === 270 &&
            frame.height === 180 &&
            frame.bytes > 0 &&
            frame.released === 0,
        ),
        "native image bitmaps resize to the scene and release their owner reservation",
      );
      assert.ok(!requested.some(url => /vendor-(?:babylon|pixi|lottie|remotion|tone|spessasynth)-/.test(url)),
        "a canvas/media project must not download unused renderer or music framework vendors: " + JSON.stringify(requested));
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 600,
        downloadThroughput: 96 * 1024,
        uploadThroughput: 48 * 1024,
        connectionType: "cellular3g",
      });
      const bytes = await page.evaluate(
        async (urls) => {
          const results = [];
          for (const url of urls) {
            const response = await fetch(url, {
              headers: { Range: "bytes=0-127" },
            });
            results.push({
              status: response.status,
              bytes: (await response.arrayBuffer()).byteLength,
            });
          }
          return results;
        },
        [
          base + "video/" + videoHash + "/economy",
          base + "video/" + videoHash + "/preview",
          base + "image/" + imageHash + "/economy",
        ],
      );
      assert.ok(
        bytes.every((item) => item.status === 206 && item.bytes === 128),
      );
      t.diagnostic(
        JSON.stringify({
          originalVideoBytes: fs.statSync(movie).size,
          originalImageBytes: fs.statSync(image).size,
          converted,
          profiles: Object.fromEntries(
            Object.entries(profiles).map(([key, value]) => [
              key,
              {
                bytes: value.bytes,
                width: value.width || value.streams?.[0]?.width,
                height: value.height || value.streams?.[0]?.height,
              },
            ]),
          ),
        }),
      );
    } finally {
      await browser?.close();
      await app.close();
      await manager.close();
      await fsp.rm(owned, { recursive: true, force: true });
    }
  },
);
