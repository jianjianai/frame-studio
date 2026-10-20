import { z } from "zod";
import type * as THREE from "three";
import type { Application } from "pixi.js";
import { setTempo } from "../engine/tempo";
import { importMaterial, setMaterialBase } from "../engine/materials";
import type { Resource, SoundLibrary, ThreePreview, ThreeStage, PixiPreview } from "../engine/resources";

// Parameter errors are read by Chinese-speaking users and AIs: zod's messages in Chinese.
z.config(z.locales.zhCN());

/**
 * Preview of one material library module's resources and sounds, as the library has it now
 * (never a work's locked versions), with a work's tempo. The workbench shows it in an editor tab and
 * drives it through `window.__FRAME_RESOURCE__` (same origin); the server renders frames of
 * it headlessly for thumbnails and for the AI.
 */
export interface ResourceInfo {
  key: string;
  kind: string;
  /** canvas, three or pixi */
  engine: string;
  title: string;
  description?: string;
  usage?: string;
  width: number;
  height: number;
  duration: number;
  time: number;
  background: string;
  /** JSON schema of the parameters (input side: fields with defaults are optional). */
  schema: Record<string, unknown> | null;
  presets: Record<string, Record<string, unknown>>;
  defaults: Record<string, unknown>;
}
export interface SoundInfo {
  key: string;
  title: string;
  duration: number;
  hit?: number;
  description?: string;
}
export interface ResourceFrameOptions {
  preset?: string;
  values?: Record<string, unknown>;
  time?: number;
}
export interface ResourcePageApi {
  ready: boolean;
  error?: string;
  resources: ResourceInfo[];
  sounds: SoundInfo[];
  /** Draw a resource into the visible canvas, fitted to the page. */
  show(key: string, options: ResourceFrameOptions): Promise<void>;
  /** A frame as a PNG data URL, `width` pixels wide. */
  render(key: string, options: ResourceFrameOptions & { width?: number }): Promise<string>;
  /** Show a sound's waveform in the visible canvas. */
  showSound(key: string): Promise<void>;
  /** Play a sound; resolves to its length in seconds. */
  play(key: string): Promise<number>;
  stop(): void;
}
declare global {
  interface Window {
    __FRAME_RESOURCE__?: ResourcePageApi;
  }
}

const query = new URLSearchParams(location.search);
const material = query.get("material") ?? "";
(globalThis as { __FRAME_ASSET_BASE__?: string }).__FRAME_ASSET_BASE__ = query.get("assetBase") ?? "/";
setMaterialBase(query.get("materialBase") ?? "", Number(query.get("stamp")) || undefined);
try {
  setTempo(JSON.parse(query.get("tempo") || "null") ?? undefined);
} catch {
  setTempo();
}

const view = document.getElementById("view")!;
const visible = view.querySelector("canvas")!;
const message = document.getElementById("message")!;
const say = (text: string) => {
  message.hidden = !text;
  message.textContent = text;
};
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

let resources: Record<string, Resource> = {};
let sounds: SoundLibrary | null = null;
const prepared = new Map<string, Promise<void>>();
const pcm = new Map<string, Promise<[Float32Array, Float32Array]>>();

const api: ResourcePageApi = {
  ready: false,
  resources: [],
  sounds: [],
  show(key, options) {
    const resource = find(key);
    shown = () => api.show(key, options);
    if (key !== orbit.key) Object.assign(orbit, { key, azimuth: 0, elevation: 0, zoom: 1 });
    visible.style.cursor = resource.preview.engine === "three" ? "grab" : "";
    return serial(async () => {
      const ratio = devicePixelRatio || 1;
      const fit = Math.min(view.clientWidth / resource.preview.width, view.clientHeight / resource.preview.height);
      const width = Math.max(1, Math.round(resource.preview.width * fit));
      visible.style.width = width + "px";
      visible.style.height = Math.round(resource.preview.height * fit) + "px";
      try {
        await draw(visible, resource, options, width * ratio, true);
        say("");
      } catch (error) {
        say(messageOf(error));
        throw error;
      }
    });
  },
  render(key, { width = 640, ...options }) {
    return serial(async () => {
      const canvas = document.createElement("canvas");
      await draw(canvas, find(key), options, width, false);
      return canvas.toDataURL("image/png");
    });
  },
  async showSound(key) {
    const sound = soundOf(key);
    shown = () => api.showSound(key);
    const [left, right] = await samples(key);
    const ratio = devicePixelRatio || 1;
    const width = Math.max(320, Math.min(view.clientWidth - 24, 1200));
    const height = Math.min(260, Math.max(120, view.clientHeight - 24));
    visible.style.width = width + "px";
    visible.style.height = height + "px";
    visible.width = Math.round(width * ratio);
    visible.height = Math.round(height * ratio);
    const ctx = visible.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#1d2127";
    ctx.fillRect(0, 0, width, height);
    const mid = height / 2;
    ctx.fillStyle = "#7aa2f7";
    const step = left.length / width;
    for (let x = 0; x < width; x++) {
      let peak = 0;
      for (let i = Math.floor(x * step); i < Math.min(left.length, Math.floor((x + 1) * step)); i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
      const h = Math.min(1, peak) * (mid - 6);
      ctx.fillRect(x, mid - h, 1, Math.max(1, h * 2));
    }
    const seconds = left.length / (sounds?.sampleRate ?? 48000);
    if (sound.hit !== undefined) {
      ctx.fillStyle = "#f7768e";
      ctx.fillRect((sound.hit / seconds) * width, 0, 2, height);
    }
    ctx.fillStyle = "rgb(255 255 255 / 0.6)";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(`${seconds.toFixed(2)} 秒${sound.hit !== undefined ? ` · 重音 ${sound.hit} 秒` : ""}`, 8, 16);
    say("");
  },
  async play(key) {
    api.stop();
    const [left, right] = await samples(key);
    const context = (audio ??= new AudioContext());
    await context.resume();
    const buffer = context.createBuffer(2, left.length, sounds?.sampleRate ?? 48000);
    buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    // Hand the output device back between sounds (see AudioTransport.release).
    source.onended = () => {
      if (playing !== source) return;
      playing = null;
      void context.suspend();
    };
    source.start();
    playing = source;
    return buffer.duration;
  },
  stop() {
    if (!playing) return;
    playing.onended = null;
    try {
      playing.stop();
    } catch {}
    playing = null;
    void audio?.suspend();
  },
};
let audio: AudioContext | null = null;
let playing: AudioBufferSourceNode | null = null;

// The editor panel or the window changed size: fit what is shown again.
let shown: (() => Promise<void>) | null = null;
let refit = 0;
addEventListener("resize", () => {
  cancelAnimationFrame(refit);
  refit = requestAnimationFrame(() => void shown?.().catch(() => {}));
});

/** One drawing at a time: three and pixi scenes are shared by every request of the page. */
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = tail.then(task, task);
  tail = next.catch(() => {});
  return next;
}

/**
 * Looking around a three resource in the editor tab: drag turns the camera about the scene's
 * middle, the wheel moves it closer, a double click puts it back. Pictures for thumbnails and
 * the AI never use it.
 */
const orbit = { key: "", azimuth: 0, elevation: 0, zoom: 1 };
let dragging: { x: number; y: number } | null = null;
const redraw = () => void shown?.().catch(() => {});
visible.addEventListener("pointerdown", (event) => {
  if (visible.style.cursor !== "grab" && visible.style.cursor !== "grabbing") return;
  dragging = { x: event.clientX, y: event.clientY };
  visible.setPointerCapture(event.pointerId);
  visible.style.cursor = "grabbing";
});
visible.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  orbit.azimuth -= (event.clientX - dragging.x) * 0.01;
  orbit.elevation = Math.max(-1.5, Math.min(1.5, orbit.elevation + (event.clientY - dragging.y) * 0.01));
  dragging = { x: event.clientX, y: event.clientY };
  redraw();
});
visible.addEventListener("pointerup", () => {
  if (!dragging) return;
  dragging = null;
  visible.style.cursor = "grab";
});
visible.addEventListener(
  "wheel",
  (event) => {
    if (visible.style.cursor !== "grab") return;
    event.preventDefault();
    orbit.zoom = Math.max(0.2, Math.min(5, orbit.zoom * Math.exp(event.deltaY * 0.001)));
    redraw();
  },
  { passive: false },
);
visible.addEventListener("dblclick", () => {
  Object.assign(orbit, { azimuth: 0, elevation: 0, zoom: 1 });
  redraw();
});

/** The three scene of the resource and parameters shown last (built again when they change). */
let three: { renderer: THREE.WebGLRenderer; lib: typeof THREE; built?: { id: string; stage: ThreeStage; middle: THREE.Vector3 } } | null = null;
async function drawThree(preview: ThreePreview<unknown>, id: string, params: unknown, time: number, width: number, height: number, look: boolean) {
  if (!three) {
    const lib = await import("three");
    const renderer = new lib.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    three = { renderer, lib };
  }
  const { renderer, lib } = three;
  renderer.setSize(width, height, false);
  if (three.built?.id !== id) {
    disposeThree();
    // A build may change the renderer's settings; the next one starts from the defaults.
    renderer.toneMapping = lib.NoToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = lib.SRGBColorSpace;
    renderer.shadowMap.enabled = false;
    renderer.setClearColor(0, 0);
    const stage = await preview.build({ renderer, params, width: preview.width, height: preview.height });
    const middle = new lib.Box3().setFromObject(stage.scene).getCenter(new lib.Vector3());
    three.built = { id, stage, middle };
  }
  const { stage, middle } = three.built!;
  await stage.update?.(time);
  const camera = stage.camera;
  const moved = look && (orbit.azimuth || orbit.elevation || orbit.zoom !== 1);
  const position = camera.position.clone();
  const quaternion = camera.quaternion.clone();
  if (moved) {
    const offset = new lib.Spherical().setFromVector3(camera.position.clone().sub(middle));
    offset.theta += orbit.azimuth;
    offset.phi = Math.max(0.01, Math.min(Math.PI - 0.01, offset.phi - orbit.elevation));
    offset.radius *= orbit.zoom;
    camera.position.copy(middle).add(new lib.Vector3().setFromSpherical(offset));
    camera.lookAt(middle);
  }
  renderer.render(stage.scene, camera);
  // The resource's own camera stays as its update left it.
  camera.position.copy(position);
  camera.quaternion.copy(quaternion);
  return renderer.domElement;
}
function disposeThree() {
  if (!three?.built) return;
  const { stage } = three.built;
  three.built = undefined;
  try {
    stage.dispose?.();
  } finally {
    void import("../engine/three-assets").then(({ disposeObject }) => disposeObject(stage.scene));
  }
}

/** The pixi application of the resource and parameters shown last. */
let pixi: { app: Application; built?: { id: string; update: (time: number) => void | Promise<void> } } | null = null;
async function drawPixi(preview: PixiPreview<unknown>, id: string, params: unknown, time: number, scale: number) {
  if (!pixi) {
    await import("pixi.js/unsafe-eval");
    const { Application } = await import("pixi.js");
    const app = new Application();
    await app.init({ width: preview.width, height: preview.height, autoStart: false, sharedTicker: false, antialias: true, preserveDrawingBuffer: true, backgroundAlpha: 0 });
    pixi = { app };
  }
  const { app } = pixi;
  app.renderer.resize(preview.width, preview.height, scale);
  if (pixi.built?.id !== id) {
    pixi.built = undefined;
    for (const child of app.stage.removeChildren()) child.destroy({ children: true });
    pixi.built = { id, update: await preview.build({ app, params, width: preview.width, height: preview.height }) };
  }
  await pixi.built!.update(time);
  app.renderer.render(app.stage);
  return app.canvas as HTMLCanvasElement;
}

function find(key: string) {
  const resource = resources[key];
  if (!resource) throw new Error(`materials/${material} 里没有资源 ${key}（有：${Object.keys(resources).join("、") || "无"}）`);
  return resource;
}
function soundOf(key: string) {
  const sound = sounds?.sounds[key];
  if (!sound) throw new Error(`materials/${material} 里没有音效 ${key}`);
  return sound;
}
function samples(key: string) {
  if (!pcm.has(key)) {
    const pending = Promise.resolve(soundOf(key).make());
    pending.catch(() => pcm.delete(key));
    pcm.set(key, pending);
  }
  return pcm.get(key)!;
}

/** Parameters: the preset, then the given values, checked and completed by the schema. */
function valuesOf(resource: Resource, { preset, values }: ResourceFrameOptions) {
  const base = preset ? resource.presets?.[preset] : undefined;
  if (preset && !base) throw new Error(`没有预设「${preset}」（有：${Object.keys(resource.presets ?? {}).join("、") || "无"}）`);
  const merged = { ...(base ?? {}), ...(values ?? {}) };
  if (!resource.params) return merged;
  const parsed = resource.params.safeParse(merged);
  if (!parsed.success) throw new Error("参数无效：" + parsed.error.issues.map((issue) => `${issue.path.join(".") || "(参数)"} ${issue.message}`).join("；"));
  return parsed.data;
}

/** Draw a resource into a canvas `pixels` wide; `look`: the tab's view, turned by the user. */
async function draw(canvas: HTMLCanvasElement, resource: Resource, options: ResourceFrameOptions, pixels: number, look: boolean) {
  const { preview } = resource;
  const key = Object.keys(resources).find((name) => resources[name] === resource)!;
  if (!prepared.has(key)) {
    const pending = Promise.resolve(preview.prepare?.());
    pending.catch(() => prepared.delete(key));
    prepared.set(key, pending);
  }
  await prepared.get(key);
  await document.fonts.ready;
  const values = valuesOf(resource, options);
  const scale = pixels / preview.width;
  const width = Math.max(1, Math.round(preview.width * scale));
  const height = Math.max(1, Math.round(preview.height * scale));
  const time = options.time ?? preview.time ?? (preview.duration ? preview.duration / 2 : 0);
  // A scene is built per resource and parameter set, and only drawn again for another time.
  const id = `${key}|${JSON.stringify(values)}`;
  const picture =
    preview.engine === "three"
      ? await drawThree(preview, id, values, time, width, height, look)
      : preview.engine === "pixi"
        ? await drawPixi(preview, id, values, time, scale)
        : null;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = preview.background ?? "#e9e6df";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (picture) {
    ctx.drawImage(picture, 0, 0, width, height);
    return;
  }
  ctx.save();
  ctx.scale(scale, scale);
  try {
    if (!("draw" in preview)) throw new Error(`预览没有 draw（engine 只能是 canvas、three 或 pixi）`);
    await preview.draw(ctx, time, values as never);
  } finally {
    ctx.restore();
  }
}

function describe(key: string, resource: Resource): ResourceInfo {
  const { preview } = resource;
  let schema: Record<string, unknown> | null = null;
  let defaults: Record<string, unknown> = {};
  if (resource.params) {
    schema = z.toJSONSchema(resource.params, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    const parsed = resource.params.safeParse({});
    if (parsed.success) defaults = parsed.data as Record<string, unknown>;
  }
  return {
    key,
    kind: resource.kind,
    engine: preview.engine ?? "canvas",
    title: resource.title,
    description: resource.description,
    usage: resource.usage,
    width: preview.width,
    height: preview.height,
    duration: preview.duration ?? 0,
    time: preview.time ?? (preview.duration ? preview.duration / 2 : 0),
    background: preview.background ?? "#e9e6df",
    schema,
    presets: (resource.presets ?? {}) as Record<string, Record<string, unknown>>,
    defaults,
  };
}

window.__FRAME_RESOURCE__ = api;
addEventListener("error", (event) => say("运行错误：" + event.message));
addEventListener("unhandledrejection", (event) => say("运行错误：" + messageOf(event.reason)));
try {
  const mod = await importMaterial<{ resources?: Record<string, Resource>; default?: SoundLibrary }>("materials/" + material);
  resources = mod.resources ?? {};
  if (mod.default && typeof mod.default === "object" && "sounds" in mod.default) sounds = mod.default;
  api.resources = Object.entries(resources).map(([key, resource]) => describe(key, resource));
  api.sounds = Object.entries(sounds?.sounds ?? {}).map(([key, sound]) => ({ key, title: sound.title, duration: sound.duration, hit: sound.hit, description: sound.description }));
  api.ready = true;
} catch (error) {
  api.error = messageOf(error);
  say("无法加载 materials/" + material + "：" + api.error);
}
