import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fixture, repo } from "./helpers.mjs";
import { projectConfig } from "../../scripts/project-execution.mjs";
import { browserOptions } from "../../scripts/browser.mjs";

test(
  "Tone.UserMedia keeps native input, volume, Meter/Recorder, cancellation and offline rejection",
  { timeout: 90000 },
  async () => {
    const f = fixture({ browser: true });
    // Chrome's default fake source is a periodic beep. Keep this proof at a
    // fixed phase-independent 440 Hz continuous stereo input across runs.
    const sampleRate = 48000,
      frames = sampleRate * 3,
      wav = Buffer.alloc(44 + frames * 4),
      captureFile = path.join(f.root, "capture.wav");
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 4, 28);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(frames * 4, 40);
    for (let i = 0; i < frames; i++) {
      const value = Math.round(
        0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / sampleRate),
      );
      wav.writeInt16LE(value, 44 + i * 4);
      wav.writeInt16LE(value, 46 + i * 4);
    }
    fs.writeFileSync(captureFile, wav);
    let server, browser;
    try {
      server = await createServer(projectConfig(f.root, "test-film"));
      await server.listen();
      const options = browserOptions();
      browser = await chromium.launch({
        ...options,
        args: [
          ...options.args,
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          `--use-file-for-fake-audio-capture=${captureFile}`,
          "--autoplay-policy=no-user-gesture-required",
        ],
      });
      const page = await browser.newPage();
      await page.goto(
        "http://127.0.0.1:" +
          server.httpServer.address().port +
          "/?debug=1#/film/test-film",
      );
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const result = await page.evaluate(async () => {
        const { prepareTone, createToneContext, createToneFacade } =
          await import("/src/engine/tone-runtime.ts");
        await prepareTone();
        const raw = new AudioContext({ sampleRate: 24000 });
        await raw.resume();
        const context = createToneContext(raw),
          owned = new Set(),
          Tone = createToneFacade(context, owned);
        const streams = [],
          original = navigator.mediaDevices.getUserMedia.bind(
            navigator.mediaDevices,
          );
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await original(constraints);
          streams.push(stream);
          return stream;
        };
        const mic = new Tone.UserMedia({ volume: -6, mute: true }),
          meter = new Tone.Meter({ normalRange: true }),
          stereoMeter = new Tone.Meter({ normalRange: true, channelCount: 2 }),
          recorder = new Tone.Recorder(),
          analyser = new Tone.Analyser("waveform", 256),
          dc = new Tone.DCMeter(),
          fft = new Tone.FFT(256),
          waveform = new Tone.Waveform(256);
        mic.connect(meter);
        mic.connect(stereoMeter);
        mic.connect(analyser);
        mic.connect(dc);
        mic.connect(fft);
        mic.connect(waveform);
        const devices = await Tone.UserMedia.enumerateDevices();
        await mic.open(0);
        const opened = {
          supported: Tone.UserMedia.supported,
          state: mic.state,
          label: mic.label,
          deviceId: mic.deviceId,
          groupId: mic.groupId,
          volume: mic.volume.value,
          mute: mic.mute,
          devices: devices.map((row) => row.kind),
        };
        await new Promise((r) => setTimeout(r, 200));
        const silent = meter.getValue();
        mic.mute = false;
        const restoredVolume = mic.volume.value;
        mic.volume.value = 0;
        // Analysis must run with no Recorder or speaker path pulling input.
        const analysisOnly = {
          meter: 0,
          analyser: 0,
          dc: 0,
          fft: -Infinity,
          waveform: 0,
        };
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 50));
          analysisOnly.meter = Math.max(
            analysisOnly.meter,
            Number(meter.getValue()),
          );
          analysisOnly.analyser = Math.max(
            analysisOnly.analyser,
            ...analyser.getValue().map(Math.abs),
          );
          analysisOnly.dc = Math.max(analysisOnly.dc, Math.abs(dc.getValue()));
          analysisOnly.fft = Math.max(analysisOnly.fft, ...fft.getValue());
          analysisOnly.waveform = Math.max(
            analysisOnly.waveform,
            ...waveform.getValue().map(Math.abs),
          );
        }
        mic.connect(recorder);
        await recorder.start();
        let peak = 0,
          stereoPeak = [0, 0];
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 50));
          peak = Math.max(peak, Number(meter.getValue()));
          const values = stereoMeter.getValue();
          stereoPeak = stereoPeak.map((old, c) => Math.max(old, values[c]));
        }
        const blob = await recorder.stop();
        const recorded = await raw.decodeAudioData(await blob.arrayBuffer());
        const recordData = recorded.getChannelData(0),
          recordRms = Math.sqrt(
            recordData.reduce((sum, x) => sum + x * x, 0) / recordData.length,
          );
        mic.close();
        const state = mic.state,
          stopped = streams.every((stream) =>
            stream.getTracks().every((track) => track.readyState === "ended"),
          );
        let offlineError;
        const offlineRaw = new OfflineAudioContext(2, 4800, 48000),
          offlineContext = createToneContext(offlineRaw),
          offlineTone = createToneFacade(offlineContext);
        const offlineMic = new offlineTone.UserMedia();
        try {
          await offlineMic.open();
        } catch (error) {
          offlineError = { name: error.name, message: error.message };
        }
        offlineMic.dispose();
        offlineContext.dispose();
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await original(constraints);
          streams.push(stream);
          await new Promise((r) => setTimeout(r, 200));
          return stream;
        };
        const pendingMic = new Tone.UserMedia(),
          pending = pendingMic.open().then(
            () => "opened",
            (error) => error.name,
          );
        await new Promise((r) => setTimeout(r, 30));
        pendingMic.close();
        const cancelled = await pending;
        await new Promise((r) => setTimeout(r, 350));
        const cancelledStopped = streams.every((stream) =>
          stream.getTracks().every((track) => track.readyState === "ended"),
        );
        const originalEnumerate = navigator.mediaDevices.enumerateDevices.bind(
          navigator.mediaDevices,
        );
        navigator.mediaDevices.enumerateDevices = async () => {
          await new Promise((r) => setTimeout(r, 100));
          return originalEnumerate();
        };
        const enumMic = new Tone.UserMedia(),
          enumerating = enumMic.open(0).then(
            () => "opened",
            (error) => error.name,
          );
        await new Promise((r) => setTimeout(r, 20));
        enumMic.close();
        const enumCancelled = await enumerating;
        await new Promise((r) => setTimeout(r, 200));
        enumMic.dispose();
        navigator.mediaDevices.enumerateDevices = originalEnumerate;

        pendingMic.dispose();
        for (const node of owned) node.dispose();
        context.dispose();
        await raw.close();
        navigator.mediaDevices.getUserMedia = original;
        return {
          opened,
          restoredVolume,
          silent,
          peak,
          stereoPeak,
          analysisOnly,
          blob: { bytes: blob.size, mime: blob.type, rms: recordRms },
          state,
          stopped,
          offlineError,
          cancelled,
          cancelledStopped,
          enumCancelled,
          captures: streams.length,
        };
      });
      console.log(JSON.stringify(result));
      assert.equal(result.opened.supported, true);
      assert.equal(result.opened.state, "started");
      assert(result.opened.devices.every((kind) => kind === "audioinput"));
      assert(Math.abs(result.restoredVolume + 6) < 0.001);
      assert.equal(result.opened.mute, true);
      assert.equal(result.silent, 0);
      assert(result.peak > 0.001, JSON.stringify(result));
      for (const key of ["meter", "analyser", "dc", "waveform"])
        assert(
          result.analysisOnly[key] > 0.001,
          `${key}: ${JSON.stringify(result)}`,
        );
      assert(result.analysisOnly.fft > -80, JSON.stringify(result));
      assert(
        result.stereoPeak.every((peak) => peak > 0.001),
        JSON.stringify(result),
      );
      assert(result.blob.rms > 0.01, JSON.stringify(result));
      assert(
        result.blob.bytes > 1000 && result.blob.mime.startsWith("audio/"),
        JSON.stringify(result),
      );
      assert.equal(result.state, "stopped");
      assert(result.stopped);
      assert.equal(result.offlineError.name, "NotSupportedError");
      assert.match(result.offlineError.message, /record.*project audio asset/);
      assert.equal(result.cancelled, "AbortError");
      assert(result.cancelledStopped);
      assert.equal(result.enumCancelled, "AbortError");
      assert.equal(result.captures, 2);
    } finally {
      await browser?.close();
      await server?.close();
      f.close();
    }
  },
);

test(
  "opaque Tone.UserMedia uses trusted approval and bounded PCM with suspended/resumed Meter and Recorder",
  { timeout: 90000 },
  async () => {
    const f = fixture({ browser: true });
    let server, browser;
    try {
      const config = projectConfig(f.root, "test-film");
      config.server.cors = true;
      config.plugins.push({
        name: "tone-input-real-bridge",
        configureServer(dev) {
          dev.middlewares.use((req, res, next) => {
            if (req.url === "/input-parent") {
              res.setHeader("Content-Type", "text/html");
              res.end(`<!doctype html><iframe id="preview" sandbox="allow-scripts allow-downloads" allow="autoplay; fullscreen" src="/preview-live/tone-input/index.html"></iframe><button id="allow">允许此作品本次预览</button><script type="module">
        import {liveAudioInputBridge} from '/input-broker.js';
        const nativeGet=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.captureStreams=[];navigator.mediaDevices.getUserMedia=async options=>{const stream=await nativeGet(options);window.captureStreams.push(stream);return stream};
        const frame=document.getElementById('preview');window.inputState={requests:[],active:[]};window.inputBridge=liveAudioInputBridge({current:frame},frame.src,state=>window.inputState=state);
        document.getElementById('allow').addEventListener('click',event=>{const row=window.inputState.requests[0];if(row)void window.inputBridge.allow(row.requestId,event)});
        </script>`);
            } else if (req.url === "/input-broker.js") {
              res.setHeader("Content-Type", "text/javascript");
              res.end(
                fs.readFileSync(
                  path.join(repo, "studio/live-audio-input.js"),
                  "utf8",
                ),
              );
            } else if (req.url === "/preview-live/tone-input/index.html") {
              res.setHeader("Content-Type", "text/html");
              res.setHeader("Access-Control-Allow-Origin", "*");
              res.end("<!doctype html><title>Opaque Tone input</title>");
            } else next();
          });
        },
      });
      server = await createServer(config);
      await server.listen();
      const options = browserOptions();
      browser = await chromium.launch({
        ...options,
        args: [
          ...options.args,
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          "--autoplay-policy=no-user-gesture-required",
        ],
      });
      const page = await browser.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        "http://127.0.0.1:" +
          server.httpServer.address().port +
          "/input-parent",
      );
      const frame = page
        .frames()
        .find((frame) => frame.url().includes("/preview-live/"));
      await frame.evaluate(async () => {
        const { prepareTone, createToneContext, createToneFacade } =
          await import("/src/engine/tone-runtime.ts");
        await prepareTone();
        const raw = new AudioContext({ sampleRate: 48000 });
        await raw.suspend();
        const context = createToneContext(raw),
          owned = new Set(),
          Tone = createToneFacade(context, owned);
        const mic = new Tone.UserMedia(),
          meter = new Tone.Meter({ normalRange: true }),
          recorder = new Tone.Recorder();
        mic.connect(meter);
        mic.connect(recorder);
        window.input = {
          raw,
          context,
          owned,
          mic,
          meter,
          recorder,
          status: "pending",
          origin: window.origin,
        };
        window.openInput = mic.open().then(
          () => {
            window.input.status = "started";
          },
          (error) => {
            window.input.status = error.name;
            window.input.error = error.message;
          },
        );
      });
      await page.waitForFunction(() => window.inputState.requests.length === 1);
      await page.waitForTimeout(4500);
      assert.equal(
        await frame.evaluate(() => window.input.status),
        "pending",
        "typed ACK keeps pending explicit approval alive beyond local handshake deadline",
      );
      await page.locator("#allow").click();
      await frame.waitForFunction(() => window.input.status === "started");
      await page.waitForTimeout(5500);
      assert.equal(
        await frame.evaluate(() => window.input.mic.state),
        "started",
      );
      assert.equal(
        await frame.evaluate(() => window.input.raw.state),
        "suspended",
      );
      assert.equal(
        await page.evaluate(() => window.inputState.capturing),
        true,
      );
      const result = await frame.evaluate(async () => {
        const { raw, mic, meter, recorder, owned, context } = window.input;
        await raw.resume();
        await recorder.start();
        let peak = 0;
        for (let i = 0; i < 30; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          peak = Math.max(peak, Number(meter.getValue()));
        }
        const blob = await recorder.stop(),
          metadata = {
            label: mic.label,
            deviceId: mic.deviceId,
            groupId: mic.groupId,
          };
        mic.close();
        for (const node of owned) node.dispose();
        context.dispose();
        await raw.close();
        return {
          origin: window.input.origin,
          peak,
          bytes: blob.size,
          mime: blob.type,
          metadata,
          state: mic.state,
        };
      });
      await page.waitForFunction(
        () =>
          !window.inputState.capturing &&
          window.inputState.active.length === 0 &&
          window.inputState.requests.length === 0,
      );
      assert.equal(result.origin, "null");
      assert(result.peak > 0.001, JSON.stringify(result));
      assert(
        result.bytes > 1000 && result.mime.startsWith("audio/"),
        JSON.stringify(result),
      );
      assert.equal(result.state, "stopped");
      assert.equal(
        await page.evaluate(() =>
          window.captureStreams.every((stream) =>
            stream.getTracks().every((track) => track.readyState === "ended"),
          ),
        ),
        true,
      );
      await page.evaluate(() => window.inputBridge.dispose());
      assert.deepEqual(errors, []);
      console.log(JSON.stringify(result));
    } finally {
      await browser?.close();
      await server?.close();
      f.close();
    }
  },
);
