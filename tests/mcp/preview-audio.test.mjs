import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { fixture, repo } from "./helpers.mjs";
import { executeProject } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { sendMedia } from "../../server/media.mjs";

test(
  "compressed preview: slow start, cold seek, seamless boundaries, track controls, original export and persistent opaque-frame cache",
  { timeout: 120000 },
  async (t) => {
    const f = fixture({ browser: true }),
      app = Fastify();
    let browser;
    const requested = [];
    try {
      fs.writeFileSync(
        f.file("project.ts"),
        fs
          .readFileSync(f.file("project.ts"), "utf8")
          .replace('"duration": 2,', '"duration": 12,')
          .replace(
            /"audioTracks": \[[\s\S]*?\],/,
            'audioTracks:[{id:"melody",name:"旋律",kind:"generated",gain:.6},{id:"voice",name:"文件音轨",kind:"file",src:"films/test-film/voice.wav",start:1,offset:.5,duration:2,gain:.35}],',
          ),
      );
      const wav = Buffer.alloc(44 + 48000 * 4 * 2);
      wav.write("RIFF");
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(48000, 24);
      wav.writeUInt32LE(96000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(wav.length - 44, 40);
      for (let i = 0; i < 48000 * 4; i++)
        wav.writeInt16LE(
          Math.round(Math.sin((i / 48000) * Math.PI * 440) * 10000),
          44 + i * 2,
        );
      fs.writeFileSync(f.file("public/voice.wav"), wav);
      fs.writeFileSync(
        f.file("audio.ts"),
        `import type {GeneratedAudioOptions} from '../../src/engine/types'; export function createAudio({context,destination,when,duration,rate}:GeneratedAudioOptions) { const o=context.createOscillator(),g=context.createGain();o.frequency.value=440;g.gain.value=.25;o.connect(g);g.connect(destination);o.start(when);o.stop(when+duration/rate);return{dispose(){o.stop();o.disconnect();g.disconnect()}} }`,
      );
      const old = process.env.FRAME_WORK_PREVIEW;
      const oldProgress = process.env.FRAME_TASK_PROGRESS_FILE;
      const progressFile = path.join(f.root, ".cache", "audio-progress.json"),
        progressValues = [];
      fs.mkdirSync(path.dirname(progressFile), { recursive: true });
      const progressWatcher = fs.watch(path.dirname(progressFile), () => {
        try {
          progressValues.push(
            JSON.parse(fs.readFileSync(progressFile, "utf8")),
          );
        } catch {}
      });
      process.env.FRAME_TASK_PROGRESS_FILE = progressFile;
      process.env.FRAME_WORK_PREVIEW = "1";
      let built;
      try {
        built = await executeProject(f.root, "test-film", "build");
      } finally {
        progressWatcher.close();
        if (oldProgress === undefined)
          delete process.env.FRAME_TASK_PROGRESS_FILE;
        else process.env.FRAME_TASK_PROGRESS_FILE = oldProgress;
        old === undefined
          ? delete process.env.FRAME_WORK_PREVIEW
          : (process.env.FRAME_WORK_PREVIEW = old);
      }
      assert.equal(built.status, "passed", JSON.stringify(built));
      assert(
        progressValues.some(
          (p) => p.total > 1 && p.completed > 0 && p.completed < p.total,
        ),
        "headless execution must report intermediate progress without a log callback",
      );
      const manifest = JSON.parse(
        fs.readFileSync(path.join(built.output, "preview-audio.json")),
      );
      assert.equal(manifest.tracks[0].chunks.length, 6);
      assert(manifest.tracks[0].chunks.every((c) => c.bytes < 22000));
      app.get("/", (req, res) =>
        res
          .type("text/html")
          .send(
            `<html><body><iframe id="film" sandbox="allow-scripts allow-downloads" allow="autoplay" src="/film/index.html?ai=1"></iframe><script type="module">import {previewCacheBridge} from '/cache.js'; window.stopCache=previewCacheBridge({current:document.getElementById('film')},'/film/index.html');</script></body></html>`,
          ),
      );
      app.get("/cache.js", (req, res) =>
        res
          .type("text/javascript")
          .send(
            fs.readFileSync(path.join(repo, "studio/preview-cache.js"), "utf8"),
          ),
      );
      app.get("/film/*", async (req, res) => {
        const file = req.params["*"];
        if (file.endsWith(".mp3")) {
          requested.push(file);
          await new Promise((r) => setTimeout(r, 450));
        }
        const target = path.join(built.output, file);
        if (!fs.existsSync(target)) return res.code(404).send();
        res
          .header("Access-Control-Allow-Origin", "*")
          .header(
            "Content-Security-Policy",
            "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:",
          );
        res.type(
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".mp3": "audio/mpeg",
          }[path.extname(file)] || "application/octet-stream",
        );
        return sendMedia(req, res, target);
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      browser = await launchBrowser();
      const context = await browser.newContext();
      await context.addInitScript(() => {
        const original = AudioNode.prototype.connect;
        window.audioProbes = [];
        AudioNode.prototype.connect = function (destination, ...args) {
          if (
            destination === this.context.destination &&
            this.context instanceof AudioContext &&
            !(this instanceof AnalyserNode)
          ) {
            const analyser = this.context.createAnalyser();
            analyser.fftSize = 2048;
            window.audioProbes.push(analyser);
            original.call(this, analyser);
            return original.call(analyser, destination, ...args);
          }
          return original.call(this, destination, ...args);
        };
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("http://127.0.0.1:" + app.server.address().port);
      const frame = page.frames().find((f) => f.url().includes("/film/"));
      await frame.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const before = Date.now();
      await frame.getByTestId("play-toggle").click();
      await frame.waitForFunction(
        () => window.__FRAME_STUDIO__.getState().time > 0.3,
      );
      const firstPlayMs = Date.now() - before;
      assert(firstPlayMs < 2200, String(firstPlayMs));
      const levels = await frame.evaluate(async () => {
        const values = [];
        for (let i = 0; i < 125; i++) {
          const data = new Float32Array(2048);
          window.audioProbes[0].getFloatTimeDomainData(data);
          values.push(
            Math.sqrt(data.reduce((n, v) => n + v * v, 0) / data.length),
          );
          await new Promise((r) => setTimeout(r, 25));
        }
        return values;
      });
      assert(
        Math.min(...levels) > 0.015,
        "audible output must not drop at chunk boundaries",
      );
      await frame.evaluate(() => window.FRAME_AI.pause());
      const seekStart = Date.now();
      await frame.evaluate(() => window.FRAME_AI.seek(10));
      await frame.getByTestId("play-toggle").click();
      await frame.waitForFunction(
        () => window.__FRAME_STUDIO__.getState().time > 10.2,
      );
      const seekMs = Date.now() - seekStart;
      assert(seekMs < 2200, String(seekMs));
      await frame.evaluate(() =>
        window.FRAME_AI.setTrack("melody", { muted: true }),
      );
      await frame.waitForTimeout(180);
      const silent = await frame.evaluate(() => {
        const data = new Float32Array(2048);
        window.audioProbes[0].getFloatTimeDomainData(data);
        return Math.max(...data.map(Math.abs));
      });
      assert(
        silent < 0.002,
        "muting the generated track must not leave file audio outside its timeline interval",
      );
      await frame.evaluate(() => {
        window.FRAME_AI.setTrack("melody", { muted: false });
        window.FRAME_AI.setRate(2);
      });
      await frame.waitForFunction(
        () => window.__FRAME_STUDIO__.getState().time > 10.8,
      );
      await frame.evaluate(() => window.FRAME_AI.pause());
      // Original export path must still work, even when proxy files are unavailable.
      await page.route("**/preview-audio/*.mp3", (route) => route.abort());
      const exported = await frame.evaluate(() =>
        window.FRAME_AI.exportVideo({
          start: 0,
          end: 0.3,
          width: 320,
          fps: 12,
        }),
      );
      await frame.waitForFunction(
        (id) => window.FRAME_AI.exportStatus(id).state !== "running",
        exported.id,
      );
      assert.equal(
        (
          await frame.evaluate(
            (id) => window.FRAME_AI.exportStatus(id),
            exported.id,
          )
        ).state,
        "succeeded",
      );
      await page.unroute("**/preview-audio/*.mp3");
      const beforeReload = requested.length;
      await page.reload();
      const again = page.frames().find((f) => f.url().includes("/film/"));
      await again.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      await again.getByTestId("play-toggle").click();
      await again.waitForFunction(
        () => window.__FRAME_STUDIO__.getState().time > 0.3,
      );
      assert.equal(
        requested.length,
        beforeReload,
        "reopen must reuse persistent content-hash cache",
      );
      assert.deepEqual(errors, []);
      t.diagnostic(
        JSON.stringify({
          firstPlayMs,
          seekMs,
          minimumRms: Math.min(...levels),
          proxyBytes: manifest.tracks
            .flatMap((t) => t.chunks)
            .reduce((n, c) => n + c.bytes, 0),
        }),
      );
    } finally {
      await browser?.close();
      await app.close();
      f.close();
    }
  },
);
