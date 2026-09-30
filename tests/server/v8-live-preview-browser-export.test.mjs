import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import sharp from "sharp";
import { launchBrowser } from "../../scripts/browser.mjs";

function mediaBinary(tool) {
  const configured = process.env[tool.toUpperCase() + "_PATH"];
  if (configured) return configured;
  if (spawnSync(tool, ["-version"], { stdio: "ignore" }).status === 0) return tool;
  if (process.platform === "linux" && process.arch === "x64") {
    const require = createRequire(import.meta.url);
    const packageFile = require.resolve("@remotion/compositor-linux-x64-gnu/package.json", { paths: [path.dirname(require.resolve("@remotion/renderer"))] });
    return path.join(path.dirname(packageFile), tool);
  }
  return tool;
}
const digest = value => createHash("sha256").update(value).digest("hex");
function wave(frequency) {
  const frames = 96000, bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(Math.sin(i * frequency * 2 * Math.PI / 48000) * 11000), 44 + i * 2);
  return bytes;
}
function wavPcm(bytes) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    if (kind === "data") {
      const count = Math.floor(Math.min(size, bytes.length - offset - 8) / 2), pcm = Buffer.alloc(count * 4);
      for (let i = 0; i < count; i++) pcm.writeFloatLE(bytes.readInt16LE(offset + 8 + i * 2) / 32768, i * 4);
      return pcm;
    }
    offset += 8 + size + size % 2;
  }
  throw Error("Decoded WAV has no PCM data");
}
function amplitude(pcm, frequency) {
  let sine = 0, cosine = 0;
  for (let i = 0; i < pcm.length / 4; i++) {
    const sample = pcm.readFloatLE(i * 4), phase = i * frequency * 2 * Math.PI / 48000;
    sine += sample * Math.sin(phase); cosine += sample * Math.cos(phase);
  }
  return Math.hypot(sine, cosine) / (pcm.length / 4);
}
const colors = ["#b91c1c", "#1d4ed8", "#15803d"];
const imageColors = ["#ffffff", "#dc2626", "#1122ff"];
function fixtureVersion(revision) {
  const color = colors[revision - 1];
  const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="' + imageColors[revision - 1] + '"/></svg>';
  const original = wave([440, 880, 1760][revision - 1]), preview = wave(1320);
  const originalHash = digest(original), pictureHash = digest(picture);
  const mediaBase = "/__v8-export/media/";
  const originalUrl = mediaBase + "original-" + originalHash + ".wav";
  const previewUrl = mediaBase + "preview-" + digest(preview) + ".wav";
  const pictureUrl = mediaBase + "picture-" + pictureHash + ".svg";
  const code = `
const version = ${revision}, pictureUrl = ${JSON.stringify(pictureUrl)}, fill = ${JSON.stringify(color)};
(window.__V8_IMPORTED_VERSIONS__ ||= []).push(version);
async function createScene({width,height,quality}) {
  const image = new Image();
  await new Promise((resolve,reject) => { image.onload=resolve; image.onerror=()=>reject(Error("Immutable fixture image failed")); image.src=pictureUrl; });
  const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext("2d");
  return {
    canvas,
    async render(time) {
      if(quality==="high") await new Promise(resolve=>setTimeout(resolve,180));
      ctx.fillStyle=fill;ctx.fillRect(0,0,width,height);ctx.drawImage(image,0,0,48,48);
    },
    dispose(){canvas.width=canvas.height=1;},
    debug:{parameters:()=>({}),setParameters(){},diagnostics:()=>({sourceVersion:version,pictureUrl})}
  };
}
export default {
  id:"export-freeze",title:"Frozen version "+version,subtitle:"",description:"",
  renderer:"canvas",duration:2,fps:12,composition:{width:320,height:180},
  accent:"#fff",poster:"",tags:[],status:"draft",beats:[],subtitles:[],credits:[],
  audioTracks:[{id:"music",name:"Immutable source",kind:"file",src:"films/export-freeze/music.wav",gain:1}],
  load:async()=>({createScene})
};`;
  return {
    revision, code, original, preview, picture, originalUrl, previewUrl, pictureUrl,
    manifest: {
      schemaVersion: 1, sessionId: "export-freeze-session", revision,
      sourceRevision: digest("source-" + revision), source: "work",
      projectUrl: "assets/project-" + digest(code) + ".js",
      changes: { visual: true, audio: true, metadata: true },
      fingerprints: { visual: digest(code), audio: originalHash, metadata: digest("metadata-" + revision) },
      createdAt: new Date().toISOString(), buildMs: 1, assetsRevision: digest(originalHash + pictureHash),
      assetRevisions: { "films/export-freeze/music.wav": originalHash, "films/export-freeze/picture.svg": pictureHash },
      audioSources: { "films/export-freeze/music.wav": {
        revision: originalHash, url: previewUrl, originalUrl, renditions: { preview: previewUrl, economy: previewUrl },
      } },
    },
  };
}
function pixel(frame, x, y) { const offset = (y * 320 + x) * 3; return [...frame.subarray(offset, offset + 3)]; }
function near(actual, expected, tolerance = 10) {
  assert(actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance), "Unexpected pixel " + actual + ", expected " + expected);
}

test("V8 browser export freezes accepted code, original audio and media through consecutive live revisions, then applies the newest source", { timeout: 90000 }, async () => {
  const versions = [1, 2, 3].map(fixtureVersion), clients = new Set(), requests = [];
  let current = versions[0], browser;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-v8-export-"));
  const server = await createServer({
    configFile: false, root: process.cwd(), cacheDir: path.join(outputDir, "vite"), appType: "custom", logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "lucide-react", "zod", "mediabunny"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    plugins: [react(), {
      name: "v8-export-fixture",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const url = req.url?.split("?")[0];
          if (!url?.startsWith("/__v8-export/")) { next(); return; }
          requests.push(url);
          if (url === "/__v8-export/index.html") {
            res.setHeader("Content-Type", "text/html");
            const config = JSON.stringify({ sessionId: "export-freeze-session", manifestUrl: "manifest.json", eventsUrl: "events" });
            void vite.transformIndexHtml(url, '<!doctype html><html><body><div id="root"></div><script>window.__FRAME_LIVE_PREVIEW__=' + config + ';</script><script type="module" src="/src/live-preview.tsx"></script></body></html>').then(html => res.end(html), next);
          } else if (url === "/__v8-export/manifest.json") {
            res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(current.manifest));
          } else if (url === "/__v8-export/events") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            res.write("retry: 1000\n\nevent: revision\ndata: " + JSON.stringify(current.manifest) + "\n\n");
            clients.add(res); req.on("close", () => clients.delete(res));
          } else {
            for (const version of versions) {
              if (url === "/__v8-export/" + version.manifest.projectUrl) {
                res.setHeader("Content-Type", "text/javascript"); res.end(version.code); return;
              }
              for (const [source, type, bytes] of [
                [version.originalUrl, "audio/wav", version.original], [version.previewUrl, "audio/wav", version.preview],
                [version.pictureUrl, "image/svg+xml", version.picture],
              ]) if (url === source) {
                const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
                res.setHeader("Content-Type", type); res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Cache-Control", "public,max-age=31536000,immutable");
                const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
                if (range) {
                  const start = Number(range[1]), end = range[2] ? Math.min(body.length - 1, Number(range[2])) : body.length - 1;
                  res.writeHead(206, { "Content-Range": "bytes " + start + "-" + end + "/" + body.length, "Content-Length": end - start + 1 });
                  res.end(body.subarray(start, end + 1));
                } else { res.setHeader("Content-Length", body.length); res.end(body); }
                return;
              }
            }
            res.statusCode = 404; res.end("Unknown immutable fixture resource");
          }
        });
      },
    }],
  });
  try {
    await server.listen();
    browser = await launchBrowser();
    const page = await browser.newPage({ acceptDownloads: true });
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto("http://127.0.0.1:" + server.httpServer.address().port + "/__v8-export/index.html?ai=1");
    await page.waitForFunction(() => window.FRAME_AI && window.__FRAME_LIVE_STATUS__?.revision === 1 && window.__FRAME_STUDIO__?.ready);
    const job = await page.evaluate(() => window.FRAME_AI.exportVideo({ width: 320, fps: 12, start: 0, end: 1, subtitles: false }));
    await page.waitForFunction(id => {
      const value = window.FRAME_AI.exportStatus(id);
      return value.state === "running" && value.progress?.phase === "rendering" && value.progress.completed >= 2;
    }, job.id);
    assert.equal(await page.evaluate(() => window.__FRAME_PREVIEW_READERS__), 1);
    for (const version of versions.slice(1)) {
      current = version;
      for (const client of clients) client.write("id: " + version.revision + "\nevent: revision\ndata: " + JSON.stringify(version.manifest) + "\n\n");
    }
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__FRAME_LIVE_STATUS__.revision), 1, "display reference stays on the accepted export source");
    assert.equal(await page.evaluate(() => window.FRAME_AI.info().title), "Frozen version 1");
    assert.deepEqual(await page.evaluate(() => window.__V8_IMPORTED_VERSIONS__), [1], "revisions are coalesced without importing new source during export");
    await page.waitForFunction(id => window.FRAME_AI.exportStatus(id).state !== "running", job.id);
    const result = await page.evaluate(id => window.FRAME_AI.exportStatus(id), job.id);
    assert.equal(result.state, "succeeded", JSON.stringify(result));
    const download = page.waitForEvent("download");
    await page.evaluate(id => window.FRAME_AI.download(id), job.id);
    const output = path.join(outputDir, "frozen.webm");
    await (await download).saveAs(output);
    const probe = JSON.parse(execFileSync(mediaBinary("ffprobe"), ["-v", "error", "-count_frames", "-show_streams", "-of", "json", output], { encoding: "utf8" }));
    assert.equal(Number(probe.streams.find(stream => stream.codec_type === "video").nb_read_frames), 12);
    assert(probe.streams.some(stream => stream.codec_type === "audio"));
    const png = execFileSync(mediaBinary("ffmpeg"), ["-v", "error", "-ss", "0.5", "-i", output, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
    const frame = await sharp(png).removeAlpha().raw().toBuffer();
    near(pixel(frame, 200, 120), [185, 28, 28]);
    near(pixel(frame, 20, 20), [255, 255, 255]);
    const pcm = wavPcm(execFileSync(mediaBinary("ffmpeg"), ["-v", "error", "-i", output, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"]));
    const original = amplitude(pcm, 440), changed = Math.max(...[880, 1320, 1760].map(frequency => amplitude(pcm, frequency)));
    assert(original > 0.05 && original > changed * 20, "export must encode the frozen original 440 Hz source, not preview/changed audio");
    assert(requests.includes(versions[0].originalUrl), "offline export fetched original media");
    await page.waitForFunction(() => window.__FRAME_LIVE_STATUS__?.revision === 3 && window.FRAME_AI.info().title === "Frozen version 3");
    assert.equal(await page.evaluate(() => window.__FRAME_PREVIEW_READERS__), 0);
    assert.deepEqual(await page.evaluate(() => window.__V8_IMPORTED_VERSIONS__), [1, 3], "export release applies the newest revision directly");
    const livePixels = await page.evaluate(() => {
      const canvas = document.querySelector(".stage canvas") || [...document.querySelectorAll("canvas")].find(item => item.width >= 320);
      const context = canvas.getContext("2d");
      return [[...context.getImageData(200, 120, 1, 1).data].slice(0, 3), [...context.getImageData(20, 20, 1, 1).data].slice(0, 3)];
    });
    near(livePixels[0], [21, 128, 61]); near(livePixels[1], [17, 34, 255]);
    assert.deepEqual(pageErrors, []);
  } finally {
    for (const client of clients) client.end();
    await browser?.close(); await server.close();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
