import type { z } from "zod";
import type { GeneratedAudioModule } from "./types";
import { createPcmAudio, type StereoPcm } from "./procedural-audio";

/**
 * Resources: the reusable things of a material library — characters, props, sets, screens,
 * effects, transitions, text layers and sounds — declared next to their code, so the studio
 * can list and preview them and the AI can find them with resources_search / resource_view.
 * The platform reads the declarations without running code: keep title, kind, description,
 * tags, usage, presets and preview sizes literal.
 */
export const RESOURCE_KINDS = {
  character: "角色",
  prop: "物品",
  set: "场景",
  ui: "界面",
  effect: "效果",
  transition: "转场",
  text: "文字",
  sound: "音效",
} as const;
export type ResourceKind = Exclude<keyof typeof RESOURCE_KINDS, "sound">;

export interface ResourcePreview<P> {
  /** Size of the preview canvas, in the units draw() uses. */
  width: number;
  height: number;
  /** Seconds the preview's time slider covers; without it the resource is a still picture. */
  duration?: number;
  /** The moment of thumbnails and of the AI's first look (default: the middle of duration). */
  time?: number;
  /** Fill behind the drawing (default: a light grey). */
  background?: string;
  /** Load what drawing needs (fonts, images) before the first frame. */
  prepare?(): Promise<void> | void;
  draw(ctx: CanvasRenderingContext2D, time: number, params: P): void | Promise<void>;
}

export interface Resource<S extends z.ZodObject = z.ZodObject> {
  kind: ResourceKind;
  title: string;
  /** What it is, when to use it, what to avoid. */
  description?: string;
  tags?: string[];
  /** How a work's code uses it (shown to the AI and copied from the preview). */
  usage?: string;
  /** The adjustable parameters: controls in the preview, the parameter list for the AI. */
  params?: S;
  /** Named parameter sets ("睡衣女主", "雨夜"). */
  presets?: Record<string, Partial<z.input<S>>>;
  preview: ResourcePreview<z.output<S>>;
}

/** One resource; `params` types the `draw` callback. */
export function resource<S extends z.ZodObject = z.ZodObject<{}>>(definition: Resource<S>): Resource<S> {
  return definition;
}
/** `export const resources = defineResources({ kid: resource({ … }), … })`: a module's resources by id. */
export function defineResources<T extends Record<string, Resource<any>>>(resources: T): T {
  return resources;
}

export interface Sound {
  title: string;
  /** Length in seconds: the clip length when it is placed on a track. */
  duration: number;
  /** Seconds from the start to the main hit: place the clip at (event time − hit). */
  hit?: number;
  description?: string;
  tags?: string[];
  make(): StereoPcm | Promise<StereoPcm>;
}

export interface SoundLibrary extends GeneratedAudioModule {
  readonly sounds: Readonly<Record<string, Sound>>;
  readonly sampleRate: number;
}

/**
 * `export default defineSounds(48000, { slam: { title, duration, make } … })`: a library of
 * synthesized sounds. audio.json plays one with a generated source
 * `{ module: "materials/<library>/<file>.ts", trackId: "<sound>" }`; only the sounds a work
 * places are made.
 */
export function defineSounds(sampleRate: number, sounds: Record<string, Sound>): SoundLibrary {
  const audio = createPcmAudio(
    Object.fromEntries(Object.entries(sounds).map(([id, sound]) => [id, () => sound.make()])),
    sampleRate,
    { lazy: true },
  );
  return { ...audio, sounds, sampleRate };
}
