import { z } from "zod";
import { compileAudioTracks, audioDocumentSchema, automationSchema, stretchOptionsSchema } from "./audio-document.mjs";
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
  pitch: z.number().min(-48).max(48).optional(),
  preservePitch: z.boolean().optional(),
  stretch: stretchOptionsSchema.optional(),
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
    duration: z.number().positive().max(3600),
    fps: z.number().int().min(12).max(60),
    accent: z.string(),
    /** Cover image (films/<slug>/...). Without it the cover is a frame of the work: at posterTime, or picked automatically. */
    poster: z.string().optional(),
    posterTime: z.number().nonnegative().optional(),
    tags: z.array(z.string()),
    status: z.enum(["demo", "draft", "film"]).default("demo"),
    /** Set by FRAME Studio when the work is published: it is then view-only. */
    publishedAt: z.string().optional(),
    /** The experience libraries the work follows (names), managed by FRAME Studio. */
    experiences: z.array(z.string()).optional(),
    /** The material libraries the work uses files from (names); see materials.lock.json. */
    materials: z.array(z.string()).optional(),
    /** The music's beat grid in work time; library code reads it through ./tempo. */
    tempo: z
      .object({
        bpm: z.number().min(20).max(400),
        firstBeat: z.number().nonnegative().default(0),
        beatsPerBar: z.number().int().min(1).max(16).default(4),
      })
      .optional(),
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
export interface Scene {
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
  load: () => Promise<SceneModule>;
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
  /** Independent semitone transpose; generators should honor or explicitly reject. */
  pitch?: number;
  preservePitch?: boolean;
  stretch?: z.infer<typeof stretchOptionsSchema>;
  onError?: (error: Error) => void;
}
export type GeneratedAudioSegmentOptions = Pick<
  GeneratedAudioOptions,
  "trackId" | "context" | "offset" | "duration" | "rate" | "pitch" | "preservePitch" | "stretch"
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
/** Playable tracks: the audio.json mix plus the sound of video layers (unless unlinked). */
export function projectAudioTracks(project: Pick<AnimationProject, "visual" | "audioDocument">): AudioTrack[] {
  return [
    ...(project.audioDocument ? compileAudioTracks(project.audioDocument) : []),
    ...(project.audioDocument?.linkedVideo === false ? [] : visualAudioTracks(project.visual)),
  ];
}
/** Each previewed work sets its own asset base; builds fall back to the Vite base URL. */
export const assetUrl = (relative: string): string =>
  ((globalThis as { __FRAME_ASSET_BASE__?: string }).__FRAME_ASSET_BASE__ ?? import.meta.env.BASE_URL) +
  relative.replace(/^\//, "");

