import { z } from "zod";
export const subtitleSchema = z
  .object({
    start: z.number().nonnegative(),
    end: z.number().positive(),
    text: z.string().min(1),
  })
  .refine((s) => s.end > s.start, "字幕结束时间必须晚于开始时间");
const trackTiming = {
  id: z.string().min(1),
  name: z.string().min(1),
  start: z.number().nonnegative().optional(),
  offset: z.number().nonnegative().optional(),
  duration: z.number().positive().optional(),
  gain: z.number().min(0).max(4).optional(),
  muted: z.boolean().optional(),
};
export const audioTrackSchema = z.discriminatedUnion("kind", [
  z.object({ ...trackTiming, kind: z.literal("file"), src: z.string().min(1) }),
  z.object({ ...trackTiming, kind: z.literal("generated") }),
]);
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export const projectSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    title: z.string().min(1),
    subtitle: z.string(),
    description: z.string(),
    renderer: z.enum(["pixi", "three", "canvas"]),
    duration: z.number().positive().max(3600),
    fps: z.number().int().min(12).max(60),
    accent: z.string(),
    poster: z.string(),
    posterTime: z.number().nonnegative().optional(),
    audio: z.string().optional(),
    audioTracks: z.array(audioTrackSchema).max(32).optional(),
    tags: z.array(z.string()),
    status: z.enum(["demo", "draft", "film"]).default("demo"),
    beats: z.array(
      z.object({
        at: z.number().nonnegative(),
        title: z.string(),
        detail: z.string(),
      }),
    ),
    subtitles: z.array(subtitleSchema),
    credits: z.array(z.string()),
  })
  .superRefine((p, ctx) => {
    if (p.posterTime !== undefined && p.posterTime >= p.duration)
      ctx.addIssue({ code: "custom", message: "封面时间不能超过片长" });
    if (p.audio && p.audioTracks?.length)
      ctx.addIssue({
        code: "custom",
        message: "audio 与 audioTracks 不能同时配置",
      });
    const ids = new Set<string>();
    for (const track of p.audioTracks ?? []) {
      if (
        ids.has(track.id) ||
        (track.start ?? 0) >= p.duration ||
        (track.start ?? 0) +
          (track.duration ?? p.duration - (track.start ?? 0)) >
          p.duration
      )
        ctx.addIssue({ code: "custom", message: "音轨 id 重复或时间超出片长" });
      ids.add(track.id);
    }
    for (const s of p.subtitles)
      if (s.end > p.duration)
        ctx.addIssue({ code: "custom", message: "字幕不能超过片长" });
    for (const b of p.beats)
      if (b.at >= p.duration)
        ctx.addIssue({ code: "custom", message: "镜头标记不能超过片长" });
  });
export type ProjectMeta = z.infer<typeof projectSchema>;
export type Quality = "draft" | "standard" | "high";
export interface SceneOptions {
  width: number;
  height: number;
  quality: Quality;
}
export interface Scene {
  canvas: HTMLCanvasElement;
  render(time: number): void;
  dispose(): void;
}
export interface SceneModule {
  createScene(options: SceneOptions): Promise<Scene> | Scene;
}
export interface AnimationProject extends ProjectMeta {
  load: () => Promise<SceneModule>;
  loadAudio?: () => Promise<GeneratedAudioModule>;
}
/** Schedule this source-time segment and release every owned node on dispose. */
export interface GeneratedAudioOptions {
  trackId: string;
  context: BaseAudioContext;
  destination: AudioNode;
  when: number;
  offset: number;
  duration: number;
  rate: number;
}
export interface GeneratedAudioModule {
  createAudio(options: GeneratedAudioOptions): { dispose(): void };
}
export function projectAudioTracks(
  project: Pick<AnimationProject, "audio" | "audioTracks">,
): AudioTrack[] {
  return (
    project.audioTracks ??
    (project.audio
      ? [{ id: "main", name: "配乐与音效", kind: "file", src: project.audio }]
      : [])
  );
}
export const assetUrl = (relative: string): string =>
  import.meta.env.BASE_URL + relative.replace(/^\//, "");
