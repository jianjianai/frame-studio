import { z } from "zod";
import { compileAudioTracks, audioDocumentSchema, automationSchema } from "./audio-document.mjs";
export type AudioDocument = z.infer<typeof audioDocumentSchema>;
import { rendererIds } from "./adapters.mjs";
import { visualAudioTracks } from "./visual-audio.mjs";
import type { VisualDocument } from "./compositor";
import { ENGINE_PROTOCOL_VERSION } from "./protocol.mjs";
import { compositionSchema } from "./dimensions.mjs";
import { shotIdSchema } from "../contracts/workflow.mjs";
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
  playbackRate: z.number().min(0.05).max(16).optional(),
  phase: z.number().nonnegative().optional(),
  loop: z.number().positive().optional(),
  muted: z.boolean().optional(),
  channel: z.string().optional(), pan: z.number().min(-1).max(1).optional(),
  fadeIn: z.number().nonnegative().optional(), fadeOut: z.number().nonnegative().optional(),
  fadeOffset: z.number().nonnegative().optional(), fadeDuration: z.number().positive().optional(),
  automation: automationSchema.optional(),
};
export const audioTrackSchema = z.discriminatedUnion("kind", [
  z.object({ ...trackTiming, kind: z.literal("file"), src: z.string().min(1) }),
  z.object({ ...trackTiming, kind: z.literal("generated"), module:z.string().optional(), sourceTrackId:z.string().optional() }),
]);
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export const projectSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    title: z.string().min(1),
    subtitle: z.string(),
    description: z.string(),
    renderer: z.enum(rendererIds),
    engineProtocol: z.literal(ENGINE_PROTOCOL_VERSION).optional(),
    composition: compositionSchema.optional(),
    remotion: z.object({ inputProps: z.record(z.string(), z.json()).default({}) }).optional(),
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
        id: shotIdSchema.optional(),
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
    const shotIds = new Set<string>();
    for (const b of p.beats) {
      if (b.id && shotIds.has(b.id)) ctx.addIssue({ code: "custom", message: "镜头 id 不能重复" });
      if (b.id) shotIds.add(b.id);
      if (b.at >= p.duration)
        ctx.addIssue({ code: "custom", message: "镜头标记不能超过片长" });
    }
  });
export type ProjectMeta = z.infer<typeof projectSchema>;
export type Quality = "draft" | "standard" | "high";
export interface SceneOptions {
  onBuffering?: (waiting: boolean) => void;
  width: number;
  height: number;
  quality: Quality;
}
export interface ScenePlayback { time: number; playing: boolean; rate: number; volume: number; muted: boolean }
export interface Scene {
  element?: HTMLElement;
  setSubtitles?(enabled: boolean): void;
  setPlayback?(state: ScenePlayback): void;
  capture?(): Promise<string>;
  canvas: HTMLCanvasElement;
  /** Prepare asynchronous media; renderer serializes requests and aborts stale frames. */
  prepareFrame?(time: number, options: { signal: AbortSignal }): Promise<void>;
  render(time: number): void | Promise<void>;
  dispose(): void;
  /** Optional author-defined controls; these do not change the scene protocol. */
  debug?: {
    parameters(): Record<
      string,
      { value: number; min: number; max: number; step?: number; label?: string }
    >;
    setParameters(values: Record<string, number>): void;
    setOverlay?(enabled: boolean): void;
    diagnostics?(): Record<string, unknown>;
  };
}
export interface SceneModule {
  createScene(options: SceneOptions): Promise<Scene> | Scene;
}
export interface AnimationProject extends ProjectMeta {
  /** Live sessions run source/generators without whole-film preencoding. */
  livePreview?: boolean;
  previewAudioGeneratorRevision?: string;
  previewAudioSources?: Record<string, {
    revision: string; url?: string; originalUrl?: string;
    renditions?: Record<string, string>;
  }>;
  load: () => Promise<SceneModule>;
  loadRemotion?: () => Promise<import('./remotion-composition').RemotionModule>;
  loadAudio?: () => Promise<GeneratedAudioModule>;
  loadVisual?: () => Promise<{default:unknown}>;
  visual?: VisualDocument;
  audioDocument?: AudioDocument;
  loadAudioDocument?: () => Promise<{default:unknown}>;
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
  onError?: (error: Error) => void;
}
export type GeneratedAudioSegmentOptions = Pick<
  GeneratedAudioOptions,
  "trackId" | "context" | "offset" | "duration" | "rate"
> & { signal?: AbortSignal };
export interface GeneratedAudioModule {
  /** Optional preparation before playback starts; never start nodes or a separate clock here. */
  prepareAudio?(context: BaseAudioContext): void | Promise<void>;
  /** Prepare the initial live buffer or the entire requested offline segment. */
  prepareSegment?(options: GeneratedAudioSegmentOptions): void | Promise<void>;
  createAudio(options: GeneratedAudioOptions): {
    dispose(): void;
    /** Initial buffers ready for the shared anchor; must not wait for playback time to advance. */
    ready?: Promise<void>;
  };
  /** Optional project-local registry; ids in audio.json select modules without global state. */
  generators?: Record<string, GeneratedAudioModule>;
  /** Release resources held for this playback/export session. */
  disposeAudio?(context: BaseAudioContext): void;
}
export function projectAudioTracks(
  project: Pick<AnimationProject, "audio" | "audioTracks" | "visual" | "audioDocument">,
): AudioTrack[] {
  return [...(
    project.audioDocument ? compileAudioTracks(project.audioDocument) : project.audioTracks ??
    (project.audio
      ? [{ id: "main", name: "配乐与音效", kind: "file", src: project.audio }]
      : [])
  ), ...(project.audioDocument?.linkedVideo===false?[]:visualAudioTracks(project.visual))];
}
export const assetUrl = (relative: string): string =>
  import.meta.env.BASE_URL + relative.replace(/^\//, "");

/** Live bundles select a cached preview rendition; offline rendering keeps the original. */
export function previewAssetUrl(relative: string, _quality: Quality = "standard"): string {
  return assetUrl(relative);
}
