import type { z } from "zod";
import type * as THREE from "three";
import type { Application } from "pixi.js";
import type { GeneratedAudioModule } from "./types";
import { createPcmAudio, type StereoPcm } from "./procedural-audio";

/**
 * Resources: the reusable things of a material library — characters, props, sets, screens,
 * effects, transitions, text layers and sounds — declared next to their code, so the studio
 * can list and preview them and the AI can find them with resources_search / resource_view.
 * The platform reads the declarations without running code: keep title, kind, description,
 * tags, usage, presets, the preview's engine and sizes literal. A preview draws with Canvas 2D
 * (`draw`) or builds a Three.js or PixiJS scene (`engine` + `build`).
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

interface PreviewBase {
  /** Size of the preview picture (for Canvas 2D: the units draw() uses). */
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
}

/** A resource drawn with Canvas 2D (the default engine). */
export interface CanvasPreview<P> extends PreviewBase {
  engine?: "canvas";
  draw(ctx: CanvasRenderingContext2D, time: number, params: P): void | Promise<void>;
}

/** What a Three.js resource preview shows: like createThreeScene's build. */
export interface ThreeStage {
  scene: THREE.Scene;
  camera: THREE.Camera;
  update?(time: number): void | Promise<void>;
  /** Release what disposeObject(scene) does not (render targets, composers…). */
  dispose?(): void;
}
/**
 * A Three.js resource: `build` makes the scene for one set of parameters (it is built again
 * when they change); `showcase(object, renderer)` lights and frames a single object.
 */
export interface ThreePreview<P> extends PreviewBase {
  engine: "three";
  build(context: { renderer: THREE.WebGLRenderer; params: P; width: number; height: number }): ThreeStage | Promise<ThreeStage>;
}

/**
 * A PixiJS resource: `build` puts its display objects on `app.stage` (a width × height
 * picture) and returns `update(time)`, like createPixiScene's build. Built again when the
 * parameters change.
 */
export interface PixiPreview<P> extends PreviewBase {
  engine: "pixi";
  build(context: { app: Application; params: P; width: number; height: number }): ((time: number) => void | Promise<void>) | Promise<(time: number) => void | Promise<void>>;
}

export type ResourcePreview<P> = CanvasPreview<P> | ThreePreview<P> | PixiPreview<P>;

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
