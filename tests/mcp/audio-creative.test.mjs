import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { createServer } from "vite";
import { projectConfig } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";

test(
  "Signalsmith official WASM renders independent pitch/time, scheduled stop, streaming, loops and random seeks",
  { timeout: 90000 },
  async () => {
    const f = fixture({ browser: true });
    const previousNodeEnv = process.env.NODE_ENV;
    let server, browser;
    try {
      process.env.NODE_ENV = "production";
      const config = projectConfig(f.root, "test-film"),
        dependencies = fs.realpathSync(path.join(f.root, "node_modules"));
      assert(
        !dependencies.startsWith(f.root + path.sep),
        "Use shared dependencies outside the fixture root",
      );
      assert(
        config.server.fs.allow.includes(dependencies),
        "Production-linked raw modules require the exact dependency directory",
      );
      server = await createServer(config);
      await server.listen();
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(
        "http://127.0.0.1:" +
          server.httpServer.address().port +
          "/?debug=1#/film/test-film",
      );
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const source = await (
        await page.request.get(
          "http://127.0.0.1:" +
            server.httpServer.address().port +
            "/src/engine/signalsmith-audio.ts",
        )
      ).text();
      const rawImport = source.match(
        /import\("([^"\n]*signalsmith[^"\n]*\?raw[^"\n]*)"\)/,
      )?.[1];
      assert(
        rawImport,
        "Resolve the actual Vite raw module URL, including external node_modules links",
      );
      const rawProof = await page.evaluate(async (url) => {
        const module = await import(url),
          worklet = module.default;
        return {
          type: typeof worklet,
          officialBuffer:
            typeof worklet === "string" &&
            worklet.includes(
              "audioSamples += count;\n\t\t\t\t\t\tblockSamples += count;",
            ),
          officialSchedule:
            typeof worklet === "string" &&
            worklet.includes("this.timeMap[1].output <= outputTime"),
          officialConfigure:
            typeof worklet === "string" &&
            worklet.includes("\n\t\t\t\tconfigure();"),
          officialLoop:
            typeof worklet === "string" &&
            worklet.includes("currentMapSegment.input -= loopLength;"),
        };
      }, rawImport);
      assert.deepEqual(rawProof, {
        type: "string",
        officialBuffer: true,
        officialSchedule: true,
        officialConfigure: true,
        officialLoop: true,
      });
      const result = await page.evaluate(async () => {
        const { createSignalsmithNode, createSignalsmithAudio } =
          await import("/src/engine/signalsmith-audio.ts");
        const make = () => {
          const source = new AudioBuffer({
            numberOfChannels: 2,
            length: 48000 * 5,
            sampleRate: 48000,
          });
          for (let c = 0; c < 2; c++) {
            const data = source.getChannelData(c);
            for (let i = 0; i < data.length; i++)
              data[i] = Math.sin((i * 2 * Math.PI * 440) / 48000) * 0.2;
          }
          return source;
        };
        const inspect = (buffer, from, until) => {
          const data = buffer.getChannelData(0),
            a = Math.round(from * 48000),
            b = Math.round(until * 48000);
          let energy = 0,
            crosses = 0;
          for (let i = a + 1; i < b; i++) {
            energy += data[i] * data[i];
            if (data[i - 1] <= 0 && data[i] > 0) crosses++;
          }
          return {
            hz: crosses / (until - from),
            rms: Math.sqrt(energy / (b - a)),
            finite: data.every(Number.isFinite),
          };
        };
        const render = async (pitch, rate, offset, configuration) => {
          const context = new OfflineAudioContext(2, 48000 * 3, 48000),
            module = createSignalsmithAudio({ buffers: make(), configuration });
          await module.prepareAudio(context);
          const voice = module.createAudio({
            trackId: "main",
            context,
            destination: context.destination,
            when: 0.5,
            offset,
            duration: 1.5 * rate,
            rate,
            pitch,
          });
          await voice.ready;
          const buffer = await context.startRendering();
          voice.dispose();
          return {
            data: buffer,
            during: inspect(buffer, 0.8, 1.8),
            before: inspect(buffer, 0.05, 0.45),
            after: inspect(buffer, 2.1, 2.7),
          };
        };
        const up = await render(12, 1, 1),
          slow = await render(0, 0.5, 1),
          seek = await render(12, 1, 2.125),
          maximum = await render(12, 0.75, 1.125, {
            blockMs: 500,
            intervalMs: 250,
            splitComputation: true,
          });
        const renderDirection = async (rate) => {
          const context = new OfflineAudioContext(2, 48000 * 3.5, 48000),
            node = await createSignalsmithNode(context),
            signal = new Float32Array(48000 * 3);
          let phase = 0;
          for (let i = 0; i < signal.length; i++) {
            const hz = i < 48000 ? 220 : i < 96000 ? 660 : 880;
            phase += (2 * Math.PI * hz) / 48000;
            signal[i] = 0.2 * Math.sin(phase);
          }
          await node.addBuffers([signal, signal.slice()]);
          node.connect(context.destination);
          const started = await node.start({
            output: 0.25,
            input: rate < 0 ? 2.5 : 1.25,
            rate,
          });
          await node.stop(3);
          const buffer = await context.startRendering();
          node.dispose();
          return {
            rate: started.rate,
            head: inspect(buffer, 0.4, 0.6),
            middle: inspect(buffer, 1.2, 1.4),
            tail: inspect(buffer, 2.35, 2.55),
          };
        };
        const freeze = await renderDirection(0),
          reverse = await renderDirection(-1),
          invalidHighLevelRates = [];
        for (const rate of [0, -1, NaN]) {
          const context = new OfflineAudioContext(2, 4800, 48000),
            module = createSignalsmithAudio({ buffers: make() });
          try {
            await module.prepareSegment({
              context,
              trackId: "invalid",
              offset: 0,
              duration: 0.1,
              rate,
            });
            invalidHighLevelRates.push(false);
          } catch (error) {
            invalidHighLevelRates.push(
              /finite and positive/.test(error.message),
            );
          } finally {
            module.disposeAudio?.(context);
          }
        }
        const context = new OfflineAudioContext(2, 48000 * 2, 48000),
          node = await createSignalsmithNode(context);
        await node.configure({
          preset: "cheaper",
          blockMs: 80,
          intervalMs: 20,
          splitComputation: true,
        });
        const latency = await node.latency(),
          source = make();
        await node.addBuffers([
          source.getChannelData(0).slice(0, 48000),
          source.getChannelData(1).slice(0, 48000),
        ]);
        await node.addBuffers([
          source.getChannelData(0).slice(48000, 96000),
          source.getChannelData(1).slice(48000, 96000),
        ]);
        const extent = await node.dropBuffers(0.5);
        await node.setUpdateInterval(0.05);
        node.connect(context.destination);
        const started = await node.start({
          output: 0.25,
          input: 0.5,
          rate: 1,
          semitones: 0,
          loopStart: 0.5,
          loopEnd: 0.7,
        });
        const stopped = await node.stop(1.25);
        const loop = await context.startRendering();
        node.dispose();
        return {
          freeze,
          reverse,
          invalidHighLevelRates,
          up: up.during,
          slow: slow.during,
          seek: seek.during,
          maximum: maximum.during,
          maximumStart: inspect(maximum.data, 0.5, 0.6),
          before: up.before,
          after: up.after,
          latency,
          extent,
          started,
          stopped,
          loop: inspect(loop, 0.5, 1.1),
        };
      });
      assert.equal(result.freeze.rate, 0);
      assert.equal(result.reverse.rate, -1);
      for (const region of [
        result.freeze.head,
        result.freeze.middle,
        result.freeze.tail,
      ])
        assert(
          region.finite && region.rms > 0.03 && Math.abs(region.hz - 660) < 20,
          JSON.stringify(result),
        );
      for (const [region, hz] of [
        [result.reverse.head, 880],
        [result.reverse.middle, 660],
        [result.reverse.tail, 220],
      ])
        assert(
          region.finite && region.rms > 0.03 && Math.abs(region.hz - hz) < 20,
          JSON.stringify(result),
        );
      assert(
        result.invalidHighLevelRates.every(Boolean),
        JSON.stringify(result),
      );
      console.log(
        JSON.stringify({
          freeze: result.freeze,
          reverse: result.reverse,
          invalidHighLevelRates: result.invalidHighLevelRates,
        }),
      );
      assert(Math.abs(result.up.hz - 880) < 12, JSON.stringify(result));
      assert(Math.abs(result.slow.hz - 440) < 8, JSON.stringify(result));
      assert(Math.abs(result.seek.hz - 880) < 12, JSON.stringify(result));
      assert(
        Math.abs(result.maximum.hz - 880) < 12 &&
          result.maximum.rms > 0.05 &&
          result.maximumStart.rms > 0.03,
        JSON.stringify(result),
      );
      console.log(
        JSON.stringify({
          maximum: result.maximum,
          maximumStart: result.maximumStart,
        }),
      );
      assert(
        result.up.rms > 0.05 &&
          result.slow.rms > 0.05 &&
          result.loop.rms > 0.03,
        JSON.stringify(result),
      );
      assert.equal(result.before.rms, 0);
      assert.equal(result.after.rms, 0);
      assert(result.up.finite && result.slow.finite && result.loop.finite);
      assert(result.latency > 0 && result.latency < 1);
      assert.equal(result.extent.end, 2);
    } finally {
      await browser?.close();
      await server?.close();
      f.close();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  },
);

test(
  "Tone multisample and per-note PCM helpers preserve sustained phase/envelopes across offline chunk cuts",
  { timeout: 90000 },
  async () => {
    const f = fixture({ browser: true });
    let server, browser;
    try {
      server = await createServer(projectConfig(f.root, "test-film"));
      await server.listen();
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(
        "http://127.0.0.1:" +
          server.httpServer.address().port +
          "/?debug=1#/film/test-film",
      );
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const result = await page.evaluate(async () => {
        const { createSamplerAudio, createToneSequence } =
          await import("/src/engine/audio-authoring.ts");
        const sample = new AudioBuffer({
          numberOfChannels: 1,
          length: 48000,
          sampleRate: 48000,
        });
        for (let i = 0; i < sample.length; i++)
          sample.getChannelData(0)[i] =
            Math.sin((i * 2 * Math.PI * 261.625565) / 48000) * 0.2;
        const notes = [
          { at: 0, duration: 1.5, note: "C4", velocity: 0.6 },
          { at: 0.25, duration: 0.4, note: "G4", velocity: 0.3 },
        ];
        const sampler = createSamplerAudio({
          samples: { C4: sample },
          notes,
          attack: 0.1,
          decay: 0.15,
          sustain: 0.65,
          release: 0.15,
          loop: { start: 0.1, end: 0.9 },
        });
        const tone = createToneSequence({
          notes,
          tailSeconds: 0.4,
          instrument: ({ Tone, toneContext }) =>
            new Tone.Synth({
              context: toneContext,
              oscillator: { type: "sine" },
              envelope: {
                attack: 0.1,
                decay: 0.15,
                sustain: 0.65,
                release: 0.15,
              },
            }),
        });
        const check = async (module) => {
          const lifecycle = new AudioContext({ sampleRate: 48000 });
          await lifecycle.suspend();
          await module.prepareAudio(lifecycle);
          const render = async (offset, duration) => {
            const context = new OfflineAudioContext(
              2,
              Math.round(duration * 48000),
              48000,
            );
            await module.prepareSegment({
              context,
              trackId: "main",
              offset,
              duration,
              rate: 1,
            });
            const voice = module.createAudio({
              context,
              trackId: "main",
              destination: context.destination,
              when: 0,
              offset,
              duration,
              rate: 1,
            });
            await voice.ready;
            const buffer = await context.startRendering();
            voice.dispose();
            return buffer.getChannelData(0);
          };
          const all = await render(0, 2),
            a = await render(0, 0.73125),
            b = await render(0.73125, 1.26875);
          let error = 0,
            energy = 0;
          for (let i = 0; i < all.length; i++) {
            error = Math.max(
              error,
              Math.abs(all[i] - (i < a.length ? a[i] : b[i - a.length])),
            );
            energy += all[i] * all[i];
          }
          module.disposeAudio?.(lifecycle);
          await lifecycle.close();
          return { error, rms: Math.sqrt(energy / all.length) };
        };
        const { createSignalsmithAudio } =
          await import("/src/engine/signalsmith-audio.ts");
        const signalsmithSmall = createSignalsmithAudio({ buffers: sample }),
          large = new AudioBuffer({
            numberOfChannels: 1,
            length: 48000 * 40,
            sampleRate: 48000,
          });
        for (let i = 0; i < large.length; i++)
          large.getChannelData(0)[i] =
            Math.sin((i * 2 * Math.PI * 440) / 48000) * 0.2;
        const checkStretch = async (module) => {
          const lifecycle = new AudioContext({ sampleRate: 48000 });
          await lifecycle.suspend();
          await module.prepareAudio(lifecycle);
          const render = async (offset, length) => {
            const context = new OfflineAudioContext(
                2,
                Math.round(length * 48000),
                48000,
              ),
              options = {
                context,
                trackId: "main",
                offset,
                duration: length * 0.75,
                rate: 0.75,
                pitch: 7,
              };
            await module.prepareSegment(options);
            const voice = module.createAudio({
              ...options,
              destination: context.destination,
              when: 0,
            });
            await voice.ready;
            const data = (await context.startRendering()).getChannelData(0);
            voice.dispose();
            return data;
          };
          const all = await render(0.125, 3),
            a = await render(0.125, 1.17325),
            b = await render(0.125 + 1.17325 * 0.75, 1.82675);
          let error = 0,
            delta = 0,
            energy = 0;
          for (let i = 0; i < all.length; i++) {
            energy += all[i] * all[i];
            error = Math.max(
              error,
              Math.abs(all[i] - (i < a.length ? a[i] : b[i - a.length])),
            );
            if (i) delta = Math.max(delta, Math.abs(all[i] - all[i - 1]));
          }
          module.disposeAudio(lifecycle);
          await lifecycle.close();
          return { error, delta, rms: Math.sqrt(energy / all.length) };
        };
        let preparing = 0,
          peak = 0,
          prepared = 0;
        const bounded = createToneSequence({
          notes: Array.from({ length: 8 }, (_, i) => ({
            at: 0,
            duration: 0.15,
            note: 60 + i,
          })),
          tailSeconds: 0.05,
          prepare: async () => {
            preparing++;
            peak = Math.max(peak, preparing);
            await new Promise((r) => setTimeout(r, 10));
            preparing--;
            prepared++;
          },
          instrument: ({ Tone, toneContext }) =>
            new Tone.Synth({ context: toneContext }),
        });
        const lifecycle = new AudioContext({ sampleRate: 48000 });
        await lifecycle.suspend();
        await bounded.prepareAudio(lifecycle);
        await bounded.prepareSegment({
          context: lifecycle,
          trackId: "main",
          offset: 0,
          duration: 1,
          rate: 1,
        });
        bounded.disposeAudio(lifecycle);
        await lifecycle.close();
        return {
          sampler: await check(sampler),
          tone: await check(tone),
          stretchSmall: await checkStretch(signalsmithSmall),
          stretchLarge: await checkStretch(
            createSignalsmithAudio({ buffers: large }),
          ),
          stretchMaximum: await checkStretch(
            createSignalsmithAudio({
              buffers: large,
              configuration: {
                blockMs: 500,
                intervalMs: 250,
                splitComputation: true,
              },
            }),
          ),
          renderQueue: { peak, prepared },
        };
      });
      assert(result.sampler.error < 0.00001, JSON.stringify(result));
      assert(result.tone.error < 0.00001, JSON.stringify(result));
      assert(
        result.sampler.rms > 0.01 && result.tone.rms > 0.01,
        JSON.stringify(result),
      );
      assert(
        result.stretchSmall.error < 0.0001 &&
          result.stretchLarge.error < 0.0001,
        JSON.stringify(result),
      );
      assert(result.stretchLarge.delta < 0.2, JSON.stringify(result));
      assert(
        result.stretchMaximum.error < 0.0001 &&
          result.stretchMaximum.delta < 0.2 &&
          result.stretchMaximum.rms > 0.03,
        JSON.stringify(result),
      );
      assert.equal(result.renderQueue.peak, 2);
      assert.equal(result.renderQueue.prepared, 8);
      console.log(JSON.stringify(result));
    } finally {
      await browser?.close();
      await server?.close();
      f.close();
    }
  },
);

test(
  "all 18 Tone effects render via authoritative audio.json; Signalsmith file clips survive looping and offline seeks",
  { timeout: 90000 },
  async () => {
    const f = fixture({ browser: true });
    let server, browser;
    try {
      const fs = await import("node:fs");
      const samples = 48000 * 6,
        wav = Buffer.alloc(44 + samples * 4);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(2, 22);
      wav.writeUInt32LE(48000, 24);
      wav.writeUInt32LE(192000, 28);
      wav.writeUInt16LE(4, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(samples * 4, 40);
      for (let i = 0; i < samples; i++) {
        const value = Math.round(
          Math.sin((i * 2 * Math.PI * 440) / 48000) * 0.2 * 32767,
        );
        wav.writeInt16LE(value, 44 + i * 4);
        wav.writeInt16LE(value, 46 + i * 4);
      }
      fs.writeFileSync(f.file("public/tone.wav"), wav);
      const long = Buffer.alloc(44 + 48000 * 40 * 4);
      wav.copy(long, 0, 0, 44);
      long.writeUInt32LE(long.length - 8, 4);
      long.writeUInt32LE(long.length - 44, 40);
      for (let i = 0; i < 48000 * 40; i++) {
        const value = Math.round(
          Math.sin((i * 2 * Math.PI * 440) / 48000) * 0.2 * 32767,
        );
        long.writeInt16LE(value, 44 + i * 4);
        long.writeInt16LE(value, 46 + i * 4);
      }
      fs.writeFileSync(f.file("public/long.wav"), long);
      server = await createServer(projectConfig(f.root, "test-film"));
      await server.listen();
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(
        "http://127.0.0.1:" +
          server.httpServer.address().port +
          "/?debug=1#/film/test-film",
      );
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const result = await page.evaluate(async () => {
        const { OfflineAudioRenderer } =
          await import("/src/engine/audio-graph.ts");
        const { validateAudioDocument } =
          await import("/src/engine/audio-document.mjs");
        const { toneEffectNames } =
          await import("/src/engine/audio-capabilities.mjs");
        const doc = (processors = [], extra = {}) =>
          validateAudioDocument({
            schemaVersion: 1,
            sources: [
              { id: "file", kind: "file", src: "films/test-film/tone.wav" },
            ],
            tracks: [{ id: "music", name: "Music", processors }],
            clips: [
              {
                id: "note",
                track: "music",
                source: "file",
                start: 0,
                duration: 6,
                ...extra,
              },
            ],
          });
        const project = (document) => ({
          id: "test-film",
          duration: 6,
          audioDocument: document,
        });
        const stats = (buffer) => {
          const data = buffer.getChannelData(0);
          return {
            finite: data.every(Number.isFinite),
            rms: Math.sqrt(data.reduce((n, x) => n + x * x, 0) / data.length),
          };
        };
        const effects = [];
        for (const effect of toneEffectNames) {
          const render = new OfflineAudioRenderer(
            project(
              doc([{ type: "tone", effect, options: { wet: 0.35 }, tail: 2 }]),
            ),
          );
          try {
            effects.push({ effect, ...stats(await render.render(0.75, 0.5)) });
          } finally {
            render.dispose();
          }
        }
        const render = new OfflineAudioRenderer(
          project(
            doc([], {
              rate: 0.5,
              preservePitch: true,
              pitch: 12,
              loop: 0.8,
              offset: 0.25,
              stretch: { preset: "default", formantCompensation: true },
            }),
          ),
        );
        let full, left, right;
        try {
          full = await render.render(1, 2);
          left = await render.render(1, 1);
          right = await render.render(2, 1);
        } finally {
          render.dispose();
        }
        const data = full.getChannelData(0);
        let crosses = 0,
          delta = 0;
        for (let i = 1; i < data.length; i++) {
          if (data[i - 1] <= 0 && data[i] > 0) crosses++;
          delta = Math.max(delta, Math.abs(data[i] - data[i - 1]));
        }
        let chunkError = 0;
        for (let i = 0; i < data.length; i++)
          chunkError = Math.max(
            chunkError,
            Math.abs(
              data[i] -
                (i < left.length
                  ? left.getChannelData(0)[i]
                  : right.getChannelData(0)[i - left.length]),
            ),
          );
        const reverb = new OfflineAudioRenderer(
          project(
            doc([
              {
                type: "tone",
                effect: "Reverb",
                options: { decay: 0.25, wet: 0.6, seed: 17 },
                tail: 1,
              },
            ]),
          ),
        );
        let reverbError = 0;
        try {
          const full = await reverb.render(1, 1),
            half = await reverb.render(1.5, 0.5);
          for (let i = 0; i < half.length; i++)
            reverbError = Math.max(
              reverbError,
              Math.abs(
                half.getChannelData(0)[i] - full.getChannelData(0)[i + 24000],
              ),
            );
        } finally {
          reverb.dispose();
        }
        const longDoc = doc([], {
          rate: 0.75,
          preservePitch: true,
          pitch: 7,
          offset: 31,
          stretch: { blockMs: 500, intervalMs: 250, splitComputation: true },
        });
        longDoc.sources[0].src = "films/test-film/long.wav";
        const longRenderer = new OfflineAudioRenderer(project(longDoc));
        let longError = 0,
          longDelta = 0,
          longRms = 0,
          longIndex = 0,
          parts = [];
        try {
          const all = await longRenderer.render(1, 3),
            a = await longRenderer.render(1, 1.17325),
            b = await longRenderer.render(2.17325, 1.82675),
            data = all.getChannelData(0);
          for (let i = 0; i < data.length; i++) {
            const diff = Math.abs(
              data[i] -
                (i < a.length
                  ? a.getChannelData(0)[i]
                  : b.getChannelData(0)[i - a.length]),
            );
            if (diff > longError) {
              longError = diff;
              longIndex = i;
            }
            if (i)
              longDelta = Math.max(longDelta, Math.abs(data[i] - data[i - 1]));
            longRms += data[i] * data[i];
          }
          longRms = Math.sqrt(longRms / data.length);
          parts = [
            {
              peakIndex: longIndex,
              metrics: (await longRenderer.prepared).files.diagnostics(),
            },
          ];
        } finally {
          longRenderer.dispose();
        }
        const modulation = [];
        for (const effect of [
          "AutoFilter",
          "AutoPanner",
          "Chorus",
          "Phaser",
          "Tremolo",
          "Vibrato",
          "PitchShift",
          "FrequencyShifter",
        ]) {
          const renderer = new OfflineAudioRenderer(
            project(
              doc([
                {
                  type: "tone",
                  effect,
                  options: { wet: 0.55, frequency: 3.7, pitch: 7 },
                  tail: 2,
                },
              ]),
            ),
          );
          try {
            const all = await renderer.render(3.75, 1),
              a = await renderer.render(3.75, 0.48125),
              b = await renderer.render(4.23125, 0.51875);
            let error = 0,
              rms = 0,
              delta = 0;
            for (let i = 0; i < all.length; i++) {
              const x = all.getChannelData(0)[i];
              error = Math.max(
                error,
                Math.abs(
                  x -
                    (i < a.length
                      ? a.getChannelData(0)[i]
                      : b.getChannelData(0)[i - a.length]),
                ),
              );
              rms += x * x;
              if (i)
                delta = Math.max(
                  delta,
                  Math.abs(x - all.getChannelData(0)[i - 1]),
                );
            }
            modulation.push({
              effect,
              error,
              delta,
              rms: Math.sqrt(rms / all.length),
            });
          } finally {
            renderer.dispose();
          }
        }
        return {
          effects,
          modulation,
          pitch: { ...stats(full), hz: crosses / 2, delta, chunkError },
          reverbError,
          long: { error: longError, delta: longDelta, rms: longRms, parts },
        };
      });
      assert.equal(result.effects.length, 18);
      for (const item of result.modulation)
        assert(item.error < 0.00001 && item.delta < 0.05, JSON.stringify(item));
      for (const effect of result.effects)
        assert(effect.finite && effect.rms > 0.002, JSON.stringify(effect));
      assert(Math.abs(result.pitch.hz - 880) < 12, JSON.stringify(result));
      assert(
        result.pitch.finite && result.pitch.rms > 0.02,
        JSON.stringify(result),
      );
      assert(result.pitch.delta < 0.2, JSON.stringify(result));
      assert(result.reverbError < 0.005, JSON.stringify(result));
      assert(result.pitch.chunkError < 0.0001, JSON.stringify(result));
      assert(
        result.long.error < 0.0001 &&
          result.long.delta < 0.2 &&
          result.long.rms > 0.02,
        JSON.stringify(result),
      );
      console.log(
        JSON.stringify({
          effects: result.effects.length,
          modulation: result.modulation,
          pitch: result.pitch,
          reverbError: result.reverbError,
          long: result.long,
        }),
      );
    } finally {
      await browser?.close();
      await server?.close();
      f.close();
    }
  },
);

test(
  "full host Tone facade renders Part, Sequence and Loop with offline cuts and live host-clock cancellation",
  { timeout: 90000 },
  async () => {
    const f = fixture({ browser: true });
    let server, browser;
    try {
      server = await createServer(projectConfig(f.root, "test-film"));
      await server.listen();
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(
        "http://127.0.0.1:" +
          server.httpServer.address().port +
          "/?debug=1#/film/test-film",
      );
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const result = await page.evaluate(async () => {
        const { createToneTimeline } =
          await import("/src/engine/audio-authoring.ts");
        const { createToneAudio } =
          await import("/src/engine/audio-adapters.ts");
        const counts = { part: 0, sequence: 0, loop: 0 };
        let facade;
        const timeline = createToneTimeline({
          duration: 2.5,
          build: ({ Tone, toneContext }) => {
            facade = {
              context: Tone.getContext() === toneContext,
              transport: Tone.getTransport() === Tone.Transport,
              destination: Tone.getDestination() === Tone.Destination,
              draw: Tone.getDraw() === Tone.Draw,
              listener: Tone.getListener() === Tone.Listener,
              version: Tone.version,
              aliases:
                Tone.Buffer === Tone.ToneAudioBuffer &&
                Tone.Buffers === Tone.ToneAudioBuffers &&
                Tone.BufferSource === Tone.ToneBufferSource,
              quarter: Tone.Time("4n").toSeconds(),
              frequency: Tone.Frequency("A4").toFrequency(),
            };
            const synth = new Tone.PolySynth(Tone.Synth, {
              volume: -20,
              oscillator: { type: "sine" },
              envelope: {
                attack: 0.01,
                decay: 0.01,
                sustain: 0.6,
                release: 0.05,
              },
            }).toDestination();
            if (synth.context !== toneContext)
              throw Error("unbound Synth context");
            const part = new Tone.Part(
              (time, note) => {
                counts.part++;
                synth.triggerAttackRelease(note, 0.08, time);
              },
              [
                [0.1, "C4"],
                [0.7, "E4"],
                [1.3, "G4"],
              ],
            ).start(0);
            const seq = new Tone.Sequence(
              (time, note) => {
                counts.sequence++;
                synth.triggerAttackRelease(note, 0.08, time);
              },
              ["D4", "F4", "A4"],
              "8n",
            ).start(0.25);
            seq.stop(2.25);
            new Tone.Loop((time) => {
              counts.loop++;
              synth.triggerAttackRelease("C3", 0.18, time);
            }, 0.25)
              .start(0)
              .stop(2.25);
            if (part.context !== toneContext || seq.context !== toneContext)
              throw Error("unbound positional event context");
            Tone.Transport.bpm.value = 120;
          },
        });
        const lifecycle = new AudioContext({ sampleRate: 48000 });
        await lifecycle.suspend();
        await timeline.prepareAudio(lifecycle);
        const render = async (offset, length) => {
          const context = new OfflineAudioContext(
            2,
            Math.round(length * 48000),
            48000,
          );
          await timeline.prepareSegment({
            context,
            trackId: "main",
            offset,
            duration: length,
            rate: 1,
          });
          const voice = timeline.createAudio({
            context,
            trackId: "main",
            destination: context.destination,
            when: 0,
            offset,
            duration: length,
            rate: 1,
          });
          await voice.ready;
          const pcm = (await context.startRendering()).getChannelData(0);
          voice.dispose();
          return pcm;
        };
        const all = await render(0, 2.5),
          a = await render(0, 0.73125),
          b = await render(0.73125, 1.76875);
        let error = 0,
          energy = 0;
        for (let i = 0; i < all.length; i++) {
          error = Math.max(
            error,
            Math.abs(all[i] - (i < a.length ? a[i] : b[i - a.length])),
          );
          energy += all[i] * all[i];
        }
        const analyser = lifecycle.createAnalyser();
        analyser.fftSize = 2048;
        const capture = lifecycle.createMediaStreamDestination();
        analyser.connect(capture);
        const voice = timeline.createAudio({
          context: lifecycle,
          trackId: "main",
          destination: analyser,
          when: lifecycle.currentTime + 0.05,
          offset: 0.375,
          duration: 0.7,
          rate: 1,
        });
        await voice.ready;
        const initialState = lifecycle.state;
        await lifecycle.resume();
        await new Promise((r) => setTimeout(r, 220));
        const samples = new Float32Array(2048);
        analyser.getFloatTimeDomainData(samples);
        const liveRms = Math.sqrt(
          samples.reduce((n, x) => n + x * x, 0) / samples.length,
        );
        voice.dispose();
        await new Promise((r) => setTimeout(r, 150));
        analyser.getFloatTimeDomainData(samples);
        const stoppedRms = Math.sqrt(
          samples.reduce((n, x) => n + x * x, 0) / samples.length,
        );
        timeline.disposeAudio(lifecycle);
        await lifecycle.close();
        const liveCalls = [];
        let rawFacade;
        const direct = createToneAudio(
          ({ Tone, context, when, offset, duration }) => {
            rawFacade = Tone;
            const synth = new Tone.PolySynth(Tone.Synth, {
              volume: -24,
            }).toDestination();
            new Tone.Sequence(
              (time, note) => {
                liveCalls.push({ kind: "sequence", time });
                synth.triggerAttackRelease(note, 0.03, time);
              },
              ["C4", "E4"],
              "16n",
            ).start(0);
            new Tone.Part(
              (time, note) => {
                liveCalls.push({ kind: "part", time });
                synth.triggerAttackRelease(note, 0.03, time);
              },
              [
                [0.5, "G4"],
                [0.75, "D4"],
              ],
            ).start(0);
            new Tone.Loop((time) => {
              liveCalls.push({ kind: "loop", time });
              synth.triggerAttackRelease("C3", 0.03, time);
            }, 0.125).start(0);
            const childContext = new Tone.Context();
            const childSynth = new Tone.Synth({
              context: childContext,
              volume: -30,
            }).toDestination();
            new Tone.Loop({
              context: childContext,
              interval: 0.125,
              callback: (time) => {
                liveCalls.push({ kind: "child-loop", time });
                childSynth.triggerAttackRelease("A4", 0.03, time);
              },
            }).start(0);
            childContext.transport.start(when, offset);
            childContext.transport.stop(when + duration);
            Tone.Transport.start(when, offset);
            Tone.Transport.stop(when + duration);
            return {
              dispose() {
                synth.dispose();
              },
              ready: Tone.start(),
            };
          },
        );
        const raw = new AudioContext({ sampleRate: 48000 });
        await raw.suspend();
        await direct.prepareAudio(raw);
        const output = raw.createMediaStreamDestination(),
          when = raw.currentTime + 0.05;
        const directVoice = direct.createAudio({
          context: raw,
          trackId: "main",
          destination: output,
          when,
          offset: 0.375,
          duration: 0.5,
          rate: 1,
        });
        await directVoice.ready;
        const beforeState = raw.state;
        await raw.resume();
        await new Promise((r) => setTimeout(r, 240));
        directVoice.dispose();
        const count = liveCalls.length;
        await new Promise((r) => setTimeout(r, 150));
        const afterCount = liveCalls.length;
        let replacementRejected = false;
        try {
          rawFacade.setContext(rawFacade.getContext());
        } catch {
          replacementRejected = true;
        }
        await rawFacade.getContext().close();
        const rawStillRunning = raw.state === "running";
        direct.disposeAudio(raw);
        await raw.close();
        let overBudget = false;
        try {
          createToneTimeline({
            duration: 600,
            maxBufferBytes: 1024,
            build() {},
          });
        } catch {
          overBudget = true;
        }
        const { createToneEffect } =
          await import("/src/engine/tone-runtime.ts");
        const delayed = createToneTimeline({
          duration: 0.5,
          build: ({ Tone }) => {
            const synth = new Tone.Synth({ volume: -20 }).toDestination();
            new Tone.Part(
              (time, note) => synth.triggerAttackRelease(note, 0.08, time),
              [[0, "C4"]],
            ).start(0);
            Tone.Transport.start(0.2);
          },
        });
        const delayedPcm = (await delayed.renderBuffer()).getChannelData(0);
        const delayedBefore = delayedPcm
          .slice(0, 8640)
          .reduce((sum, x) => sum + x * x, 0);
        const delayedAfter = delayedPcm
          .slice(12000)
          .reduce((sum, x) => sum + x * x, 0);
        delayed.disposeAudio(new OfflineAudioContext(2, 1, 48000));
        let childCalls = 0,
          childSameRaw = false;
        const cloneTimeline = createToneTimeline({
          duration: 0.6,
          build: ({ Tone, context }) => {
            const child = new Tone.Context();
            childSameRaw = child.rawContext === context;
            const synth = new Tone.Synth({
              context: child,
              volume: -20,
            }).toDestination();
            new Tone.Loop({
              context: child,
              interval: 0.125,
              callback: (time) => {
                childCalls++;
                synth.triggerAttackRelease("A4", 0.05, time);
              },
            })
              .start(0)
              .stop(0.5);
            child.transport.start(0);
          },
        });
        const childPcm = (await cloneTimeline.renderBuffer()).getChannelData(0);
        const childRms = Math.sqrt(
          childPcm.reduce((sum, x) => sum + x * x, 0) / childPcm.length,
        );
        cloneTimeline.disposeAudio(new OfflineAudioContext(2, 1, 48000));
        const sourceClock = [];
        for (const effect of [
          "AutoPanner",
          "Phaser",
          "Vibrato",
          "Tremolo",
          "PitchShift",
        ]) {
          const renderRate = async (rate) => {
            const context = new OfflineAudioContext(
              2,
              Math.round((0.1 + 0.5 / rate) * 48000),
              48000,
            );
            const fx = createToneEffect(context, effect, {
              frequency: 3.7,
              pitch: 7,
            });
            fx.connect(
              context.createGain(),
              context.createGain(),
              0.1,
              2.125,
              rate,
            );
            const lfo = fx.node._lfo ?? fx.node._lfoL ?? fx.node._lfoA;
            lfo.connect(context.destination);
            await fx.ready;
            try {
              return (await context.startRendering())
                .getChannelData(0)
                .slice(4800);
            } finally {
              fx.dispose();
            }
          };
          const normal = await renderRate(1),
            faster = await renderRate(2);
          let error = 0,
            energy = 0,
            scale = 1;
          for (let i = 0; i < faster.length; i++) {
            const difference = faster[i] - normal[i * 2];
            error = Math.max(error, Math.abs(difference));
            energy += difference * difference;
            scale = Math.max(scale, Math.abs(normal[i * 2]));
          }
          const meanA =
            normal
              .filter((_, i) => !(i % 2))
              .reduce((sum, value) => sum + value, 0) / faster.length;
          const meanB =
            faster.reduce((sum, value) => sum + value, 0) / faster.length;
          let covariance = 0,
            varianceA = 0,
            varianceB = 0;
          for (let i = 0; i < faster.length; i++) {
            const a = normal[i * 2] - meanA,
              b = faster[i] - meanB;
            covariance += a * b;
            varianceA += a * a;
            varianceB += b * b;
          }
          sourceClock.push({
            effect,
            error: error / scale,
            rmsError: Math.sqrt(energy / faster.length) / scale,
            correlation: covariance / Math.sqrt(varianceA * varianceB),
          });
        }
        return {
          facade,
          child: { calls: childCalls, rms: childRms, sameRaw: childSameRaw },
          sourceClock,
          delayedBefore,
          delayedAfter,
          counts,
          error,
          rms: Math.sqrt(energy / all.length),
          liveRms,
          stoppedRms,
          initialState,
          beforeState,
          liveCalls,
          count,
          afterCount,
          rawStillRunning,
          replacementRejected,
          overBudget,
        };
      });
      assert(
        result.facade.context &&
          result.facade.transport &&
          result.facade.destination &&
          result.facade.draw &&
          result.facade.listener &&
          result.facade.aliases,
        JSON.stringify(result),
      );
      assert.equal(result.facade.version, "15.1.22");
      assert.equal(result.facade.frequency, 440);
      assert.equal(result.facade.quarter, 0.5);
      assert(
        result.counts.part >= 3 &&
          result.counts.sequence >= 6 &&
          result.counts.loop >= 8,
        JSON.stringify(result),
      );
      assert(
        result.error < 0.00001 && result.rms > 0.005,
        JSON.stringify(result),
      );
      assert(
        result.liveRms > 0.001 && result.stoppedRms < 0.000001,
        JSON.stringify(result),
      );
      assert.equal(result.initialState, "suspended");
      assert.equal(result.beforeState, "suspended");
      assert(
        ["part", "sequence", "loop"].every((kind) =>
          result.liveCalls.some((call) => call.kind === kind),
        ),
        JSON.stringify(result),
      );
      assert.equal(result.count, result.afterCount);
      assert(
        result.liveCalls.some((call) => call.kind === "child-loop"),
        JSON.stringify(result),
      );
      assert(
        result.child.sameRaw &&
          result.child.calls >= 4 &&
          result.child.rms > 0.005,
        JSON.stringify(result),
      );
      assert.equal(result.delayedBefore, 0);
      assert(result.delayedAfter > 0.001);
      for (const item of result.sourceClock)
        // Native PeriodicWave normalization and band limiting change saw amplitude at rate 2; correlation verifies phase.
        assert(item.correlation > 0.999, JSON.stringify(item));
      assert(
        result.rawStillRunning &&
          result.replacementRejected &&
          result.overBudget,
      );
      console.log(JSON.stringify(result));
    } finally {
      await browser?.close();
      await server?.close();
      f.close();
    }
  },
);
