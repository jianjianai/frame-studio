import {
  Output,
  BufferTarget,
  StreamTarget,
  type StreamTargetChunk,
  WebMOutputFormat,
  CanvasSource,
  AudioBufferSource,
  Quality,
  canEncodeVideo,
  canEncodeAudio,
} from "mediabunny";
import { FrameRenderer } from "./renderer";
import { resolveProject } from "./resolve-project";
import { OfflineAudioRenderer } from "./audio-graph";
import { projectAudioTracks, type AnimationProject } from "./types";
import { createExportPlan } from "./export-plan.mjs";

export interface ExportProgress {
  phase: "preparing" | "rendering" | "finalizing";
  completed: number;
  total: number;
}
export interface BrowserExportOptions {
  width: number;
  fps: number;
  start?: number;
  end?: number;
  subtitles: boolean;
  signal: AbortSignal;
  controls?: Map<string, { gain: number; muted: boolean }>;
  volume?: number;
  onProgress?: (progress: ExportProgress) => void;
  writable?: WritableStream<StreamTargetChunk>;
  onEncoder?: (report: { codec: string; failures: string[] }) => void;
}

/** Own scene, integer frame grid, awaited encoder backpressure, offline audio. */
export async function exportWebm(
  project: AnimationProject,
  options: BrowserExportOptions,
): Promise<Blob | null> {
  project = await resolveProject(project);
  const plan = createExportPlan({
    duration: project.duration,
    composition: project.composition,
    width: options.width,
    fps: options.fps,
    start: options.start,
    end: options.end,
  });
  const { signal } = options;
  signal.throwIfAborted();
  const progress = (phase: ExportProgress["phase"], completed: number) =>
    options.onProgress?.({ phase, completed, total: plan.frames });
  progress("preparing", 0);
  const encoding = {
    width: plan.width,
    height: plan.height,
    frameRate: plan.fps,
    quality: new Quality("very-high"),
    latencyMode: "quality" as const,
    hardwareAcceleration: "prefer-software" as const,
  };
  let codec: "vp9" | "vp8" | undefined;
  const hasAudio = projectAudioTracks(project).length > 0;
  if (
    hasAudio &&
    !(await canEncodeAudio("opus", { sampleRate: 48000, numberOfChannels: 2 }))
  )
    throw new Error("浏览器不支持离线音频编码，请使用命令导出。");
  signal.throwIfAborted();
  const canvas = document.createElement("canvas");
  const renderer = new FrameRenderer(canvas, project);
  const audio = new OfflineAudioRenderer(
    project,
    options.controls,
    options.volume,
  );
  const target = options.writable
    ? new StreamTarget(options.writable, {
        chunked: true,
        chunkSize: 1024 * 1024,
      })
    : new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  // Bound retained encoded data. Raw frames/audio are submitted in small batches.
  target.on("write", ({ end }) => {
    if (!options.writable && end > 256 * 1024 * 1024)
      throw new Error("导出文件超过浏览器 256 MiB 缓存上限，请使用命令导出。");
  });
  const stopAudio = () => audio.dispose();
  signal.addEventListener("abort", stopAudio, { once: true });
  try {
    // Export quality is independent from the preview's draft/standard setting.
    await renderer.init(plan.width, plan.height, "high");
    await document.fonts.ready;
    signal.throwIfAborted();
    const failures: string[] = [];
    for (const candidate of ["vp9", "vp8"] as const) {
      if (!(await canEncodeVideo(candidate, encoding))) {
        failures.push(candidate + ": unsupported");
        continue;
      }
      const trialTarget = new BufferTarget();
      const trial = new Output({
        format: new WebMOutputFormat(),
        target: trialTarget,
      });
      try {
        const video = new CanvasSource(canvas, {
          codec: candidate,
          ...encoding,
        });
        const sound = hasAudio
          ? new AudioBufferSource({
              codec: "opus",
              quality: new Quality({ bitrate: 192000 }),
            })
          : undefined;
        trial.addVideoTrack(video, { frameRate: plan.fps });
        if (sound) trial.addAudioTrack(sound);
        await trial.start();
        const trialFrames = Math.min(3, plan.frames);
        if (sound)
          await sound.add(
            await audio.render(plan.start, trialFrames / plan.fps),
          );
        for (let frame = 0; frame < trialFrames; frame++) {
          signal.throwIfAborted();
          await renderer.render(plan.start + frame / plan.fps, options.subtitles, signal);
          await video.add(frame / plan.fps, 1 / plan.fps);
        }
        video.close();
        sound?.close();
        await trial.finalize();
        if (!trialTarget.buffer?.byteLength)
          throw new Error("Trial encoder produced no media");
        codec = candidate;
        break;
      } catch (error) {
        await trial.cancel().catch(() => {});
        signal.throwIfAborted();
        failures.push(candidate + ": " + String(error));
      }
    }
    if (!codec)
      throw new Error(
        "实际试编码失败，请使用 film export 命令。" + failures.join("; "),
      );
    options.onEncoder?.({ codec, failures });
    const video = new CanvasSource(canvas, { codec, ...encoding });
    const sound = hasAudio
      ? new AudioBufferSource({
          codec: "opus",
          quality: new Quality({ bitrate: 192000 }),
        })
      : undefined;
    output.addVideoTrack(video, { frameRate: plan.fps });
    if (sound) output.addAudioTrack(sound);
    await output.start();
    let audioSamples = 0;
    const totalSamples = Math.round(plan.duration * 48000);
    for (let frame = 0; frame < plan.frames; frame++) {
      signal.throwIfAborted();
      // Interleave audio at one-second boundaries; no film-sized PCM allocation.
      if (sound && frame % plan.fps === 0) {
        const samples = Math.min(48000, totalSamples - audioSamples);
        await sound.add(
          await audio.render(
            plan.start + audioSamples / 48000,
            samples / 48000,
          ),
        );
        audioSamples += samples;
      }
      signal.throwIfAborted();
      await renderer.render(plan.start + frame / plan.fps, options.subtitles, signal);
      await video.add(frame / plan.fps, 1 / plan.fps);
      progress("rendering", frame + 1);
      // Yield to cancellation/progress without using the display refresh clock.
      if (frame % 4 === 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    video.close();
    sound?.close();
    progress("finalizing", plan.frames);
    await output.finalize();
    signal.throwIfAborted();
    if (target instanceof StreamTarget) return null;
    if (!target.buffer?.byteLength) throw new Error("编码器没有生成有效文件");
    return new Blob([target.buffer], { type: "video/webm" });
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", stopAudio);
    audio.dispose();
    renderer.dispose();
    canvas.width = canvas.height = 1;
  }
}
