import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fixture, memoryClient, call } from "./helpers.mjs";
import { executeProject } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import {
  validateAudioDocument,
  editAudioDocument,
  audioSegments,
} from "../../src/engine/audio-document.mjs";
const base = () =>
  validateAudioDocument({
    schemaVersion: 1,
    sources: [
      {
        id: "pulse",
        kind: "generated",
        module: "p",
        trackId: "main",
        engine: "web-audio",
      },
    ],
    tracks: [{ id: "music", name: "Music" }],
    clips: [
      {
        id: "a",
        track: "music",
        source: "pulse",
        start: 0,
        duration: 2,
        loop: 0.5,
      },
    ],
    buses: [],
  });
test("audio document validates routing and ownership, preserves split phase and automation", () => {
  const doc = base(),
    split = editAudioDocument(
      doc,
      [{ op: "split", id: "a", at: 0.75, newId: "b" }],
      { duration: 2 },
    );
  assert.equal(split.clips[1].phase, 0.75);
  assert.deepEqual(
    audioSegments(
      { start: 0, duration: 2, loop: 0.5, playbackRate: 1 },
      2,
      0,
      2,
    ).map((s) => s.offset),
    [0, 0, 0, 0],
  );
  assert.throws(
    () =>
      validateAudioDocument({
        ...doc,
        buses: [{ id: "fx", name: "FX", output: "fx" }],
      }),
    /cycle/,
  );
  assert.throws(
    () =>
      validateAudioDocument(
        {
          ...doc,
          sources: [{ id: "pulse", kind: "file", src: "films/other/a.wav" }],
        },
        { projectId: "test-film" },
      ),
    /Cross-project/,
  );
  assert.throws(
    () =>
      validateAudioDocument({
        ...doc,
        clips: [{ ...doc.clips[0], track: "missing" }],
      }),
    /Unknown/,
  );
});
test("audio MCP enables legacy project atomically, protects revisions and shares edits with CLI domain", async () => {
  const f = fixture({ browser: true });
  let m, ro;
  try {
    m = await memoryClient(f.root);
    const before = await call(m.client, "frame_audio", {
      project: "test-film",
    });
    assert.equal(before.declared, false);
    const request = {
      project: "test-film",
      expectedSha256: null,
      projectSha256: before.projectSha256,
      operations: [{ op: "replace", document: before.document }],
    };
    await call(m.client, "frame_audio_edit", { ...request, dryRun: true });
    assert.equal(fs.existsSync(f.file("audio.json")), false);
    const saved = await call(m.client, "frame_audio_edit", request);
    assert.equal(saved.declared, true);
    const split = await call(m.client, "frame_audio_edit", {
      project: "test-film",
      expectedSha256: saved.sha256,
      operations: [{ op: "split", id: "clip_0", at: 1, newId: "right" }],
    });
    assert.equal(split.document.clips.length, 2);
    const conflict = await m.client.callTool({
      name: "frame_audio_edit",
      arguments: {
        project: "test-film",
        expectedSha256: saved.sha256,
        operations: [{ op: "replace", document: saved.document }],
      },
    });
    assert.equal(conflict.isError, true);
    ro = await memoryClient(f.root, { readOnly: true });
    const list = await ro.client.listTools();
    assert(!list.tools.some((t) => t.name === "frame_audio_edit"));
  } finally {
    await ro?.close();
    await m?.close();
    f.close();
  }
});
function wav(seconds = 2) {
  const sr = 48000,
    n = sr * seconds,
    b = Buffer.alloc(44 + n * 4);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((i / sr) * Math.PI * 2 * 440) * 8000);
    b.writeInt16LE(v, 44 + i * 4);
    b.writeInt16LE(v, 46 + i * 4);
  }
  return b;
}
test(
  "real audio engine decodes pooled ranges, loops generated sources, routes effects, uses Tone without closing host",
  { timeout: 120000 },
  async (t) => {
    const f = fixture({ browser: true });
    let dev, browser;
    try {
      fs.writeFileSync(f.file("public/tone.wav"), wav());
      dev = await executeProject(f.root, "test-film", "dev");
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(dev.url);
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const result = await page.evaluate(async () => {
        const {
          OfflineAudioRenderer,
          prepareAudio,
          prepareAudioSegment,
          disposePreparedAudio,
        } = await import("/src/engine/audio-graph.ts");
        const { validateAudioDocument } =
          await import("/src/engine/audio-document.mjs");
        const { createToneAudio } =
          await import("/src/engine/audio-adapters.ts");
        const { default: original } =
          await import("/projects/test-film/project.ts");
        const source = "films/test-film/tone.wav";
        const project = {
          ...original,
          audio: undefined,
          audioTracks: [
            { id: "one", name: "one", kind: "file", src: source, duration: 2 },
            {
              id: "two",
              name: "two",
              kind: "file",
              src: source,
              duration: 2,
              muted: true,
            },
          ],
          loadAudio: undefined,
        };
        const context = new AudioContext(),
          prepared = await prepareAudio(project, context);
        await prepareAudioSegment(prepared, context, 2, 0, 1);
        const pool = prepared.files.diagnostics();
        await prepareAudioSegment(prepared, context, 2, 0, 1);
        const reused = prepared.files.diagnostics();
        disposePreparedAudio(prepared, context);
        await context.close();
        const render = new OfflineAudioRenderer({
          ...project,
          audioTracks: [project.audioTracks[0]],
        });
        const a = await render.render(0, 1),
          b = await render.render(0.5, 0.5);
        const expected = (i) =>
          (Math.sin((i / 48000) * Math.PI * 2 * 440) * 8000) / 32768;
        let error = 0;
        for (let i = 0; i < a.length; i++)
          error = Math.max(
            error,
            Math.abs(a.getChannelData(0)[i] - expected(i)),
          );
        let seekError = 0;
        for (let i = 0; i < b.length; i++)
          seekError = Math.max(
            seekError,
            Math.abs(b.getChannelData(0)[i] - a.getChannelData(0)[i + 24000]),
          );
        render.dispose();
        const generated = {
          createAudio({ context, destination, when, offset, duration, rate }) {
            const buffer = context.createBuffer(
              2,
              Math.ceil(duration * 48000),
              48000,
            );
            for (let ch = 0; ch < 2; ch++) {
              const data = buffer.getChannelData(ch);
              for (let i = 0; i < data.length; i++)
                data[i] = offset + i / 48000 < 0.1 ? 0.2 : 0;
            }
            const node = context.createBufferSource();
            node.buffer = buffer;
            node.playbackRate.value = rate;
            node.connect(destination);
            node.start(when);
            return {
              dispose() {
                node.disconnect();
              },
            };
          },
        };
        const document = validateAudioDocument({
          schemaVersion: 1,
          sources: [
            { id: "s", kind: "generated", module: "pulse", trackId: "main" },
          ],
          tracks: [{ id: "t", name: "T", output: "fx" }],
          buses: [
            { id: "fx", name: "FX", processors: [{ type: "gain", gain: 0.5 }] },
          ],
          clips: [
            {
              id: "c",
              source: "s",
              track: "t",
              start: 0,
              duration: 2,
              loop: 0.5,
            },
          ],
        });
        const mixed = new OfflineAudioRenderer({
          ...original,
          audioDocument: document,
          loadAudio: async () => ({
            generators: { pulse: generated },
            createAudio() {
              throw Error("registry");
            },
          }),
        });
        const pulses = await mixed.render(0, 2);
        const samples = [0.05, 0.25, 0.55, 0.75, 1.05, 1.25, 1.55, 1.75].map(
          (t) => pulses.getChannelData(0)[Math.round(t * 48000)],
        );
        mixed.dispose();
        const tone = createToneAudio(
          ({ Tone, toneContext, destination, when, duration }) => {
            const synth = new Tone.Synth({ context: toneContext, volume: -16 });
            synth.connect(destination);
            synth.triggerAttackRelease("A4", duration * 0.5, when);
            return { dispose: () => synth.dispose() };
          },
        );
        const toneContext = new OfflineAudioContext(2, 48000, 48000);
        await tone.prepareAudio(toneContext);
        const voice = tone.createAudio({
          trackId: "main",
          context: toneContext,
          destination: toneContext.destination,
          when: 0,
          offset: 0,
          duration: 1,
          rate: 1,
        });
        const toneBuffer = await toneContext.startRendering();
        voice.dispose();
        tone.disposeAudio(toneContext);
        const rms = Math.sqrt(
          toneBuffer.getChannelData(0).reduce((s, v) => s + v * v, 0) / 48000,
        );
        const live = new AudioContext();
        await tone.prepareAudio(live);
        tone.disposeAudio(live);
        const hostOpen = live.state !== "closed";
        await live.close();
        return { pool, reused, error, seekError, samples, rms, hostOpen };
      });
      t.diagnostic(JSON.stringify(result));
      assert.equal(result.pool.openedSources, 1);
      assert.equal(result.pool.decodedChunks, 2);
      assert.equal(result.reused.decodedChunks, 2);
      assert(result.error < 0.001, "decoded waveform differs");
      assert(result.seekError < 0.0001, "seek inconsistent");
      result.samples.forEach((v, i) =>
        assert(
          Math.abs(v - (i % 2 ? 0 : 0.1)) < 0.001,
          "loop phase or bus gain differs",
        ),
      );
      assert(result.rms > 0.01);
      assert(result.hostOpen);
    } finally {
      await browser?.close();
      await dev?.close();
      f.close();
    }
  },
);
test(
  "formats, waveforms, lossless export/stems and processor seek/automation acceptance",
  { timeout: 180000 },
  async (t) => {
    const { transcodeAudio } = await import("../../scripts/audio-media.mjs"),
      { inspectAudio } = await import("../../scripts/audio-inspect.mjs"),
      { exportAudio } = await import("../../scripts/audio-export.mjs");
    const { ProjectService } =
        await import("../../scripts/project-service.mjs"),
      { audioContext, audioEdit } =
        await import("../../scripts/audio-service.mjs");
    const { mediaCommand } = await import("../../scripts/media-probe.mjs");
    const f = fixture({ browser: true });
    let browser, dev;
    try {
      fs.writeFileSync(f.file("public/tone.wav"), wav());
      for (const ext of ["flac", "mp3", "ogg", "m4a"]) {
        const r = await transcodeAudio(f.root, "test-film", {
          src: "films/test-film/tone.wav",
          out: "public/tone." + ext,
        });
        assert.equal(r.metadata.sampleRate, 48000);
      }
      await mediaCommand("ffmpeg", [
        "-v",
        "error",
        "-i",
        f.file("public/tone.wav"),
        "-c:a",
        "pcm_s16be",
        f.file("public/tone.aiff"),
      ]);
      await transcodeAudio(f.root, "test-film", {
        src: "films/test-film/tone.aiff",
        out: "public/aiff-copy.wav",
      });
      await mediaCommand("ffmpeg", [
        "-v",
        "error",
        "-i",
        f.file("public/tone.wav"),
        "-af",
        "pan=5.1|c2=c0",
        "-c:a",
        "pcm_s16le",
        f.file("public/surround.wav"),
      ]);
      const info = await inspectAudio(
        f.root,
        "test-film",
        "films/test-film/tone.mp3",
      );
      assert.equal(info.peaks.length, 512);
      assert(info.samplePeak > 0.1);
      assert(info.rmsDb < -10);
      await assert.rejects(
        () =>
          transcodeAudio(f.root, "test-film", {
            src: "films/test-film/tone.wav",
            out: "public/tone.flac",
          }),
        /exist/i,
      );
      dev = await executeProject(f.root, "test-film", "dev");
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(dev.url);
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const result = await page.evaluate(async () => {
        const {
            OfflineAudioRenderer,
            prepareAudio,
            prepareAudioSegment,
            disposePreparedAudio,
          } = await import("/src/engine/audio-graph.ts"),
          { AudioSourcePool } =
            await import("/src/engine/audio-source-pool.ts"),
          { validateAudioDocument } =
            await import("/src/engine/audio-document.mjs"),
          { default: original } =
            await import("/projects/test-film/project.ts");
        const doc = validateAudioDocument({
          schemaVersion: 1,
          sources: [{ id: "s", kind: "file", src: "films/test-film/tone.wav" }],
          tracks: [{ id: "t", name: "Test" }],
          clips: [{ id: "c", source: "s", track: "t", start: 0, duration: 2 }],
          master: { gain: 1, processors: [] },
        });
        const project = (d) => ({
          ...original,
          audioDocument: validateAudioDocument(d),
          loadAudio: undefined,
        });
        const formats = {};
        for (const ext of ["wav", "flac", "mp3", "ogg", "m4a", "aiff"]) {
          const d = structuredClone(doc);
          d.sources[0].src = "films/test-film/tone." + ext;
          const renderer = new OfflineAudioRenderer(project(d));
          try {
            const b = await renderer.render(0.25, 0.5);
            formats[ext] = Math.sqrt(
              b.getChannelData(0).reduce((a, v) => a + v * v, 0) / b.length,
            );
          } catch (e) {
            formats[ext] = String(e);
          } finally {
            renderer.dispose();
          }
        }
        const surroundDoc = structuredClone(doc);
        surroundDoc.sources[0].src = "films/test-film/surround.wav";
        const sr = new OfflineAudioRenderer(project(surroundDoc)),
          sb = await sr.render(0, 1);
        const surround = [0, 1].map((ch) =>
          Math.sqrt(
            sb.getChannelData(ch).reduce((sum, v) => sum + v * v, 0) /
              sb.length,
          ),
        );
        sr.dispose();
        const seek = {};
        for (const type of [
          "filter",
          "compressor",
          "limiter",
          "delay",
          "reverb",
          "distortion",
          "stereo",
          "duck",
        ]) {
          const d = structuredClone(doc);
          d.master.processors = [
            { type, ...(type === "duck" ? { track: "t" } : {}) },
          ];
          const renderer = new OfflineAudioRenderer(project(d));
          const all = await renderer.render(0, 2),
            part = await renderer.render(1.25, 0.5);
          let delta = 0;
          for (let i = 0; i < part.length; i++)
            delta = Math.max(
              delta,
              Math.abs(
                part.getChannelData(0)[i] - all.getChannelData(0)[60000 + i],
              ),
            );
          seek[type] = delta;
          renderer.dispose();
        }
        const constant = {
          createAudio({ context, destination, when, duration, rate }) {
            const node = context.createConstantSource();
            node.offset.value = 1;
            node.connect(destination);
            node.start(when);
            node.stop(when + duration / rate);
            return { dispose: () => node.disconnect() };
          },
        };
        const curve = structuredClone(doc);
        curve.sources = [
          { id: "s", kind: "generated", module: "legacy", trackId: "main" },
        ];
        curve.clips[0].fadeIn = 1;
        curve.clips[0].automation = [
          { at: 0, value: 0, easing: "linear" },
          { at: 1, value: 1, easing: "linear" },
        ];
        const ar = new OfflineAudioRenderer({
          ...project(curve),
          loadAudio: async () => constant,
        });
        const curved = await ar.render(0, 2),
          quadratic = [0.25, 0.5, 0.75].map(
            (t) => curved.getChannelData(0)[Math.round(t * 48000)],
          );
        ar.dispose();
        curve.master.processors = [{ type: "limiter", ceiling: -3 }];
        curve.master.gain = 4;
        curve.clips[0].fadeIn = 0;
        curve.clips[0].automation = [];
        const lr = new OfflineAudioRenderer({
            ...project(curve),
            loadAudio: async () => constant,
          }),
          limited = await lr.render(0, 1);
        let peak = 0;
        for (const v of limited.getChannelData(0))
          peak = Math.max(peak, Math.abs(v));
        lr.dispose();
        // 256 references to the same source range must decode only four chunks.
        const many = structuredClone(doc);
        many.clips = Array.from({ length: 256 }, (_, i) => ({
          ...doc.clips[0],
          id: "c" + i,
          gain: 1 / 256,
        }));
        const stress = new OfflineAudioRenderer(project(many)),
          start = performance.now();
        await stress.render(0, 2);
        const ms = performance.now() - start,
          metrics = (await stress.prepared).files.diagnostics();
        stress.dispose();
        const overloaded = structuredClone(doc);
        overloaded.clips = Array.from({ length: 700 }, (_, i) => ({
          ...doc.clips[0],
          id: "over" + i,
          offset: i * 2,
        }));
        const liveContext = new AudioContext(),
          prepared = await prepareAudio(project(overloaded), liveContext);
        let budgetRejected = false;
        try {
          await prepareAudioSegment(prepared, liveContext, 2, 0, 2);
        } catch (e) {
          budgetRejected = String(e).includes("128 MiB");
        }
        const decodedBeforeRejection =
          prepared.files.diagnostics().decodedChunks;
        disposePreparedAudio(prepared, liveContext);
        await liveContext.close();
        // Offline scheduling may retain its own nodes while a very small LRU evicts cached ranges.
        const pool = new AudioSourcePool(192000),
          ctx = new OfflineAudioContext(2, 96000, 48000),
          voice = pool.play("films/test-film/tone.wav", {
            context: ctx,
            destination: ctx.destination,
            when: 0,
            offset: 0,
            duration: 2,
            rate: 1,
          });
        await voice.ready;
        const small = await ctx.startRendering();
        const tail = small.getChannelData(0)[95000];
        voice.dispose();
        pool.dispose();
        return {
          formats,
          surround,
          seek,
          quadratic,
          peak,
          ms,
          metrics,
          tail,
          budgetRejected,
          decodedBeforeRejection,
        };
      });
      t.diagnostic(JSON.stringify(result));
      assert(result.budgetRejected);
      assert.equal(result.decodedBeforeRejection, 0);
      for (const rms of result.surround)
        assert(rms > 0.1, "5.1 center was lost in downmix");
      assert.match(result.formats.aiff, /WAV\/FLAC/);
      for (const [ext, value] of Object.entries(result.formats).filter(
        ([ext]) => ext !== "aiff",
      ))
        assert(
          typeof value === "number" && value > 0.1 && value < 0.3,
          ext + ": " + value,
        );
      for (const [type, value] of Object.entries(result.seek))
        assert(value < 0.001, type + " seek mismatch " + value);
      result.quadratic.forEach((v, i) =>
        assert(Math.abs(v - [0.25, 0.5, 0.75][i] ** 2 / Math.sqrt(2)) < 0.0001),
      );
      assert(result.peak <= Math.pow(10, -3 / 20) + 0.00001);
      assert.equal(result.metrics.decodedChunks, 4);
      assert(result.metrics.peakBytes <= 4 * 192000);
      assert(Math.abs(result.tail) > 0.01);
      await browser.close();
      browser = undefined;
      await dev.close();
      dev = undefined;
      const service = new ProjectService(f.root),
        current = audioContext(service, "test-film");
      const document = {
        schemaVersion: 1,
        sources: [{ id: "s", kind: "file", src: "films/test-film/tone.wav" }],
        tracks: [{ id: "music", name: "Music" }],
        clips: [
          { id: "c", track: "music", source: "s", start: 0, duration: 2 },
        ],
      };
      audioEdit(service, "test-film", {
        expectedSha256: null,
        projectSha256: current.projectSha256,
        operations: [{ op: "replace", document }],
      });
      const oldPreview = process.env.FRAME_WORK_PREVIEW;
      process.env.FRAME_WORK_PREVIEW = "1";
      try {
        const preview = await executeProject(f.root, "test-film", "build");
        assert.equal(preview.status, "passed", JSON.stringify(preview));
        assert.equal(preview.buildMetrics.audio.generatedChunks, 0);
        assert.equal(preview.buildMetrics.audio.totalChunks, 0);
      } finally {
        if (oldPreview === undefined) delete process.env.FRAME_WORK_PREVIEW;
        else process.env.FRAME_WORK_PREVIEW = oldPreview;
      }
      const output = await exportAudio(f.root, "test-film", {
        format: "flac",
        stems: true,
      });
      assert.equal(output.files.length, 2);
      assert(
        output.files.every((f) =>
          Number.isFinite(Number(f.analysis.integratedLufs)),
        ),
      );
      assert(fs.existsSync(output.directory + "/mix.flac"));
    } finally {
      await browser?.close();
      await dev?.close();
      f.close();
    }
  },
);
test(
  "live document playback keeps bounded looping voices and recovers from seek/rate/cancellation",
  { timeout: 60000 },
  async (t) => {
    const f = fixture({ browser: true });
    let browser, dev;
    try {
      fs.writeFileSync(f.file("public/tone.wav"), wav());
      dev = await executeProject(f.root, "test-film", "dev");
      browser = await launchBrowser();
      const page = await browser.newPage();
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
          sources: [{ id: "s", kind: "file", src: "films/test-film/tone.wav" }],
          tracks: [{ id: "t", name: "Loop" }],
          clips: [
            {
              id: "c",
              track: "t",
              source: "s",
              start: 0,
              duration: 12,
              loop: 0.5,
            },
          ],
        });
        const errors = [],
          transport = new AudioTransport(
            { ...original, duration: 12, audioDocument },
            (e) => errors.push(String(e)),
          );
        await transport.unlock();
        const analyser = transport.context.createAnalyser();
        transport.gain.connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        await transport.play();
        await new Promise((r) => setTimeout(r, 2300));
        analyser.getFloatTimeDomainData(data);
        const rms = Math.sqrt(
            data.reduce((a, v) => a + v * v, 0) / data.length,
          ),
          time = transport.clock.time();
        transport.seek(7.2);
        await new Promise((r) => setTimeout(r, 600));
        transport.setRate(1.5);
        await new Promise((r) => setTimeout(r, 500));
        const after = transport.clock.time();
        transport.pause();
        const stopped = transport.clock.time();
        await new Promise((r) => setTimeout(r, 80));
        const stays = transport.clock.time() === stopped;
        const pool = transport.prepared.files,
          metrics = pool.diagnostics(),
          abort = new AbortController();
        abort.abort();
        let cancelled = false;
        try {
          await pool.prepare("films/test-film/tone.wav", 0, 1, abort.signal);
        } catch {
          cancelled = true;
        }
        await transport.dispose();
        const closed = transport.context.state === "closed";
        return { rms, time, after, stays, cancelled, closed, errors, metrics };
      });
      t.diagnostic(JSON.stringify(result));
      assert(result.rms > 0.05);
      assert(result.time > 2);
      assert(result.after > 8);
      assert(result.stays && result.cancelled && result.closed);
      assert.deepEqual(result.errors, []);
      assert(result.metrics.cacheBytes <= 768000);
    } finally {
      await browser?.close();
      await dev?.close();
      f.close();
    }
  },
);
