import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import { fixture } from "../mcp/helpers.mjs";
import { projectConfig } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { command } from "../../server/process.mjs";
test(
  "V6 real mixed film: engines, video sound, seek, cancellation, missing media and both exports",
  { timeout: 600000 },
  async () => {
    const f = fixture({ browser: true, renderer: "composition" });
    const old = {
      preview: process.env.FRAME_WORK_PREVIEW,
      audio: process.env.FRAME_PREVIEW_AUDIO,
    };
    process.env.FRAME_WORK_PREVIEW = "1";
    process.env.FRAME_PREVIEW_AUDIO = "0";
    let server, browser;
    try {
      let meta = fs
        .readFileSync(f.file("project.ts"), "utf8")
        .replace('"duration": 2', '"duration": 60');
      meta = meta.replace(/"audioTracks":\s*\[[\s\S]*?\],/, "");
      fs.writeFileSync(f.file("project.ts"), meta);
      await command("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=12:duration=6",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=6",
        "-c:v",
        "libvpx-vp9",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-c:a",
        "libopus",
        "-y",
        f.file("public/source.webm"),
      ]);
      fs.writeFileSync(
        f.file("public/overlay.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="35" fill="#ffd344" fill-opacity=".6"/></svg>',
      );
      fs.writeFileSync(
        f.file("public/motion.json"),
        JSON.stringify({
          v: "5.7.0",
          fr: 12,
          ip: 0,
          op: 720,
          w: 320,
          h: 180,
          assets: [],
          layers: [
            {
              ty: 4,
              ip: 0,
              op: 720,
              st: 0,
              ks: {
                o: { a: 0, k: 100 },
                r: { a: 0, k: 0 },
                p: { a: 0, k: [250, 40, 0] },
                a: { a: 0, k: [0, 0, 0] },
                s: { a: 0, k: [100, 100, 100] },
              },
              shapes: [
                {
                  ty: "rc",
                  p: { a: 0, k: [0, 0] },
                  s: { a: 0, k: [25, 25] },
                  r: { a: 0, k: 5 },
                },
                { ty: "fl", c: { a: 0, k: [1, 0, 1, 1] }, o: { a: 0, k: 100 } },
              ],
            },
          ],
        }),
      );
      fs.writeFileSync(
        f.file("three.ts"),
        `import * as T from 'three';import {createThreeScene} from '../../src/engine/scene-adapters';import {openVideoSource} from '../../src/engine/media-source';export const createScene=async(o)=>{const source=await openVideoSource('films/test-film/source.webm',160);const texture=new T.CanvasTexture(document.createElement('canvas'));const result=await createThreeScene(o,()=>{const scene=new T.Scene(),camera=new T.PerspectiveCamera(40,o.width/o.height,.1,100);camera.position.z=5;const mesh=new T.Mesh(new T.BoxGeometry(1.8,1.2,1),new T.MeshBasicMaterial({map:texture}));scene.add(mesh);return{scene,camera,update:t=>{mesh.rotation.y=t;}};});return{...result,async prepareFrame(t,{signal}){const frame=await source.frame(t%6,signal);texture.image=frame.image;texture.needsUpdate=true;},dispose(){source.dispose();result.dispose();}};};`,
      );
      fs.writeFileSync(
        f.file("pixi.ts"),
        `import {Graphics} from 'pixi.js';import {createPixiScene} from '../../src/engine/scene-adapters';export const createScene=(o)=>createPixiScene(o,app=>{const g=new Graphics().circle(0,0,9).fill(0xffffff);app.stage.addChild(g);return t=>g.position.set(20+(t*15)%180,140);});`,
      );
      fs.copyFileSync(
        path.join(f.root, "templates/babylon.txt"),
        f.file("babylon.ts"),
      );
      fs.writeFileSync(
        f.file("scene.ts"),
        `import {createCompositionScene} from '../../src/engine/compositor';import visual from './visual.json';export const createScene=o=>createCompositionScene(o,visual,{three:()=>import('./three'),pixi:()=>import('./pixi'),babylon:()=>import('./babylon')});`,
      );
      const document = {
        schemaVersion: 1,
        clips: [
          {
            id: "back",
            source: { kind: "video", src: "films/test-film/source.webm" },
            start: 0,
            duration: 60,
            loop: 6,
            fit: "fill",
            audio: { enabled: true, gain: 0.25 },
          },
          {
            id: "three",
            source: { kind: "scene", module: "three", engine: "three" },
            start: 0,
            duration: 30,
            transform: { x: 0.2, y: 0.1, width: 0.6, height: 0.6 },
          },
          {
            id: "babylon",
            source: { kind: "scene", module: "babylon", engine: "babylon" },
            start: 30,
            duration: 30,
            transform: { x: 0.2, y: 0.1, width: 0.6, height: 0.6 },
          },
          {
            id: "pixi",
            source: { kind: "scene", module: "pixi", engine: "pixi" },
            start: 0,
            duration: 60,
          },
          {
            id: "image",
            source: { kind: "image", src: "films/test-film/overlay.svg" },
            start: 0,
            duration: 60,
            transform: { x: 0.05, y: 0.05, width: 0.15, height: 0.25 },
          },
          {
            id: "lottie",
            source: { kind: "lottie", src: "films/test-film/motion.json" },
            start: 0,
            duration: 60,
          },
        ],
      };
      fs.writeFileSync(f.file("visual.json"), JSON.stringify(document));
      const config = projectConfig(f.root, "test-film");
      server = await createServer({
        ...config,
        server: { ...config.server, port: 0, strictPort: false },
      });
      await server.listen();
      browser = await launchBrowser();
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        const Native = window.Audio;
        window.testAudio = [];
        window.Audio = function (...args) {
          const a = new Native(...args);
          window.testAudio.push(a);
          return a;
        };
      });
      await page.goto(
        "http://127.0.0.1:" +
          server.httpServer.address().port +
          "/?debug=1&ai=1",
      );
      await page.waitForFunction(
        () =>
          (window.FRAME_AI && window.__FRAME_STUDIO__?.ready) ||
          document.querySelector('[role="alert"]'),
        {},
        { timeout: 120000 },
      );
      assert.equal(
        await page.evaluate(() => !!window.__FRAME_STUDIO__?.ready),
        true,
        JSON.stringify({
          errors,
          text: await page.locator("body").innerText(),
        }),
      );
      console.log("Mixed preview ready");
      const results = await page.evaluate(async () => {
        const api = window.__FRAME_STUDIO__;
        const capture = async (t) => {
          await api.frame(t, false);
          return api.dataURL();
        };
        const a = await capture(1.25),
          later = await capture(45),
          b = await capture(1.25);
        const batch = await Promise.all([
          api.frame(10),
          api.frame(38),
          api.frame(2.5, false),
        ]);
        return {
          same: a === b,
          different: a !== later,
          time: api.getDiagnostics().actualTime,
          diagnostics: api.getDiagnostics(),
          batch: batch.length,
        };
      });
      fs.mkdirSync(path.resolve(".cache/v6"), { recursive: true });
      await page.screenshot({
        path: path.resolve(".cache/v6/mixed-player.png"),
        fullPage: true,
      });
      console.log("Mixed seeks tested", JSON.stringify(results));
      assert.equal(results.same, true);
      assert.equal(results.different, true);
      assert.equal(results.time, 2.5);
      assert.ok(results.diagnostics.scene.activeSources <= 6);
      await page.evaluate(() => window.FRAME_AI.play({ start: 1, end: 2 }));
      await page
        .waitForFunction(
          () => window.__FRAME_STUDIO__.getState().time > 1.2,
          {},
          { timeout: 10000 },
        )
        .catch(async (e) => {
          console.log(
            "PLAY FAILURE",
            await page.evaluate(() => ({
              state: window.__FRAME_STUDIO__.getState(),
              diag: window.__FRAME_STUDIO__.getDiagnostics(),
              media: window.testAudio.map((a) => ({
                t: a.currentTime,
                ready: a.readyState,
                seeking: a.seeking,
                paused: a.paused,
                error: a.error?.message,
                network: a.networkState,
              })),
              body: document.body.innerText,
            })),
          );
          throw e;
        });
      await page.evaluate(() => window.FRAME_AI.pause());
      await page.evaluate(() => window.FRAME_AI.play({ start: 1, end: 1.3 }));
      await page.waitForFunction(
        () =>
          !window.__FRAME_STUDIO__.getState().playing &&
          Math.abs(window.__FRAME_STUDIO__.getDiagnostics().actualTime - 1.3) <
            0.0001,
      );
      await page.evaluate(() =>
        window.FRAME_AI.play({ start: 1, end: 1.2, loop: true }),
      );
      await page.waitForFunction(
        () => window.__FRAME_STUDIO__.getState().playing,
      );
      await page.evaluate(() => window.FRAME_AI.pause());
      const pausedTime = await page.evaluate(
        () => window.__FRAME_STUDIO__.getState().time,
      );
      await page.waitForTimeout(300);
      assert.equal(
        await page.evaluate(() => window.__FRAME_STUDIO__.getState().playing),
        false,
      );
      assert.equal(
        await page.evaluate(() => window.__FRAME_STUDIO__.getState().time),
        pausedTime,
      );
      const cancelled = await page.evaluate(() => {
        const job = window.FRAME_AI.exportVideo({ width: 320, fps: 12 });
        window.FRAME_AI.cancelExport(job.id);
        return job.id;
      });
      await page.waitForFunction(
        (id) => window.FRAME_AI.exportStatus(id).state === "cancelled",
        cancelled,
      );
      const output = await page.evaluate(async () => {
        const { exportWebm } = await import("/src/engine/browser-export.ts");
        const { projects } = await import("/src/projects/index.ts");
        const blob = await exportWebm(projects[0], {
          width: 320,
          fps: 12,
          start: 28,
          end: 32,
          subtitles: false,
          signal: new AbortController().signal,
        });
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      });
      fs.writeFileSync(f.file("browser.webm"), Buffer.from(output));
      console.log("Mixed browser export finished");
      const probe = JSON.parse(
        await command("ffprobe", [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          f.file("browser.webm"),
        ]),
      );
      assert.equal(
        probe.streams.filter((s) => s.codec_type === "video").length,
        1,
      );
      assert.equal(
        probe.streams.filter((s) => s.codec_type === "audio").length,
        1,
      );
      assert.ok(Math.abs(Number(probe.format.duration) - 4) < 0.1);
      // Full 60-second film through the command renderer, covering all source loop and engine boundaries.
      await command(
        process.execPath,
        [
          path.join(f.root, "scripts/render.mjs"),
          "test-film",
          "--width",
          "320",
          "--fps",
          "12",
          "--out",
          f.file("exports/mixed.mp4"),
        ],
        { cwd: f.root, timeout: 240000, maxBytes: 2000000 },
      );
      const cli = JSON.parse(
        await command("ffprobe", [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          f.file("exports/mixed.mp4"),
        ]),
      );
      assert.equal(
        Number(cli.streams.find((s) => s.codec_type === "video").nb_frames),
        720,
      );
      assert.ok(Math.abs(Number(cli.format.duration) - 60) < 0.1);
      assert.ok(cli.streams.some((s) => s.codec_type === "audio"));
      const comparisons = [];
      for (const [label, file, at] of [
        ["browser", f.file("browser.webm"), 0.5],
        ["cli", f.file("exports/mixed.mp4"), 28.5],
      ]) {
        const rgb = f.file(label + ".rgb"),
          pcm = f.file(label + ".pcm");
        await command("ffmpeg", [
          "-v",
          "error",
          "-i",
          file,
          "-ss",
          String(at),
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-y",
          rgb,
        ]);
        await command("ffmpeg", [
          "-v",
          "error",
          "-i",
          file,
          "-ss",
          String(at),
          "-t",
          "0.2",
          "-vn",
          "-f",
          "s16le",
          "-ac",
          "1",
          "-ar",
          "48000",
          "-y",
          pcm,
        ]);
        const bytes = fs.readFileSync(pcm);
        let energy = 0;
        for (let i = 0; i < bytes.length; i += 2)
          energy += (bytes.readInt16LE(i) / 32768) ** 2;
        const rms = Math.sqrt(energy / (bytes.length / 2));
        assert(rms > 0.01, "linked audio must be audible: " + rms);
        comparisons.push({ rgb: fs.readFileSync(rgb), rms });
      }
      const mae =
        comparisons[0].rgb.reduce(
          (sum, v, i) => sum + Math.abs(v - comparisons[1].rgb[i]),
          0,
        ) / comparisons[0].rgb.length;
      assert(mae < 10, "same-time browser/CLI picture difference: " + mae);
      const proxy = await page.evaluate(async () => {
        const { installPreviewPreparation } =
          await import("/src/engine/preview-prepare.ts");
        const { OfflineAudioRenderer } =
          await import("/src/engine/audio-graph.ts");
        const { projects } = await import("/src/projects/index.ts");
        const project = projects[0],
          trackId = "visual:back";
        const preparation = installPreviewPreparation(project);
        const direct = new OfflineAudioRenderer(
          project,
          new Map([[trackId, { gain: 1, muted: false }]]),
        );
        try {
          return {
            prepared: await preparation.pcm(trackId, 1, 0.25),
            direct: await direct.pcm(1, 0.25),
          };
        } finally {
          preparation.dispose();
          direct.dispose();
        }
      });
      assert.deepEqual(
        proxy.prepared,
        proxy.direct,
        "preparing a single proxy track must not double the linked video sound",
      );
      console.log(
        "Cross-export picture MAE",
        mae,
        "audio RMS",
        comparisons.map((v) => v.rms),
      );
      const maskPixels = await page.evaluate(async () => {
        const { createCompositionScene } =
          await import("/src/engine/compositor.ts");
        const scene = createCompositionScene(
          { width: 20, height: 20, quality: "draft" },
          {
            schemaVersion: 1,
            clips: [
              {
                id: "red",
                start: 0,
                duration: 1,
                source: { kind: "color", color: "#ff0000" },
              },
              {
                id: "mask",
                start: 0,
                duration: 1,
                source: { kind: "color", color: "#ffffff" },
                blend: "destination-in",
                transform: { width: 0.5, height: 0.5 },
              },
            ],
          },
        );
        try {
          await scene.prepareFrame(0, { signal: new AbortController().signal });
          const c = scene.canvas.getContext("2d");
          return {
            inside: Array.from(c.getImageData(2, 2, 1, 1).data),
            outside: Array.from(c.getImageData(15, 15, 1, 1).data),
          };
        } finally {
          scene.dispose();
        }
      });
      assert.deepEqual(maskPixels.inside, [255, 0, 0, 255]);
      assert.equal(maskPixels.outside[3], 0);
      const failure = await page.evaluate(async () => {
        const { createCompositionScene } =
          await import("/src/engine/compositor.ts");
        const s = createCompositionScene(
          { width: 160, height: 90, quality: "draft" },
          {
            schemaVersion: 1,
            clips: [
              {
                id: "missing",
                start: 0,
                duration: 1,
                source: { kind: "image", src: "films/test-film/missing.png" },
              },
            ],
          },
        );
        try {
          await s.prepareFrame(0, { signal: new AbortController().signal });
          return false;
        } catch (e) {
          return String(e).includes("404");
        } finally {
          s.dispose();
        }
      });
      assert.equal(failure, true);
      assert.deepEqual(errors, []);
      console.log(
        "V6 acceptance: 60s / 720 frames, 6 mixed layers, linked audio, reverse seek, latest request, cancellation, browser WebM and CLI MP4 passed",
      );
    } finally {
      await browser?.close();
      await server?.close();
      if (old.preview === undefined) delete process.env.FRAME_WORK_PREVIEW;
      else process.env.FRAME_WORK_PREVIEW = old.preview;
      if (old.audio === undefined) delete process.env.FRAME_PREVIEW_AUDIO;
      else process.env.FRAME_PREVIEW_AUDIO = old.audio;
      f.close();
    }
  },
);
