import {
  Output,
  BufferTarget,
  WebMOutputFormat,
  CanvasSource,
  AudioBufferSource,
  Quality,
  canEncodeVideo,
  canEncodeAudio,
} from "mediabunny";
import { FrameRenderer } from "./renderer";
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
  subtitles: boolean;
  signal: AbortSignal;
  controls?: Map<string, { gain: number; muted: boolean }>;
  volume?: number;
  onProgress?: (progress: ExportProgress) => void;
}

/** Own scene, integer frame grid, awaited encoder backpressure, offline audio. */
export async function exportWebm(
  project: AnimationProject,
  options: BrowserExportOptions,
): Promise<Blob> {
  const plan = createExportPlan({
    duration: project.duration,
    width: options.width,
    fps: options.fps,
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
  };
  let codec: "vp9" | "vp8" | undefined;
  for (const candidate of ["vp9", "vp8"] as const) {
    if (await canEncodeVideo(candidate, encoding)) {
      codec = candidate;
      break;
    }
  }
  if (!codec)
    throw new Error(
      "浏览器不支持此尺寸的逐帧编码，请换用新版 Chrome / Edge 或使用命令导出。",
    );
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
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  // Bound retained encoded data. Raw frames/audio are submitted in small batches.
  target.on("write", ({ end }) => {
    if (end > 256 * 1024 * 1024)
      throw new Error("导出文件超过浏览器 256 MiB 缓存上限，请使用命令导出。");
  });
  const stopAudio = () => audio.dispose();
  signal.addEventListener("abort", stopAudio, { once: true });
  try {
    // Export quality is independent from the preview's draft/standard setting.
    await renderer.init(plan.width, plan.height, "high");
    await document.fonts.ready;
    signal.throwIfAborted();
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
          await audio.render(audioSamples / 48000, samples / 48000),
        );
        audioSamples += samples;
      }
      signal.throwIfAborted();
      renderer.render(frame / plan.fps, options.subtitles);
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
