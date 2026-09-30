import { Sequence } from "remotion";
import { Audio } from "@remotion/media";
import { remotionConfig, withFrameSubtitles } from "./remotion-composition";
import { OfflineAudioRenderer } from "./audio-graph";
import { projectAudioTracks, type AnimationProject } from "./types";
import type { BrowserExportOptions } from "./browser-export";
import { createExportPlan } from "./export-plan.mjs";

function wav(buffer: AudioBuffer) {
  const data = new ArrayBuffer(44 + buffer.length * 4),
    view = new DataView(data);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, data.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 192000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, data.byteLength - 44, true);
  for (let i = 0; i < buffer.length; i++)
    for (let c = 0; c < 2; c++)
      view.setInt16(
        44 + i * 4 + c * 2,
        Math.round(
          Math.max(-1, Math.min(1, buffer.getChannelData(c)[i])) * 32767,
        ),
        true,
      );
  return new Blob([data], { type: "audio/wav" });
}
export async function exportRemotionWebm(
  project: AnimationProject,
  options: BrowserExportOptions,
): Promise<Blob | null> {
  const { renderMediaOnWeb } = await import("@remotion/web-renderer");
  if (!project.loadRemotion) throw Error("Missing Remotion component");
  const plan = createExportPlan({
    duration: project.duration,
    composition: project.composition,
    width: options.width,
    fps: options.fps,
    start: options.start,
    end: options.end,
  });
  // Native compositions use an authored frame grid. A different FPS is supported by server export.
  if (options.fps !== project.fps)
    throw Error(
      "Remotion 浏览器导出请使用工程帧率 " +
        project.fps +
        "；转换帧率请使用 film render 或服务端导出。",
    );
  const { default: Component } = await project.loadRemotion();
  const Content = withFrameSubtitles(Component, project, options.subtitles);
  const audio = new OfflineAudioRenderer(
    project,
    options.controls,
    options.volume,
  );
  const chunks: { src: string; from: number; duration: number }[] = [];
  try {
    if (projectAudioTracks(project).length) {
      // Bounded chunks; no full-length floating point audio buffer.
      if (plan.duration * 192000 > 128 * 1024 * 1024)
        throw Error("混音超过浏览器 128 MiB 缓存上限，请使用服务端导出。");
      const first = Math.floor(plan.start * project.fps + 1e-7);
      for (let f = first; f < first + plan.frames; f += project.fps * 10) {
        options.signal.throwIfAborted();
        const frames = Math.min(project.fps * 10, first + plan.frames - f);
        const buffer = await audio.render(
          f / project.fps,
          frames / project.fps,
        );
        chunks.push({
          src: URL.createObjectURL(wav(buffer)),
          from: f,
          duration: frames,
        });
      }
    }
    const Film = (props: Record<string, unknown>) => (
      <>
        <Content {...props} />
        {chunks.map((c) => (
          <Sequence key={c.from} from={c.from} durationInFrames={c.duration}>
            <Audio src={c.src} />
          </Sequence>
        ))}
      </>
    );
    const result = await renderMediaOnWeb({
      composition: { ...remotionConfig(project), component: Film },
      inputProps: project.remotion?.inputProps ?? {},
      scale: plan.width / remotionConfig(project).width,
      container: "webm",
      videoCodec: "vp8",
      audioCodec: "opus",
      frameRange: [
        Math.floor(plan.start * project.fps + 1e-7),
        Math.floor(plan.start * project.fps + 1e-7) + plan.frames - 1,
      ],
      signal: options.signal,
      outputWritable: options.writable ?? null,
      onProgress: ({ encodedFrames }) =>
        options.onProgress?.({
          phase: "rendering",
          completed: encodedFrames,
          total: plan.frames,
        }),
    });
    options.signal.throwIfAborted();
    return options.writable ? null : await result.getBlob();
  } finally {
    audio.dispose();
    for (const c of chunks) URL.revokeObjectURL(c.src);
  }
}
