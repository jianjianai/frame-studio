import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import Fastify from "fastify";
import sharp from "sharp";
import { LivePreviewSessions } from "../../server/live-preview.mjs";
import { installLivePreview } from "../../server/live-preview-routes.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { repo as root } from "../mcp/helpers.mjs";
function binary(tool) {
  if (process.env[tool.toUpperCase() + "_PATH"])
    return process.env[tool.toUpperCase() + "_PATH"];
  if (spawnSync(tool, ["-version"], { stdio: "ignore" }).status === 0)
    return tool;
  const require = createRequire(import.meta.url);
  return path.join(
    path.dirname(
      require.resolve("@remotion/compositor-linux-x64-gnu/package.json", {
        paths: [require.resolve("@remotion/renderer")],
      }),
    ),
    tool,
  );
}
const meta = {
  id: "test-film",
  title: "Complete cache",
  subtitle: "",
  description: "",
  renderer: "canvas",
  duration: 3,
  fps: 12,
  accent: "#123456",
  poster: "films/test-film/image.png",
  tags: [],
  status: "draft",
  beats: [],
  subtitles: [],
  credits: [],
  composition: { width: 320, height: 180 },
  audioTracks: [
    {
      id: "sample",
      name: "Test voice",
      kind: "file",
      src: "films/test-film/voice.wav",
      gain: 0.4,
    },
  ],
};
function wav() {
  const frames = 144000,
    bytes = Buffer.alloc(44 + frames * 2);
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
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    bytes.writeInt16LE(
      Math.round(Math.sin(((i * 330) / 48000) * 2 * Math.PI) * 10000),
      44 + i * 2,
    );
  return bytes;
}
const scene = `import {assetUrl,previewAssetUrl} from '../../src/engine/types';
import {openVideoSource,openImageSource} from '../../src/engine/media-source';
export async function createScene({width,height,quality}){
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
 const video=await openVideoSource('films/test-film/source.mp4',width,undefined,quality),image=await openImageSource('films/test-film/image.png',undefined,64,64,quality);
 return {canvas,async render(time){const frame=await video.frame(Math.min(2.99,time));const ctx=canvas.getContext('2d');ctx.drawImage(frame.image,0,0,width,height);ctx.drawImage(image,0,0,64,64);},dispose(){video.dispose();image.close();canvas.width=canvas.height=1;}};
}
export const urls=()=>({video:previewAssetUrl('films/test-film/source.mp4','standard'),raw:assetUrl('films/test-film/voice.wav')});
export const bank=()=>new Promise((resolve,reject)=>{const worker=new Worker(new URL('./bank-worker.ts',import.meta.url));worker.onmessage=event=>{worker.terminate();resolve(event.data)};worker.onerror=event=>{worker.terminate();reject(Error(event.message))}});
`;
test(
  "real Live Player supports all modes, complete offline video/audio/worker cache, hot update, cancellation and retry",
  { timeout: 240000 },
  async (t) => {
    const owned = path.join(root, ".cache/v8-cache-player", randomUUID()),
      projectDir = path.join(owned, "projects/test-film");
    t.after(() => fsp.rm(owned, { recursive: true, force: true }));
    await fsp.mkdir(path.join(projectDir, "public"), { recursive: true });
    await fsp.writeFile(
      path.join(projectDir, "project.ts"),
      "export default " +
        JSON.stringify(meta).slice(0, -1) +
        ",load:()=>import('./scene')};",
    );
    await fsp.writeFile(path.join(projectDir, "scene.ts"), scene);
    await fsp.writeFile(
      path.join(projectDir, "bank-worker.ts"),
      "import {assetUrl} from '../../src/engine/types';fetch(assetUrl('films/test-film/bank.sf2')).then(r=>r.arrayBuffer()).then(bytes=>self.postMessage(bytes.byteLength));",
    );
    await fsp.writeFile(path.join(projectDir, "public/voice.wav"), wav());
    await fsp.writeFile(
      path.join(projectDir, "public/bank.sf2"),
      Buffer.alloc(1024 * 1024, 11),
    );
    await sharp({
      create: { width: 128, height: 128, channels: 4, background: "#77bb44" },
    })
      .png()
      .toFile(path.join(projectDir, "public/image.png"));
    const priorFfmpeg = process.env.FFMPEG_PATH,
      priorFfprobe = process.env.FFPROBE_PATH;
    process.env.FFMPEG_PATH = binary("ffmpeg");
    process.env.FFPROBE_PATH = binary("ffprobe");
    const frames = Buffer.alloc(320 * 180 * 3 * 36);
    for (let frame = 0; frame < 36; frame++)
      for (let y = 0; y < 180; y++)
        for (let x = 0; x < 320; x++) {
          const at = (frame * 320 * 180 + y * 320 + x) * 3;
          frames[at] = (x + frame * 9) % 256;
          frames[at + 1] = (y + frame * 5) % 256;
          frames[at + 2] = 90;
        }
    execFileSync(
      process.env.FFMPEG_PATH,
      [
        "-v",
        "error",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        "320x180",
        "-framerate",
        "12",
        "-i",
        "pipe:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "12",
        "-movflags",
        "+faststart",
        "-an",
        "-y",
        path.join(projectDir, "public/source.mp4"),
      ],
      { timeout: 30000, input: frames },
    );
    const work = {
      id: randomUUID(),
      repo: randomUUID(),
      project: "test-film",
      deleted: false,
    };
    const manager = new LivePreviewSessions({
      data: path.join(owned, "data"),
      root,
      db: { one: async () => ({ deleted: false }) },
      repos: { project: async () => ({ dir: projectDir }) },
    });
    const app = Fastify();
    installLivePreview(app, manager);
    let browser;
    try {
      const link = await manager.start({
          work,
          ai: true,
          mediaMode: "original",
        }),
        session = manager.sessions.get(link.sessionId);
      await manager.ready(session);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const origin = "http://127.0.0.1:" + app.server.address().port;
      browser = await launchBrowser();
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(90000);
      await page.goto(origin + link.url);
      await page.waitForFunction(
        () =>
          (window.__FRAME_STUDIO__?.ready &&
            window.__FRAME_LIVE_STATUS__?.state === "ready") ||
          window.__FRAME_LIVE_STATUS__?.state === "error",
      );
      assert.equal(
        await page.evaluate(() => __FRAME_LIVE_STATUS__.state),
        "ready",
        await page.evaluate(() =>
          JSON.stringify({
            live: __FRAME_LIVE_STATUS__,
            cache: window.__FRAME_PREVIEW_CACHE__,
            body: document.body.innerText.slice(0, 500),
          }),
        ),
      );
      assert.equal(
        await page.evaluate(() => FRAME_AI.preview().mode),
        "original",
      );
      let urls = await page.evaluate(async () => {
        const manifest = await (
          await fetch(__FRAME_LIVE_PREVIEW__.manifestUrl)
        ).json();
        const project = await import(
          new URL(manifest.projectUrl, location.href)
        );
        return (await project.default.load()).urls();
      });
      assert.match(urls.video, /films\/test-film\/source.mp4\?v=/);
      await page.evaluate(() => FRAME_AI.setPreviewMode("compressed"));
      await page.waitForFunction(
        () =>
          (__FRAME_LIVE_STATUS__.state === "ready" &&
            FRAME_AI.preview().mode === "compressed") ||
          __FRAME_LIVE_STATUS__.state === "error",
      );
      assert.equal(
        await page.evaluate(() => __FRAME_LIVE_STATUS__.state),
        "ready",
        await page.evaluate(async () => {
          const manifest = await (
              await fetch(__FRAME_LIVE_PREVIEW__.manifestUrl)
            ).json(),
            maps = [
              ...document.querySelectorAll('script[type="importmap"]'),
            ].map((node) => JSON.parse(node.textContent).imports);
          const mapped = maps
            .map((map) => map[new URL(manifest.projectUrl, location.href).href])
            .find(Boolean);
          return JSON.stringify({
            live: __FRAME_LIVE_STATUS__,
            cache: __FRAME_PREVIEW_CACHE__,
            sceneResources: manifest.resources.filter((r) =>
              r.path.includes("scene"),
            ),
            projectUrl: manifest.projectUrl,
            mapped,
            code: mapped ? await (await fetch(mapped)).text() : "",
          });
        }),
      );
      urls = await page.evaluate(async () => {
        const project = await import(
          new URL(
            (await (await fetch(__FRAME_LIVE_PREVIEW__.manifestUrl)).json())
              .projectUrl,
            location.href,
          )
        );
        return (await project.default.load()).urls();
      });
      assert.match(urls.video, /\/video\/[a-f0-9]{64}\/preview$/);
      await page.evaluate(() => FRAME_AI.play({ start: 0.1, end: 2.8 }));
      await page.waitForFunction(() => FRAME_AI.state().time > 0.2);
      await page.evaluate(() => FRAME_AI.setPreviewMode("cached"));
      await page.evaluate(() =>
        FRAME_AI.waitPreviewCache({ timeoutMs: 120000 }),
      );
      await page.evaluate(() => FRAME_AI.pause());
      assert.equal(await page.locator("select").first().inputValue(), "cached");
      const cache = await page.evaluate(() => FRAME_AI.preview().cache);
      assert.equal(cache.completeFiles, cache.totalFiles);
      assert.equal(cache.state, "ready");
      assert.match(cache.warning, /独立安全预览/);
      await page.route("**/preview-live/**", (route) =>
        /\/(manifest.json|events)(\?|$)/.test(
          new URL(route.request().url()).pathname,
        )
          ? route.continue()
          : route.abort(),
      );
      await page.evaluate(async () => {
        await FRAME_AI.frame({ time: 1 });
        await FRAME_AI.seek(2.25);
        await FRAME_AI.seek(0.1);
      });
      const nativeVideo = await page.evaluate(async () => {
        const video = document.createElement("video");
        video.muted = true;
        video.preload = "auto";
        const ready = new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve;
          video.onerror = () =>
            reject(Error("native cached video unavailable"));
        });
        video.setAttribute(
          "src",
          new URL("films/test-film/source.mp4", location.href).href,
        );
        await ready;
        const seeked = new Promise((resolve) => {
          video.onseeked = resolve;
        });
        video.currentTime = 1.25;
        await seeked;
        const result = {
          blob: video.src.startsWith("blob:"),
          width: video.videoWidth,
          time: video.currentTime,
        };
        video.removeAttribute("src");
        video.load();
        return result;
      });
      assert.equal(nativeVideo.blob, true);
      assert.equal(nativeVideo.width, 320);
      assert.equal(nativeVideo.time, 1.25);
      const bank = await page.evaluate(async () => {
        const manifest = await (
            await fetch(__FRAME_LIVE_PREVIEW__.manifestUrl)
          ).json(),
          project = await import(new URL(manifest.projectUrl, location.href));
        return (await project.default.load()).bank();
      });
      assert.equal(bank, 1024 * 1024);
      await page.evaluate(() => FRAME_AI.play({ start: 0.1, end: 1.2 }));
      await page.waitForFunction(() => FRAME_AI.state().time > 0.7);
      await page.evaluate(() => FRAME_AI.pause());
      assert.deepEqual(errors, []);
      await page.unroute("**/preview-live/**");
      const nextTitle = "Updated cached film";
      await fsp.writeFile(
        path.join(projectDir, "project.ts"),
        "export default " +
          JSON.stringify({ ...meta, title: nextTitle }).slice(0, -1) +
          ",load:()=>import('./scene')};",
      );
      const updateDeadline = Date.now() + 20000;
      while (session.revision < 2 && Date.now() < updateDeadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        session.revision > 1,
        JSON.stringify({ revision: session.revision, error: session.error }),
      );
      await page
        .waitForFunction(
          (title) =>
            (FRAME_AI.info().title === title &&
              FRAME_AI.preview().cache.state === "ready") ||
            __FRAME_LIVE_STATUS__.state === "error",
          nextTitle,
          { timeout: 30000 },
        )
        .catch(async (error) => {
          throw Error(
            error.message +
              " " +
              (await page.evaluate(() =>
                JSON.stringify({
                  live: __FRAME_LIVE_STATUS__,
                  cache: __FRAME_PREVIEW_CACHE__,
                  title: FRAME_AI.info().title,
                }),
              )),
          );
        });
      assert.equal(
        await page.evaluate(() => __FRAME_LIVE_STATUS__.state),
        "ready",
        await page.evaluate(async () => {
          const manifest = await (
              await fetch(__FRAME_LIVE_PREVIEW__.manifestUrl)
            ).json(),
            maps = [
              ...document.querySelectorAll('script[type="importmap"]'),
            ].map((node) => JSON.parse(node.textContent).imports);
          const mapped = maps
            .map((map) => map[new URL(manifest.projectUrl, location.href).href])
            .find(Boolean);
          return JSON.stringify({
            live: __FRAME_LIVE_STATUS__,
            cache: __FRAME_PREVIEW_CACHE__,
            sceneResources: manifest.resources.filter((r) =>
              r.path.includes("scene"),
            ),
            projectUrl: manifest.projectUrl,
            mapped,
            code: mapped ? await (await fetch(mapped)).text() : "",
          });
        }),
      );
      const applied = await page.evaluate(() => FRAME_AI.preview().revision);
      assert.ok(applied > 1);
      // Cancellation never resolves waitCached from the earlier accepted revision.
      await page.evaluate(() => {
        FRAME_AI.setPreviewMode("original");
      });
      await page.waitForFunction(() => __FRAME_LIVE_STATUS__.state === "ready");
      await page.evaluate(() => {
        FRAME_AI.setPreviewMode("cached");
        FRAME_AI.cancelPreviewCache();
      });
      await page.waitForFunction(
        () =>
          FRAME_AI.preview().cache.state === "cancelled" ||
          FRAME_AI.preview().cache.state === "error",
      );
      const stopped = await page.evaluate(async () => {
        try {
          await FRAME_AI.waitPreviewCache({ timeoutMs: 1000 });
          return false;
        } catch {
          return true;
        }
      });
      assert.equal(stopped, true);
      assert.equal(
        await page.evaluate(() => FRAME_AI.preview().cache.state),
        "cancelled",
      );
      const newestTitle = "Latest update while cache cancelled";
      await fsp.writeFile(
        path.join(projectDir, "project.ts"),
        "export default " +
          JSON.stringify({ ...meta, title: newestTitle }).slice(0, -1) +
          ",load:()=>import('./scene')};",
      );
      const newestDeadline = Date.now() + 20000;
      while (session.revision < 3 && Date.now() < newestDeadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(session.revision >= 3);
      await page.waitForTimeout(200);
      assert.equal(
        await page.evaluate(() => FRAME_AI.preview().cache.state),
        "cancelled",
        "new versions remain queued until user resumes",
      );
      await page.evaluate(() => FRAME_AI.retryPreviewCache());
      await page.evaluate(() =>
        FRAME_AI.waitPreviewCache({ timeoutMs: 120000 }),
      );
      assert.equal(
        await page.evaluate(() => FRAME_AI.preview().cache.state),
        "ready",
      );
      assert.equal(
        await page.evaluate(() => FRAME_AI.info().title),
        newestTitle,
        "retry prepares newest revision rather than previously displayed version",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await app.close();
      await manager.close();
      await fsp.rm(owned, { recursive: true, force: true });
      if (priorFfmpeg === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = priorFfmpeg;
      if (priorFfprobe === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = priorFfprobe;
    }
  },
);
