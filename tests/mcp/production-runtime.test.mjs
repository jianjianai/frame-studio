import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, repo } from "./helpers.mjs";
import { exportProduction } from "../../scripts/production-export.mjs";
import { produceNarration } from "../../scripts/narration.mjs";
import { executeProject } from "../../scripts/project-execution.mjs";
import { createProjectWorkspace } from "../../scripts/project-workspace.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { checkPlayback } from "../../scripts/playback-check.mjs";

test(
  "formal export preflights, decodes every frame, resumes verified segments and invalidates changed inputs",
  { timeout: 180000 },
  async () => {
    const f = fixture({ browser: true });
    try {
      const options = {
        start: 0,
        end: 0.5,
        fps: 12,
        width: 320,
        segmentSeconds: 0.25,
      };
      const result = await exportProduction(f.root, "test-film", options);
      const manifest = JSON.parse(fs.readFileSync(result.manifest, "utf8"));
      assert.equal(manifest.preflight, "passed");
      assert.equal(manifest.segments.length, 2);
      const verification = JSON.parse(
        fs.readFileSync(result.verification, "utf8"),
      );
      assert.equal(verification.media.decodedFrames, 6);
      assert.equal(verification.status, "passed");
      const segment = path.join(path.dirname(result.output), "segment-0.mp4");
      const before = fs.statSync(segment).mtimeMs;
      const lock = path.join(path.dirname(result.output), "render.lock");
      fs.writeFileSync(
        lock,
        JSON.stringify({ pid: process.pid, token: "other-operation" }),
      );
      await assert.rejects(
        () =>
          exportProduction(f.root, "test-film", {
            ...options,
            resume: result.renderId,
          }),
        /already active/,
      );
      assert.equal(
        JSON.parse(fs.readFileSync(lock, "utf8")).token,
        "other-operation",
      );
      fs.unlinkSync(lock);
      const resumed = await exportProduction(f.root, "test-film", {
        ...options,
        resume: result.renderId,
      });
      assert.equal(resumed.status, "passed");
      assert.equal(fs.statSync(segment).mtimeMs, before);
      fs.writeFileSync(f.file("public/new.bin"), "new media");
      await assert.rejects(
        () =>
          exportProduction(f.root, "test-film", {
            ...options,
            resume: result.renderId,
          }),
        /input or export parameters changed/,
      );
    } finally {
      f.close();
    }
  },
);

test(
  "narration caches by content and voice and measures subtitle timing; budgets fail explicitly",
  { timeout: 60000 },
  async () => {
    const f = fixture({ browser: true });
    try {
      fs.writeFileSync(
        f.file("scripts/provider.mjs"),
        `export async function synthesize(){ const n=4410,b=new Uint8Array(44+n*4),v=new DataView(b.buffer); for(const [at,s] of [[0,'RIFF'],[8,'WAVEfmt '],[36,'data']]) for(let i=0;i<s.length;i++) b[at+i]=s.charCodeAt(i);v.setUint32(4,36+n*4,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,2,true);v.setUint32(24,44100,true);v.setUint32(28,176400,true);v.setUint16(32,4,true);v.setUint16(34,16,true);v.setUint32(40,n*4,true);return b; }`,
      );
      const plan = {
        provider: "scripts/provider.mjs",
        voice: "fixture",
        duration: 1,
        sentences: [
          { id: "one", text: "第一句", start: 0, budget: 0.5 },
          { id: "two", text: "第二句", start: 0.5, budget: 0.5 },
        ],
      };
      const save = () =>
        fs.writeFileSync(
          f.file("production/narration.json"),
          JSON.stringify(plan),
        );
      save();
      const first = await produceNarration(
        f.root,
        "test-film",
        "production/narration.json",
      );
      assert.equal(first.cacheHits, 0);
      assert.ok(Math.abs(first.subtitles[0].end - 0.1) < 0.001);
      const cached = await produceNarration(
        f.root,
        "test-film",
        "production/narration.json",
      );
      assert.equal(cached.cacheHits, 2);
      assert.equal(first.version, cached.version);
      plan.sentences[0].text = "修改第一句";
      save();
      const edited = await produceNarration(
        f.root,
        "test-film",
        "production/narration.json",
      );
      assert.equal(edited.cacheHits, 1);
      assert.notEqual(edited.version, first.version);
      plan.sentences[0].budget = 0.01;
      save();
      await assert.rejects(
        () =>
          produceNarration(f.root, "test-film", "production/narration.json"),
        /time budget/,
      );
    } finally {
      f.close();
    }
  },
);

test(
  "Worker PCM cold seeks, cancelled requests, streaming browser encoding and debug controls work in a real browser",
  { timeout: 120000 },
  async () => {
    const f = fixture({ browser: true });
    let dev, browser;
    try {
      fs.writeFileSync(
        f.file("audio.ts"),
        `import {createWorkerPcmAudio} from '../../src/engine/worker-pcm'; const audio=createWorkerPcmAudio({createWorker:()=>new Worker(new URL('./pcm.worker.ts',import.meta.url),{type:'module'})}); export const {prepareAudio,prepareSegment,createAudio,disposeAudio}=audio;`,
      );
      fs.writeFileSync(
        f.file("pcm.worker.ts"),
        `import {exposePcmGenerator} from '../../src/engine/worker-pcm'; exposePcmGenerator(({startFrame,frames,sampleRate})=>{const a=new Float32Array(frames);for(let i=0;i<frames;i++) a[i]=Math.sin((i+startFrame)*Math.PI*2*220/sampleRate)*0.1;return [a,a.slice()];});`,
      );
      dev = await executeProject(f.root, "test-film", "dev");
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(dev.url);
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const result = await page.evaluate(async () => {
        const api = window.__FRAME_STUDIO__;
        api.setRate(2);
        api.setTrack("melody", { gain: 0.3 });
        const captured = await api.captureAt(1.2, { audio: true });
        const { default: project } =
          await import("/projects/test-film/project.ts");
        const { OfflineAudioRenderer } =
          await import("/src/engine/audio-graph.ts");
        const audio = new OfflineAudioRenderer(project);
        const later = await audio.pcm(1, 0.25);
        await audio.pcm(0, 0.25);
        const repeated = await audio.pcm(1, 0.25);
        audio.dispose();
        const module = await import("/projects/test-film/audio.ts");
        const context = new AudioContext();
        await module.prepareAudio(context);
        const abort = new AbortController();
        abort.abort();
        let cancelled = false;
        try {
          await module.prepareSegment({
            trackId: "melody",
            context,
            offset: 0,
            duration: 1,
            rate: 1,
            signal: abort.signal,
          });
        } catch {
          cancelled = true;
        }
        await module.prepareSegment({
          trackId: "melody",
          context,
          offset: 1,
          duration: 0.25,
          rate: 2,
        });
        module.disposeAudio(context);
        await context.close();
        const { exportWebm } = await import("/src/engine/browser-export.ts");
        const chunks = [];
        let encoder;
        const blob = await exportWebm(project, {
          width: 320,
          fps: 12,
          subtitles: false,
          signal: new AbortController().signal,
          writable: new WritableStream({
            async write(chunk) {
              await new Promise((resolve) => setTimeout(resolve, 2));
              chunks.push({ position: chunk.position, data: [...chunk.data] });
            },
          }),
          onEncoder: (info) => (encoder = info),
        });
        return {
          same: later === repeated,
          cancelled,
          time: captured.time,
          diagnostics: captured.diagnostics,
          state: api.getState(),
          chunks,
          encoder,
          streaming: blob === null,
        };
      });
      assert.equal(result.same, true);
      assert.equal(result.cancelled, true);
      assert.equal(result.state.rate, 2);
      assert.equal(result.time, 1.2);
      assert.equal(result.streaming, true);
      assert.ok(result.encoder.codec);
      const size = Math.max(
        ...result.chunks.map((chunk) => chunk.position + chunk.data.length),
      );
      const bytes = Buffer.alloc(size);
      for (const chunk of result.chunks)
        Buffer.from(chunk.data).copy(bytes, chunk.position);
      const file = f.file("exports/stream.webm");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      const probe = spawnSync(
        process.env.FFPROBE_PATH || "ffprobe",
        ["-v", "error", "-count_frames", "-show_streams", "-of", "json", file],
        { encoding: "utf8" },
      );
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(
        JSON.parse(probe.stdout).streams.find(
          (stream) => stream.codec_type === "video",
        ).nb_read_frames,
        "24",
      );
      const e2e = await executeProject(f.root, "test-film", "test-e2e");
      assert.equal(e2e.status, "passed", e2e.output);
      const playback = await checkPlayback(f.root, "test-film", {
        start: 0.5,
        duration: 0.25,
      });
      assert.equal(playback.status, "passed", JSON.stringify(playback));
    } finally {
      await browser?.close();
      await dev?.close();
      f.close();
    }
  },
);

test(
  "isolated task copy has its own clean Git baseline and persistent CLI jobs survive the starter",
  { timeout: 120000 },
  async () => {
    const f = fixture({ browser: true });
    let job;
    const run = (args) =>
      spawnSync(
        process.execPath,
        [path.join(repo, "scripts/film.mjs"), ...args],
        { cwd: f.root, encoding: "utf8", windowsHide: true },
      );
    try {
      const workspace = createProjectWorkspace(f.root, "test-film");
      const status = spawnSync("git", ["status", "--porcelain"], {
        cwd: workspace.directory,
        encoding: "utf8",
      });
      assert.equal(status.status, 0);
      assert.equal(status.stdout.trim(), "");
      assert.ok(
        !fs.existsSync(path.join(workspace.directory, "projects/paper-wings")),
      );
      const started = run([
        "job",
        "test-film",
        "start",
        "--kind",
        "typecheck",
        "--json",
      ]);
      assert.equal(started.status, 0, started.stderr + started.stdout);
      job = JSON.parse(started.stdout);
      for (let i = 0; i < 100; i++) {
        const state = JSON.parse(
          run(["job", "test-film", "status", "--id", job.id, "--json"]).stdout,
        );
        if (state.status === "succeeded") {
          job = null;
          break;
        }
        assert.ok(
          !["failed", "unobserved"].includes(state.status),
          JSON.stringify(state),
        );
        await delay(100);
      }
      assert.equal(job, null, "Persistent job did not finish");
    } finally {
      if (job) {
        run(["job", "test-film", "cancel", "--id", job.id]);
        await delay(1500);
      }
      f.close();
    }
  },
);
