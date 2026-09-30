import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import { fixture, repo } from "./helpers.mjs";
import { executeProject } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { sendMedia } from "../../server/media.mjs";

// A shared bottleneck, not one bandwidth allowance per connection. Only media
// is shaped so module loading and CI CPU scheduling do not hide audio stalls.
test(
  "weak network: opaque preview sustains two tracks, reuses downloads and cancels cold seeks",
  { timeout: 180000 },
  async (t) => {
    const f = fixture({ browser: true }),
      app = Fastify();
    let browser;
    const transfers = new Set(),
      requests = [],
      errors = [];
    const latency = 1800,
      bytesPerSecond = 96 * 1024;
    const ticker = setInterval(() => {
      const active = [...transfers];
      const share = Math.floor(
        (bytesPerSecond * 0.025) / Math.max(1, active.length),
      );
      for (const row of active) {
        const end = Math.min(row.offset + share, row.data.length);
        row.stream.write(row.data.subarray(row.offset, end));
        row.offset = end;
        if (end === row.data.length) {
          transfers.delete(row);
          row.stream.end();
        }
      }
    }, 25);
    try {
      fs.writeFileSync(
        f.file("project.ts"),
        fs
          .readFileSync(f.file("project.ts"), "utf8")
          .replace('"duration": 2,', '"duration": 30,')
          .replace(
            /"audioTracks": \[[\s\S]*?\],/,
            'audioTracks:[{id:"melody",name:"旋律",kind:"generated",gain:.5},{id:"pulse",name:"节奏",kind:"generated",gain:.5}],',
          ),
      );
      fs.writeFileSync(
        f.file("audio.ts"),
        `import type {GeneratedAudioOptions} from "../../src/engine/types"; export function createAudio({context,destination,when,offset,duration,rate,trackId}:GeneratedAudioOptions) {
      const o=context.createOscillator(),g=context.createGain();g.gain.value=.15;o.connect(g);g.connect(destination);
      o.frequency.setValueAtTime((trackId==='pulse'?180:440)+offset*3,when);
      o.frequency.linearRampToValueAtTime((trackId==='pulse'?180:440)+(offset+duration)*3,when+duration/rate);
      o.start(when);o.stop(when+duration/rate);return{dispose(){o.stop();o.disconnect();g.disconnect()}};
    }`,
      );
      // Optional before/after benchmark against a recorded revision; never edits the checkout.
      const baseline = process.env.FRAME_NETWORK_BASELINE_REV;
      if (baseline) {
        assert(/^[a-f0-9]{7,40}$/.test(baseline));
        for (const file of [
          "src/engine/preview-audio.ts",
          "src/engine/audio-source-pool.ts",
          "src/engine/audio-graph.ts",
        ])
          fs.writeFileSync(
            path.join(f.root, file),
            execFileSync("git", ["show", baseline + ":" + file], { cwd: repo }),
          );
      }
      const old = process.env.FRAME_WORK_PREVIEW;
      process.env.FRAME_WORK_PREVIEW = "1";
      let built;
      try {
        built = await executeProject(f.root, "test-film", "build");
      } finally {
        old === undefined
          ? delete process.env.FRAME_WORK_PREVIEW
          : (process.env.FRAME_WORK_PREVIEW = old);
      }
      assert.equal(built.status, "passed", JSON.stringify(built));
      app.get("/", (_, res) =>
        res
          .type("text/html")
          .send(
            `<iframe id="film" sandbox="allow-scripts" allow="autoplay" src="/film/index.html?ai=1"></iframe><script type="module">import {previewCacheBridge} from '/cache.js';window.stopCache=previewCacheBridge({current:document.getElementById('film')},'/film/index.html');</script>`,
          ),
      );
      app.get("/cache.js", (_, res) =>
        res
          .type("text/javascript")
          .send(
            fs.readFileSync(path.join(repo, "studio/preview-cache.js"), "utf8"),
          ),
      );
      app.get("/film/*", async (req, res) => {
        const file = req.params["*"],
          target = path.join(built.output, file);
        if (!fs.existsSync(target)) return res.code(404).send();
        res
          .header("Access-Control-Allow-Origin", "*")
          .header("Cache-Control", "no-store");
        res.type(
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".mp3": "audio/mpeg",
          }[path.extname(file)] || "application/octet-stream",
        );
        if (!file.endsWith(".mp3")) return sendMedia(req, res, target);
        requests.push(file);
        const stream = new PassThrough(),
          row = { stream, data: fs.readFileSync(target), offset: 0 };
        const timer = setTimeout(() => {
          if (!stream.destroyed) transfers.add(row);
        }, latency);
        res.raw.on("close", () => {
          clearTimeout(timer);
          transfers.delete(row);
          stream.destroy();
        });
        res.header("Content-Length", row.data.length);
        return res.send(stream);
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      browser = await launchBrowser();
      const page = await browser.newPage();
      page.setDefaultTimeout(25000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("http://127.0.0.1:" + app.server.address().port);
      const frame = page.frames().find((f) => f.url().includes("/film/"));
      await frame.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const began = Date.now();
      await frame.getByTestId("play-toggle").click();
      await frame.waitForFunction(
        () => window.__FRAME_STUDIO__.getState().time > 0.1,
      );
      const startupMs = Date.now() - began;
      const samples = await frame.evaluate(async () => {
        const rows = [];
        for (let i = 0; i < 160; i++) {
          rows.push({
            time: window.__FRAME_STUDIO__.getState().time,
            buffering: window.__FRAME_STUDIO__.getDiagnostics().audio.buffering,
          });
          await new Promise((r) => setTimeout(r, 100));
        }
        window.__FRAME_STUDIO__.pause();
        return rows;
      });
      const stallSamples = samples.filter((r) => r.buffering).length;
      t.diagnostic(
        JSON.stringify({
          latencyMs: latency,
          kbps: (bytesPerSecond * 8) / 1000,
          startupMs,
          stallSamples,
          advanced: samples.at(-1).time - samples[0].time,
          requests: requests.length,
          duplicates: requests.length - new Set(requests).size,
        }),
      );
      assert.equal(
        requests.length - new Set(requests).size,
        0,
        "preload/play/buffering must share in-flight downloads",
      );
      assert.equal(
        stallSamples,
        0,
        "adequate average bandwidth must not repeatedly rebuffer",
      );
      assert(
        samples.at(-1).time - samples[0].time > 14.5,
        "picture/audio clock advances continuously after startup",
      );
      assert(startupMs < 16000, "startup remains bounded");
      await frame.evaluate(() => window.__FRAME_STUDIO__.seek(27));
      await frame.getByTestId("play-toggle").click();
      await frame.waitForTimeout(100);
      await frame.getByTestId("play-toggle").click();
      const paused = await frame.evaluate(
        () => window.__FRAME_STUDIO__.getState().time,
      );
      await frame.waitForTimeout(2500);
      assert.equal(
        await frame.evaluate(() => window.__FRAME_STUDIO__.getState().time),
        paused,
        "cancelled buffering must never resume later",
      );
      await frame.evaluate(() => window.__FRAME_STUDIO__.seek(1));
      await frame.getByTestId("play-toggle").click();
      await frame.waitForFunction(
        () => window.__FRAME_STUDIO__.getState().time > 1.2,
      );
      await frame.evaluate(() => window.__FRAME_STUDIO__.pause());
      assert.deepEqual(errors, []);
    } finally {
      clearInterval(ticker);
      for (const r of transfers) r.stream.destroy();
      await browser?.close();
      await app.close();
      f.close();
    }
  },
);

test(
  "direct audio: network starvation freezes the common clock and resumes without a fatal decode error",
  { timeout: 90000 },
  async (t) => {
    const f = fixture({ browser: true }),
      sr = 48000,
      duration = 30;
    const wav = Buffer.alloc(44 + sr * duration * 4);
    wav.write("RIFF");
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(sr, 24);
    wav.writeUInt32LE(sr * 4, 28);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    for (let i = 0; i < sr * duration; i++) {
      const v = Math.round(Math.sin((i / sr) * Math.PI * 880) * 8000);
      wav.writeInt16LE(v, 44 + i * 4);
      wav.writeInt16LE(v, 46 + i * 4);
    }
    let browser,
      dev,
      interrupted = false,
      requests = 0;
    const server = http.createServer(async (req, res) => {
      requests++;
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ""),
        start = Number(range?.[1] || 0),
        end = range?.[2]
          ? Math.min(Number(range[2]), wav.length - 1)
          : wav.length - 1;
      res.writeHead(range ? 206 : 200, {
        "Content-Type": "audio/wav",
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Content-Length": end - start + 1,
        ...(range
          ? { "Content-Range": `bytes ${start}-${end}/${wav.length}` }
          : {}),
      });
      for (let i = start; i <= end && !res.destroyed; i += 16384) {
        if (!interrupted && i > sr * 4 * 6) {
          interrupted = true;
          await delay(7500);
        }
        if (res.destroyed) break;
        res.write(wav.subarray(i, Math.min(i + 16384, end + 1)));
        await delay(32);
      }
      res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      fs.writeFileSync(f.file("public/network.wav"), wav);
      const baseline = process.env.FRAME_NETWORK_BASELINE_REV;
      if (baseline)
        for (const file of [
          "src/engine/audio-source-pool.ts",
          "src/engine/audio-graph.ts",
        ])
          fs.writeFileSync(
            path.join(f.root, file),
            execFileSync("git", ["show", baseline + ":" + file], { cwd: repo }),
          );
      dev = await executeProject(f.root, "test-film", "dev");
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.route("**/network.wav", (route) =>
        route.continue({
          url: `http://127.0.0.1:${server.address().port}/network.wav`,
        }),
      );
      await page.goto(dev.url);
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const result = await page.evaluate(async () => {
        const { AudioTransport } = await import("/src/engine/audio.ts"),
          { validateAudioDocument } =
            await import("/src/engine/audio-document.mjs"),
          { default: original } =
            await import("/projects/test-film/project.ts");
        const audioDocument = validateAudioDocument({
          schemaVersion: 1,
          sources: [
            { id: "s", kind: "file", src: "films/test-film/network.wav" },
          ],
          tracks: [{ id: "t", name: "Network" }],
          clips: [{ id: "c", track: "t", source: "s", start: 0, duration: 30 }],
        });
        const errors = [],
          transport = new AudioTransport(
            { ...original, duration: 30, audioDocument },
            (e) => errors.push(String(e)),
          );
        try {
          const began = performance.now();
          await transport.play();
          const startupMs = performance.now() - began;
          let buffering = false,
            resumed = false,
            freezeDrift = 0,
            held,
            peakBytes = 0;
          for (let i = 0; i < 220; i++) {
            const now = transport.clock.time();
            if (transport.buffering) {
              buffering = true;
              if (held === undefined) held = now;
              else freezeDrift = Math.max(freezeDrift, Math.abs(now - held));
            } else {
              held = undefined;
              if (buffering && transport.clock.playing) resumed = true;
            }
            peakBytes = Math.max(
              peakBytes,
              transport.diagnostics().files?.cacheBytes || 0,
            );
            await new Promise((r) => setTimeout(r, 100));
          }
          return {
            startupMs,
            buffering,
            resumed,
            freezeDrift,
            peakBytes,
            time: transport.clock.time(),
            errors,
          };
        } finally {
          await transport.dispose();
        }
      });
      t.diagnostic(JSON.stringify({ ...result, requests, interrupted }));
      assert(
        interrupted && result.buffering && result.resumed,
        "real network starvation must recover automatically",
      );
      assert(
        result.freezeDrift < 0.01,
        "buffering must hold the shared audio/picture clock",
      );
      assert(result.time > 10);
      assert(result.peakBytes <= 128 * 1024 * 1024);
      assert.deepEqual(result.errors, []);
    } finally {
      await browser?.close();
      await dev?.close();
      await new Promise((r) => server.close(r));
      f.close();
    }
  },
);
