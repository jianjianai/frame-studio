import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./helpers.mjs";
import { executeProject } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";

test(
  "progressive audio starts before complete download, cold seeks with Range and keeps file tracks on the picture clock",
  { timeout: 120000 },
  async (t) => {
    const f = fixture({ browser: true }),
      requests = [],
      rate = 22050,
      seconds = 120;
    const wav = Buffer.alloc(44 + rate * 2 * seconds);
    wav.write("RIFF");
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    for (let i = 0; i < seconds * rate; i++)
      wav.writeInt16LE(
        Math.round(Math.sin((i / rate) * Math.PI * 2 * 440) * 3000),
        44 + i * 2,
      );
    let transferred = 0,
      browser,
      dev;
    const server = http.createServer(async (req, res) => {
      const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ""),
        start = Number(match?.[1] || 0),
        end = match?.[2] ? Number(match[2]) : wav.length - 1;
      requests.push({ range: req.headers.range, start });
      res.writeHead(match ? 206 : 200, {
        "Content-Type": "audio/wav",
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Content-Length": end - start + 1,
        ...(match
          ? { "Content-Range": `bytes ${start}-${end}/${wav.length}` }
          : {}),
      });
      for (let i = start; i <= end && !res.destroyed; i += 4096) {
        const chunk = wav.subarray(i, Math.min(i + 4096, end + 1));
        res.write(chunk);
        transferred += chunk.length;
        await delay(62);
      }
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const metaFile = f.file("project.ts");
      let meta = fs.readFileSync(metaFile, "utf8");
      meta = meta
        .replace(/"duration": 2,/, '"duration": 120,')
        .replace(
          /"audioTracks": \[[\s\S]*?\],/,
          'audioTracks: [{id:"bed",name:"配乐",kind:"file",src:"films/test-film/bed.wav"},{id:"voice",name:"旁白",kind:"file",src:"films/test-film/voice.wav",start:2,duration:118}],',
        );
      fs.writeFileSync(metaFile, meta);
      fs.writeFileSync(f.file("public/bed.wav"), wav);
      fs.writeFileSync(f.file("public/voice.wav"), wav);
      dev = await executeProject(f.root, "test-film", "dev");
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.addInitScript(() => {
        const NativeAudio = window.Audio;
        window.fixtureAudio = [];
        window.Audio = function (...args) {
          const a = new NativeAudio(...args);
          window.fixtureAudio.push(a);
          return a;
        };
      });
      await page.route("**/*.wav", (route) =>
        route.continue({
          url: `http://127.0.0.1:${server.address().port}/audio.wav`,
        }),
      );
      await page.goto(dev.url);
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const began = Date.now();
      await page.getByTestId("play-toggle").click();
      await page.waitForFunction(
        () => window.__FRAME_STUDIO__.getState().time > 0.2,
        {},
        { timeout: 15000 },
      );
      const firstPlayMs = Date.now() - began,
        firstBytes = transferred;
      assert(
        firstBytes < wav.length / 2,
        `playback waited for ${firstBytes} of ${wav.length} bytes`,
      );
      await page.waitForFunction(
        () => window.__FRAME_STUDIO__.getState().time > 3,
        {},
        { timeout: 20000 },
      );
      const samples = [];
      for (let i = 0; i < 15; i++) {
        samples.push(
          await page.evaluate(() => ({
            state: window.__FRAME_STUDIO__.getState(),
            tracks: window.fixtureAudio.map((a) => ({
              time: a.currentTime,
              paused: a.paused,
            })),
          })),
        );
        await delay(100);
      }
      const drift = Math.max(
        ...samples.flatMap((s) =>
          s.tracks
            .filter((a) => !a.paused)
            .map((a, i) =>
              Math.abs(a.time - (s.state.time - (i === 1 ? 2 : 0))),
            ),
        ),
      );
      assert(drift < 0.1, `audio/picture drift ${drift}s`);
      await page.evaluate(() => {
        const a = window.__FRAME_STUDIO__;
        a.seek(75);
        a.seek(20);
        a.seek(90);
      });
      await page.waitForFunction(
        () => window.__FRAME_STUDIO__.getState().time > 90.1,
        {},
        { timeout: 20000 },
      );
      assert(
        requests.some((r) => r.start > rate * 2 * 80),
        "cold seek did not request the selected byte range",
      );
      await page.getByLabel("旁白音轨控制", { exact: true }).click();
      await page.getByRole("button", { name: "旁白静音", exact: true }).click();
      await page.evaluate(() => window.__FRAME_STUDIO__.setRate(2));
      await delay(500);
      await page.evaluate(() => window.__FRAME_STUDIO__.pause());
      const paused = await page.evaluate(
        () => window.__FRAME_STUDIO__.getState().time,
      );
      await delay(250);
      assert.equal(
        await page.evaluate(() => window.__FRAME_STUDIO__.getState().time),
        paused,
      );
      assert.equal(
        await page.evaluate(() => window.fixtureAudio.every((a) => a.paused)),
        true,
      );
      const diagnostics = await page.evaluate(() =>
        window.__FRAME_STUDIO__.getDiagnostics(),
      );
      assert.deepEqual(diagnostics.errors, []);
      t.diagnostic(
        JSON.stringify({
          firstPlayMs,
          firstBytes,
          fileBytes: wav.length,
          maximumDriftSeconds: drift,
          rangeRequests: requests.length,
          lateRange: requests.some((r) => r.start > rate * 2 * 80),
        }),
      );
    } finally {
      await browser?.close();
      await dev?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      f.close();
    }
  },
);
