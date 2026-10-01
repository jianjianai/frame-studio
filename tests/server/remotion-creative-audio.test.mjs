import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fixture } from "../mcp/helpers.mjs";
import { command } from "../../server/process.mjs";
import { createRenderSession } from "../../scripts/render-session.mjs";
import { renderRemotionVideo } from "../../scripts/remotion-export.mjs";
import { createExportPlan } from "../../src/engine/export-plan.mjs";
import { readProject } from "../../scripts/project-metadata.mjs";
import { probeMedia, checkedProcess } from "../../scripts/production-media.mjs";

test(
  "native Remotion exports a complete Sampler, Tone sequence/timeline, Signalsmith and pitched-file mix",
  { timeout: 300000 },
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
        "sine=frequency=440:sample_rate=48000:duration=2",
        "-y",
        f.file("public/sample.wav"),
      ]);
      fs.writeFileSync(
        f.file("composition.tsx"),
        'import {AbsoluteFill,useCurrentFrame} from "remotion";export default function Film(){return <AbsoluteFill style={{background:"#123456",color:"white"}}>Creative frame {useCurrentFrame()}</AbsoluteFill>}',
      );
      const notes = [
        { at: 0, note: "C4", duration: 0.4 },
        { at: 0.5, note: "E4", duration: 0.4 },
        { at: 1, note: "G4", duration: 0.8 },
      ];
      fs.writeFileSync(
        f.file("audio.ts"),
        'import {createAudioRack} from "../../src/engine/audio-adapters";import {createSamplerAudio,createToneSequence,createToneTimeline} from "../../src/engine/audio-authoring";import {createSignalsmithAudio} from "../../src/engine/signalsmith-audio";const sample=createSamplerAudio({samples:{A4:"films/test-film/sample.wav"},notes:' +
          JSON.stringify(notes) +
          ",release:.05});const tone=createToneSequence({notes:" +
          JSON.stringify(notes) +
          ',instrument:({Tone})=>new Tone.FMSynth({volume:-18})});const timeline=createToneTimeline({duration:2,build:({Tone})=>{const synth=new Tone.PolySynth(Tone.Synth).toDestination();new Tone.Part((time,note)=>synth.triggerAttackRelease(note,.15,time,.15),[[0,"C5"],[.5,"E5"],[1,"G5"]]).start(0);new Tone.Sequence((time,note)=>synth.triggerAttackRelease(note,.1,time,.1),["C4","G4"],"8n").start(1).stop(1.8);}});const stretch=createSignalsmithAudio({buffers:()=>{const b=new AudioBuffer({length:48000*3,numberOfChannels:1,sampleRate:48000});const a=b.getChannelData(0);for(let i=0;i<a.length;i++)a[i]=.1*Math.sin(i*220/48000*2*Math.PI);return b},schedule:{semitones:7}});export const {generators,createAudio}=createAudioRack({sample,tone,timeline,stretch});',
      );
      const ids = ["sample", "tone", "timeline", "stretch", "file"];
      fs.writeFileSync(
        f.file("audio.json"),
        JSON.stringify({
          schemaVersion: 1,
          sources: ids.map((id) =>
            id === "file"
              ? { id, kind: "file", src: "films/test-film/sample.wav" }
              : {
                  id,
                  kind: "generated",
                  module: id,
                  engine:
                    id === "sample"
                      ? "web-audio"
                      : id === "stretch"
                        ? "signalsmith"
                        : "tone",
                },
          ),
          tracks: ids.map((id) => ({
            id,
            name: id,
            gain: 0.15,
            output: "master",
          })),
          clips: ids.map((id) => ({
            id,
            source: id,
            track: id,
            start: 0,
            duration: 2,
            ...(id === "file" ? { pitch: 12, preservePitch: true } : {}),
          })),
          buses: [],
          master: {
            gain: 0.6,
            processors: [
              {
                type: "tone",
                effect: "Phaser",
                options: { wet: 0.15 },
                tail: 0.5,
              },
            ],
          },
        }),
      );
      fs.writeFileSync(
        f.file("project.ts"),
        fs
          .readFileSync(f.file("project.ts"), "utf8")
          .replace(
            "loadAudio:",
            "loadAudioDocument: () => import('./audio.json'), loadAudio:",
          ),
      );
      const { meta } = readProject(f.file("project.ts"));
      session = await createRenderSession({ root: f.root, width: 320 });
      const page = await session.page("test-film");
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const output = f.file("exports/creative.mp4");
      const plan = createExportPlan({
        duration: meta.duration,
        composition: meta.composition,
        width: 320,
        fps: 12,
        start: 0,
        end: 1,
      });
      await renderRemotionVideo({
        page,
        meta,
        plan,
        output,
        subtitles: false,
        input: session.input("test-film"),
      });
      const probe = await probeMedia(output);
      assert.equal(
        Number(
          probe.streams.find((s) => s.codec_type === "video").nb_read_frames,
        ),
        12,
      );
      assert(probe.streams.some((s) => s.codec_type === "audio"));
      await checkedProcess("ffmpeg", [
        "-v",
        "error",
        "-i",
        output,
        "-f",
        "null",
        "-",
      ]);
      const level = await checkedProcess("ffmpeg", [
        "-hide_banner",
        "-i",
        output,
        "-vn",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ]);
      assert.doesNotMatch(level, /mean_volume: -inf/);
      assert.equal(await page.evaluate(() => window.__FRAME_STUDIO__.getDiagnostics().audio.state), "offline");
      assert.deepEqual(errors, []);
    } finally {
      await session?.close();
      f.close();
    }
  },
);
