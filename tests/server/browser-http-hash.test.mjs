import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { BasicSoundBank } from "spessasynth_core";
import { browserOptions } from "../../scripts/browser.mjs";
import { browserSha256 } from "../../src/browser/hash.mjs";
import { splitSoundfont } from "../../scripts/soundfont-parts.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("browser SHA prefers native digest and preserves byte-view boundaries", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const actual = globalThis.crypto.subtle;
  let calls = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      subtle: {
        digest(algorithm, input) {
          calls++;
          return actual.digest(algorithm, input);
        },
      },
    },
  });
  try {
    const bytes = new Uint8Array([97, 98, 99, 100, 101]);
    assert.equal(
      await browserSha256(bytes.subarray(1, 4)),
      sha(bytes.subarray(1, 4)),
    );
    assert.equal(calls, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(browserSha256(bytes, controller.signal), {
      name: "AbortError",
    });
    assert.equal(calls, 1);
  } finally {
    Object.defineProperty(globalThis, "crypto", original);
  }
});

function wav() {
  const bytes = Buffer.alloc(44 + 48000 * 2);
  bytes.write("RIFF");
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
  bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < 48000; i++)
    bytes.writeInt16LE(
      Math.round(Math.sin((i * Math.PI * 880) / 48000) * 12000),
      44 + i * 2,
    );
  return bytes;
}

test(
  "real ordinary HTTP verifies original/compressed audio and soundfonts without Web Crypto",
  { timeout: 120000 },
  async (t) => {
    const owned = await fs.mkdtemp(path.join(os.tmpdir(), "frame-http-hash-"));
    let server, browser;
    t.after(async () => {
      try {
        await browser?.close();
      } finally {
        try {
          await server?.close();
        } finally {
          await fs.rm(owned, { recursive: true, force: true });
        }
      }
    });
    const original = wav();
    await fs.writeFile(path.join(owned, "original.wav"), original);
    await promisify(execFile)(process.env.FRAME_FFMPEG || "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path.join(owned, "original.wav"),
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "96k",
      path.join(owned, "preview.mp3"),
    ]);
    const compressed = await fs.readFile(path.join(owned, "preview.mp3")),
      compressedSha = sha(compressed),
      bank = Buffer.from(BasicSoundBank.getSampleSoundBankFile()),
      bankSha = sha(bank),
      split = splitSoundfont(bank),
      corrupt = (data) => {
        const bytes = Buffer.from(data);
        bytes[Math.floor(bytes.length / 2)] ^= 1;
        return bytes;
      };
    let corruptAudio = false,
      corruptParts = false;
    const counts = new Map();
    const manifest = {
      version: 1,
      duration: 1,
      tracks: [
        {
          id: "main",
          chunks: [
            {
              start: 0,
              duration: 1,
              file: `preview-audio/${compressedSha}.mp3`,
              sha256: compressedSha,
              bytes: compressed.length,
            },
          ],
        },
      ],
    };
    const main = `<!doctype html><script type="module">
import {browserSha256} from '/src/browser/hash.mjs';
import {previewBlobHash,loadPreviewResource} from '/src/engine/preview-cache-storage.mjs';
import {AudioSourcePool} from '/src/engine/audio-source-pool.ts';
import {createSampledScoreAudio} from '/src/engine/soundfont-audio.ts';
import {previewCacheBridge} from '/studio/preview-cache.js';
window.helpers={browserSha256,previewBlobHash,loadPreviewResource,AudioSourcePool,createSampledScoreAudio};
const frame=document.createElement('iframe');frame.id='audio';frame.sandbox='allow-scripts';frame.allow='autoplay';
window.release=previewCacheBridge({current:frame},'/preview-audio-fixture/index.html');
frame.src='/preview-audio-fixture/index.html';document.body.append(frame);
</script>`;
    const child = `<!doctype html><html data-preview-audio="1"><script type="module">
import {preparePreviewAudio} from '/src/engine/preview-audio.ts';
window.probe=async()=>{
 const context=new OfflineAudioContext(2,48000,48000);
 const prepared=await preparePreviewAudio({duration:1,audioTracks:[{id:'main',name:'main',kind:'generated',gain:1}]},context);
 let voice;
 try {
  await prepared.generated.prepareSegment({context,trackId:'main',offset:0,duration:1,rate:1});
  voice=prepared.generated.createAudio({context,destination:context.destination,trackId:'main',when:0,offset:0,duration:1,rate:1});
  const pcm=(await context.startRendering()).getChannelData(0);
  return {peak:Math.max(...pcm),finite:pcm.every(Number.isFinite),preview:prepared.preview};
 } finally {voice?.dispose();prepared.generated.disposeAudio(context);}
};
</script></html>`;
    server = await createServer({
      configFile: false,
      root: process.cwd(),
      cacheDir: path.join(owned, "vite"),
      logLevel: "error",
      appType: "custom",
      server: {
        host: "127.0.0.1",
        port: 0,
        watch: null,
        allowedHosts: ["frame.insecure.test"],
        cors: true,
      },
      plugins: [
        {
          name: "http-hash-fixture",
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              const url = new URL(req.url, "http://fixture"),
                file = url.pathname;
              let data, type;
              if (file === "/__http_hash") {
                data = main;
                type = "text/html";
              } else if (file === "/preview-audio-fixture/index.html") {
                data = child;
                type = "text/html";
              } else if (file === "/preview-audio.json") {
                data = JSON.stringify(manifest);
                type = "application/json";
              } else if (file === "/films/original.wav") {
                data = original;
                type = "audio/wav";
              } else if (file.endsWith(`/preview-audio/${compressedSha}.mp3`)) {
                data = corruptAudio ? corrupt(compressed) : compressed;
                type = "audio/mpeg";
              } else if (file === "/films/full.sf2") {
                data = bank;
                type = "application/octet-stream";
              } else if (file === "/films/parts.sf2.parts/index.json") {
                data = JSON.stringify(split.manifest);
                type = "application/json";
              } else if (file.startsWith("/films/parts.sf2.parts/")) {
                const part = split.parts.find((part) =>
                  file.endsWith("/" + part.file),
                );
                if (part) {
                  data = corruptParts ? corrupt(part.bytes) : part.bytes;
                  type = "application/octet-stream";
                }
              }
              if (data === undefined && file.endsWith(".parts/index.json")) {
                res.statusCode = 404;
                res.end();
                return;
              }
              if (data === undefined) return next();
              counts.set(file, (counts.get(file) || 0) + 1);
              res.setHeader("Content-Type", type);
              res.setHeader("Content-Length", Buffer.byteLength(data));
              res.setHeader("Access-Control-Allow-Origin", "*");
              res.setHeader("Cache-Control", "no-store");
              res.end(data);
            });
          },
        },
      ],
    });
    await server.listen();
    const options = browserOptions();
    browser = await chromium.launch({
      ...options,
      args: [
        ...options.args,
        "--host-resolver-rules=MAP frame.insecure.test 127.0.0.1",
        "--no-proxy-server",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const page = await browser.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(
      `http://frame.insecure.test:${server.httpServer.address().port}/__http_hash`,
    );
    await page.waitForFunction(
      () => window.helpers && document.getElementById("audio"),
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        secure: isSecureContext,
        subtle: typeof crypto.subtle,
        cache: typeof caches,
      })),
      { secure: false, subtle: "undefined", cache: "undefined" },
    );

    await t.test(
      "exact fallback hashes boundary views and large inputs while timers/cancellation work",
      async () => {
        const lengths = [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 65537];
        const result = await page.evaluate(async (lengths) => {
          const { browserSha256 } = window.helpers,
            hashes = [];
          for (const size of lengths) {
            const input = Uint8Array.from(
              { length: size + 7 },
              (_, i) => (i * 31 + (i % 7)) % 256,
            );
            hashes.push(
              await browserSha256(new DataView(input.buffer, 3, size)),
            );
          }
          const large = new Uint8Array(32 * 1024 * 1024).fill(7);
          let ticks = 0;
          const timer = setInterval(() => ticks++, 0);
          const hash = await browserSha256(large);
          clearInterval(timer);
          const controller = new AbortController();
          setTimeout(() => controller.abort(), 0);
          const cancelled = await browserSha256(large, controller.signal).then(
            () => false,
            (e) => e.name === "AbortError",
          );
          return { hashes, hash, ticks, cancelled, bytes: large.byteLength };
        }, lengths);
        assert.deepEqual(
          result.hashes,
          lengths.map((size) =>
            sha(
              Uint8Array.from(
                { length: size + 7 },
                (_, i) => (i * 31 + (i % 7)) % 256,
              ).subarray(3, 3 + size),
            ),
          ),
        );
        assert.equal(result.hash, sha(Buffer.alloc(32 * 1024 * 1024, 7)));
        assert.ok(result.ticks > 2, JSON.stringify(result));
        assert.equal(result.cancelled, true);
        assert.equal(result.bytes, 32 * 1024 * 1024);
        t.diagnostic(
          `HTTP fallback 32 MiB, responsive timer ticks=${result.ticks}`,
        );
      },
    );
    await t.test(
      "original audio resource SHA verification and decoding remain intact",
      async () => {
        const result = await page.evaluate(
          async ({ digest, bytes }) => {
            const { loadPreviewResource, previewBlobHash, AudioSourcePool } =
              window.helpers;
            const resource = {
              path: "films/original.wav",
              url: "/films/original.wav",
              sha256: digest,
              bytes,
              type: "audio/wav",
            };
            const loaded = await loadPreviewResource(resource);
            const hash = await previewBlobHash(loaded.blob);
            const mismatch = await loadPreviewResource({
              ...resource,
              sha256: "0".repeat(64),
            }).then(
              () => false,
              (e) => e.message.includes("校验失败"),
            );
            const pool = new AudioSourcePool();
            try {
              const pcm = (
                await pool.chunk("films/original.wav", 0)
              ).getChannelData(0);
              return {
                hash,
                mismatch,
                persistent: loaded.persistent,
                peak: Math.max(...pcm),
                finite: pcm.every(Number.isFinite),
              };
            } finally {
              pool.dispose();
            }
          },
          { digest: sha(original), bytes: original.length },
        );
        assert.equal(result.hash, sha(original));
        assert.equal(result.mismatch, true);
        assert.equal(result.persistent, false);
        assert.equal(result.finite, true);
        assert.ok(result.peak > 0.2);
      },
    );
    await t.test(
      "opaque compressed preview uses parent SHA broker and rejects tampered MP3",
      async () => {
        const frame = page
          .frames()
          .find((frame) =>
            frame.url().endsWith("/preview-audio-fixture/index.html"),
          );
        await frame.waitForFunction(() => window.probe);
        const result = await frame.evaluate(() => window.probe());
        assert.equal(result.preview, true);
        assert.equal(result.finite, true);
        assert.ok(result.peak > 0.1);
        assert.equal(
          counts.get(
            `/preview-audio-fixture/preview-audio/${compressedSha}.mp3`,
          ),
          1,
        );
        assert.equal(counts.get(`/preview-audio/${compressedSha}.mp3`) || 0, 0);
        corruptAudio = true;
        const message = await frame.evaluate(() =>
          window.probe().then(
            () => "accepted",
            (error) => error.message,
          ),
        );
        assert.match(message, /预览音频校验失败/);
        assert.ok(counts.get(`/preview-audio/${compressedSha}.mp3`) > 0);
        corruptAudio = false;
      },
    );
    await t.test(
      "original/selected soundbanks produce PCM and strict checksum failures",
      async () => {
        const synth = async (file, digest) =>
          page.evaluate(
            async ({ file, digest }) => {
              const { createSampledScoreAudio } = window.helpers;
              const context = new OfflineAudioContext(2, 48000, 48000),
                score = {
                  id: "http-bank",
                  duration: 1,
                  bpm: 120,
                  meter: 4,
                  notes: [
                    { channel: 0, t: 0, end: 1, pitch: 60, velocity: 100 },
                  ],
                  controls: [{ t: 0, data: [0xc0, 0] }],
                  instruments: [
                    {
                      channel: 0,
                      program: 0,
                      name: "fixture",
                      volume: 100,
                      pan: 64,
                      reverb: 0,
                    },
                  ],
                  cues: [],
                };
              const module = createSampledScoreAudio({
                score,
                bank: file,
                sha256: digest,
                levels: { music: 0.5, master: 0.8 },
                foley: () => [new Float32Array(48000), new Float32Array(48000)],
              });
              let voice;
              try {
                await module.prepareAudio(context);
                await module.prepareSegment({
                  context,
                  offset: 0,
                  duration: 1,
                  rate: 1,
                });
                voice = module.createAudio({
                  context,
                  destination: context.destination,
                  trackId: "music",
                  when: 0,
                  offset: 0,
                  duration: 1,
                  rate: 1,
                });
                const pcm = (await context.startRendering()).getChannelData(0);
                return {
                  finite: pcm.every(Number.isFinite),
                  peak: Math.max(...pcm),
                };
              } catch (error) {
                return { error: error.message };
              } finally {
                voice?.dispose();
                module.disposeAudio(context);
              }
            },
            { file, digest },
          );
        for (const file of ["films/full.sf2", "films/parts.sf2"]) {
          const result = await synth(file, bankSha);
          assert.equal(result.finite, true, JSON.stringify(result));
          assert.ok(result.peak > 0.001, JSON.stringify(result));
        }
        const wrong = await synth("films/full.sf2", "0".repeat(64));
        assert.match(wrong.error, /乐器采样校验失败/);
        corruptParts = true;
        const partWrong = await synth("films/parts.sf2", bankSha);
        assert.match(partWrong.error, /乐器采样分包校验失败/);
        assert.equal(counts.get("/films/parts.sf2") || 0, 0);
      },
    );
    assert.deepEqual(errors, []);
  },
);
