import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "../mcp/helpers.mjs";
import { command } from "../../server/process.mjs";
import {
  createRenderSession,
  framePng,
} from "../../scripts/render-session.mjs";
import { renderRemotionVideo } from "../../scripts/remotion-export.mjs";
import { createExportPlan } from "../../src/engine/export-plan.mjs";
import { readProject } from "../../scripts/project-metadata.mjs";
import {
  writeAudio,
  probeMedia,
  checkedProcess,
} from "../../scripts/production-media.mjs";
import { checkProjects } from "../../scripts/check-projects.mjs";

test(
  "Remotion real composition: DOM, Sequence, staticFile, FrameScene, seek and mixed audio export",
  { timeout: 600000 },
  async () => {
    const f = fixture({ browser: true, renderer: "remotion" });
    let session;
    try {
      await command("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=997:sample_rate=48000:duration=2",
        "-y",
        f.file("public/tone.wav"),
      ]);
      await command("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=96x54:rate=12:duration=2",
        "-c:v",
        "libvpx-vp9",
        "-deadline",
        "realtime",
        "-y",
        f.file("public/video.webm"),
      ]);
      fs.writeFileSync(
        f.file("public/image.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#ff0055"/></svg>',
      );
      fs.writeFileSync(
        f.file("layer.ts"),
        'export function createScene({width,height}){const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;return{canvas,render(time){const c=canvas.getContext("2d");c.clearRect(0,0,width,height);c.fillStyle="#00ff88";c.fillRect(time*40,0,30,30)},dispose(){canvas.remove()}}}',
      );
      fs.writeFileSync(
        f.file("composition.tsx"),
        [
          'import {AbsoluteFill,Img,Sequence,staticFile,useCurrentFrame} from "remotion"; import {Audio,Video} from "@remotion/media";',
          'import {FrameScene} from "../../src/engine/remotion-composition";',
          'const load=()=>import("./layer");',
          'export default function Film(){const f=useCurrentFrame();return <AbsoluteFill style={{background:"#102030"}}><FrameScene load={load}/><Sequence from={3}><div data-testid="native-frame" style={{position:"absolute",left:80,top:50,color:"white",fontSize:30}}>Frame {f}</div><Img src={staticFile("image.svg")} style={{position:"absolute",right:0,width:40,height:40}}/></Sequence><Audio src={staticFile("tone.wav")} volume={.25}/><Video src={staticFile("video.webm")} style={{position:"absolute",bottom:0,right:0,width:96,height:54}}/></AbsoluteFill>;}',
        ].join("\n"),
      );
      fs.writeFileSync(
        f.file("project.ts"),
        fs
          .readFileSync(f.file("project.ts"), "utf8")
          .replace(
            '"renderer": "remotion"',
            '"renderer": "remotion", "composition":{"width":320,"height":180}',
          ),
      );
      const report = checkProjects(f.root, {
        project: "test-film",
        strict: true,
      });
      assert.equal(report.errors, 0, JSON.stringify(report));
      const { meta } = readProject(f.file("project.ts"));
      session = await createRenderSession({ root: f.root, width: 320 });
      console.log("Remotion fixture: initializing native + preview");
      const page = await session.page("test-film");
      await page.evaluate(() => window.__FRAME_STUDIO__.frame(0.5, false));
      assert.match(
        await page.locator('[data-testid="native-frame"]').textContent(),
        /Frame 6/,
      );
      const first = await framePng(page, 0.5, false);
      fs.writeFileSync(
        path.join(process.cwd(), ".cache/remotion-native-qa.png"),
        first,
      );
      const { default: sharp } = await import("sharp");
      const green = await sharp(first)
        .extract({ left: 25, top: 5, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer();
      assert.ok(
        green[1] > 200 && green[0] < 60,
        "embedded Canvas first frame must be painted before capture",
      );
      await framePng(page, 1.5, false);
      assert.deepEqual(await framePng(page, 0.5, false), first);
      assert.notDeepEqual(await framePng(page, 0, false), first);
      console.log("Remotion fixture: native still/reverse seek passed");
      const output = f.file("exports/remotion.mp4");
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const plan = createExportPlan({
        duration: meta.duration,
        composition: meta.composition,
        width: 320,
        fps: 24,
        start: 0.27,
        end: 1.77,
      });
      await renderRemotionVideo({
        page,
        meta,
        plan,
        output,
        subtitles: false,
        input: session.input("test-film"),
      });
      await checkedProcess("ffmpeg", [
        "-v",
        "error",
        "-i",
        output,
        "-frames:v",
        "1",
        "-y",
        f.file("exports/first.png"),
      ]);
      const firstPixel = await sharp(f.file("exports/first.png"))
        .extract({ left: 11, top: 5, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer();
      assert.ok(
        firstPixel[1] > 150 && firstPixel[0] < 80,
        "fractional trim keeps the authored source frame at the first output sample",
      );
      const probe = await probeMedia(output);
      assert.equal(
        Number(
          probe.streams.find((s) => s.codec_type === "video").nb_read_frames,
        ),
        36,
      );
      assert.ok(probe.streams.some((s) => s.codec_type === "audio"));
      const mix = f.file("exports/mix.wav");
      await writeAudio(page, mix, 0.25, 1);
      const stat = await checkedProcess("ffmpeg", [
        "-hide_banner",
        "-i",
        mix,
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ]);
      assert.doesNotMatch(stat, /mean_volume: -inf/);
      assert.match(stat, /mean_volume:/);
      console.log(
        "Remotion fixture: video, rate conversion and final audio mix passed",
      );
      await page.close();

      const { createServer } = await import("vite");
      const { projectConfig } =
        await import("../../scripts/project-execution.mjs");
      const { launchBrowser } = await import("../../scripts/browser.mjs");
      const previous = process.env.FRAME_WORK_PREVIEW,
        previousAudio = process.env.FRAME_PREVIEW_AUDIO;
      process.env.FRAME_WORK_PREVIEW = "1";
      process.env.FRAME_PREVIEW_AUDIO = "0";
      let dev, browser;
      try {
        const config = projectConfig(f.root, "test-film");
        dev = await createServer({
          ...config,
          server: { ...config.server, port: 0, strictPort: false },
        });
        await dev.listen();
        browser = await launchBrowser();
        const live = await browser.newPage();
        await live.goto(
          "http://127.0.0.1:" + dev.httpServer.address().port + "/?debug=1",
        );
        await live.waitForFunction(
          () => window.__FRAME_STUDIO__?.ready,
          {},
          { timeout: 90000 },
        );
        const playback = await live.evaluate(async () => {
          const api = window.__FRAME_STUDIO__;
          await api.seek(0.4);
          await api.play();
          await new Promise((r) => setTimeout(r, 300));
          api.pause();
          const time = api.getState().time;
          await new Promise((r) => setTimeout(r, 120));
          return {
            time,
            stopped: api.getState().time,
            diagnostics: api.getDiagnostics(),
          };
        });
        assert.ok(playback.time > 0.4);
        assert.equal(playback.time, playback.stopped);
        console.log("Remotion fixture: live playback and pause passed");
        const exported = await live.evaluate(async () => {
          const { exportWebm } = await import("/src/engine/browser-export.ts");
          const { default: project } =
            await import("/projects/test-film/project.ts");
          const blob = await exportWebm(project, {
            width: 320,
            fps: 12,
            start: 0.25,
            end: 1.25,
            subtitles: false,
            signal: new AbortController().signal,
          });
          return {
            size: blob.size,
            data: Array.from(new Uint8Array(await blob.arrayBuffer())),
          };
        });
        fs.writeFileSync(
          f.file("exports/browser.webm"),
          Buffer.from(exported.data),
        );
        const web = await probeMedia(f.file("exports/browser.webm"));
        assert.equal(
          Number(
            web.streams.find((s) => s.codec_type === "video").nb_read_frames,
          ),
          12,
        );
        assert.ok(web.streams.some((s) => s.codec_type === "audio"));
        console.log("Remotion fixture: browser WebM passed");
        const capture = await live.evaluate(() =>
          window.__FRAME_STUDIO__.captureAt(0.5, { subtitles: false }),
        );
        assert.match(capture.dataURL, /^data:image\/png;base64,/);
        const captureBytes = Buffer.from(
          capture.dataURL.split(",")[1],
          "base64",
        );
        fs.writeFileSync(
          path.join(process.cwd(), ".cache/remotion-qa.png"),
          captureBytes,
        );
        const captureMeta = await sharp(captureBytes).metadata();
        const webGreen = await sharp(captureBytes)
          .extract({
            left: Math.round((captureMeta.width * 25) / 320),
            top: Math.round((captureMeta.height * 5) / 180),
            width: 1,
            height: 1,
          })
          .removeAlpha()
          .raw()
          .toBuffer();
        assert.ok(
          webGreen[1] > 200 && webGreen[0] < 60,
          "browser capture preserves embedded canvas first pixels",
        );
        const { exportProduction } =
          await import("../../scripts/production-export.mjs");
        const formal = await exportProduction(f.root, "test-film", {
          width: 320,
          fps: 12,
          start: 0.25,
          end: 1.25,
          segmentSeconds: 0.5,
        });
        assert.equal(formal.status, "passed");
        const final = await probeMedia(formal.output);
        assert.equal(
          Number(
            final.streams.find((s) => s.codec_type === "video").nb_read_frames,
          ),
          12,
        );
        assert.ok(final.streams.some((s) => s.codec_type === "audio"));
        const resumed = await exportProduction(f.root, "test-film", {
          width: 320,
          fps: 12,
          start: 0.25,
          end: 1.25,
          segmentSeconds: 0.5,
          resume: formal.renderId,
        });
        assert.equal(resumed.status, "passed");
        console.log(
          "Remotion fixture: formal segmented export, final audio and resume passed",
        );
        const { exportAudio } = await import("../../scripts/audio-export.mjs");
        const audioExport = await exportAudio(f.root, "test-film", {
          format: "flac",
          stems: true,
          start: 0.25,
          end: 1.25,
        });
        assert.equal(audioExport.files.length, 3);
        assert.ok(audioExport.files.some((file) => file.engine === "remotion"));
        assert.ok(
          audioExport.files.every(
            (file) => file.analysis.integratedLufs !== "-inf",
          ),
        );
        console.log("Remotion fixture: FLAC mix and Frame/native stems passed");
      } finally {
        await browser?.close();
        await dev?.close();
        if (previous === undefined) delete process.env.FRAME_WORK_PREVIEW;
        else process.env.FRAME_WORK_PREVIEW = previous;
        if (previousAudio === undefined) delete process.env.FRAME_PREVIEW_AUDIO;
        else process.env.FRAME_PREVIEW_AUDIO = previousAudio;
      }
    } finally {
      await session?.close();
      f.close();
    }
  },
);
