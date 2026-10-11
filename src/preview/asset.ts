import type * as THREE from "three";
import type { Scene } from "../engine/types";
import { validateLottie } from "../engine/lottie-document.mjs";

/**
 * A media file that the browser cannot show by itself — a 3D model, a Lottie animation, an
 * HDR/EXR panorama, a font — drawn by the engine's own loaders. The workbench shows it in an
 * editor tab and drives it through `window.__FRAME_ASSET__` (same origin); the server renders
 * frames of it headlessly for thumbnails and for the AI (`open` switches files on a warm page).
 */
export type AssetKind = "model" | "lottie" | "environment" | "font";
export interface AssetInfo {
  src: string;
  kind: AssetKind;
  /** Lottie and panoramas: their size in pixels. */
  width?: number;
  height?: number;
  /** Lottie: seconds, frame rate and frames. */
  duration?: number;
  fps?: number;
  frames?: number;
  /** Models: animation clips, and what the model is made of. */
  animations?: { name: string; duration: number }[];
  meshes?: number;
  triangles?: number;
  materials?: number;
  textures?: number;
  skinned?: boolean;
  /** Models: width × height × depth in the model's own units. */
  dimensions?: [number, number, number];
}
export interface AssetFrameOptions {
  /** Seconds into a Lottie or a model animation. */
  time?: number;
  /** Model animation clip by name (default: the first). */
  animation?: string;
  /** Model view: degrees around (0 = front) and above. */
  azimuth?: number;
  elevation?: number;
}
export interface AssetPageApi {
  ready: boolean;
  error?: string;
  info: AssetInfo | null;
  /** Load another file (asset address films/… or materials/…). */
  open(src: string, kind?: AssetKind): Promise<AssetInfo>;
  /** Draw into the visible canvas, fitted to the page (models turn with the mouse). */
  show(options: AssetFrameOptions): Promise<void>;
  /** A frame as a PNG data URL, `width` pixels wide. */
  render(options: AssetFrameOptions & { width?: number }): Promise<string>;
}
declare global {
  interface Window {
    __FRAME_ASSET__?: AssetPageApi;
  }
}

const query = new URLSearchParams(location.search);
(globalThis as { __FRAME_ASSET_BASE__?: string }).__FRAME_ASSET_BASE__ = query.get("assetBase") ?? "/";
const view = document.getElementById("view")!;
const visible = view.querySelector("canvas")!;
const message = document.getElementById("message")!;
const say = (text: string) => {
  message.hidden = !text;
  message.textContent = text;
};
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const kindOfFile = (src: string): AssetKind | null =>
  /\.(glb|gltf|fbx|obj)$/i.test(src) ? "model" : /\.json$/i.test(src) ? "lottie" : /\.(hdr|exr)$/i.test(src) ? "environment" : /\.(ttf|otf|woff2?)$/i.test(src) ? "font" : null;

const BACKDROP = ["#f1f2f4", "#cfd4da"];

/** What is loaded now. */
interface Loaded {
  info: AssetInfo;
  /** Draw a frame `width` × `height` pixels into ctx (backdrop already filled). */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number, options: AssetFrameOptions): Promise<void> | void;
  /** Width / height of its pictures for a given view width / height. */
  aspect(fit: number): number;
  dispose(): void;
}
let loaded: Loaded | null = null;
let gl: { renderer: THREE.WebGLRenderer; lib: typeof THREE } | null = null;
async function webgl() {
  if (!gl) {
    const lib = await import("three");
    const renderer = new lib.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0, 0);
    gl = { renderer, lib };
  }
  return gl;
}

async function openModel(src: string): Promise<Loaded> {
  const { renderer, lib } = await webgl();
  const { loadModel, studioEnvironment, frameObject, disposeObject } = await import("../engine/three-assets");
  const model = await loadModel(src, renderer);
  const scene = new lib.Scene();
  scene.environment = studioEnvironment(renderer);
  scene.add(model.scene);
  const key = new lib.DirectionalLight("#ffffff", 1.2);
  scene.add(key, key.target);
  const camera = new lib.PerspectiveCamera(30, 1, 0.01, 1000);
  let framed = "";
  const mixers = new Map<string, THREE.AnimationMixer>();
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  let meshes = 0;
  let triangles = 0;
  let skinned = false;
  model.scene.traverse((object) => {
    if (!(object instanceof lib.Mesh)) return;
    meshes++;
    if (object instanceof lib.SkinnedMesh) skinned = true;
    const geometry = object.geometry as THREE.BufferGeometry;
    triangles += Math.round((geometry.index?.count ?? geometry.attributes.position?.count ?? 0) / 3);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof lib.Texture) textures.add(value);
    }
  });
  const box = new lib.Box3().setFromObject(model.scene);
  const dimensions = box.isEmpty() ? new lib.Vector3() : box.getSize(new lib.Vector3());
  const round = (value: number) => +value.toPrecision(3);
  return {
    info: {
      src,
      kind: "model",
      animations: model.animations.map((clip) => ({ name: clip.name, duration: +clip.duration.toFixed(3) })),
      meshes,
      triangles,
      materials: materials.size,
      textures: textures.size,
      skinned,
      dimensions: [round(dimensions.x), round(dimensions.y), round(dimensions.z)],
    },
    aspect: (fit) => fit,
    draw(ctx, width, height, options) {
      renderer.setSize(width, height, false);
      renderer.toneMapping = lib.NeutralToneMapping;
      const clip = options.animation ? model.animations.find((item) => item.name === options.animation) : model.animations[0];
      if (options.animation && !clip) throw new Error(`没有动画「${options.animation}」（有：${model.animations.map((item) => item.name).join("、") || "无"}）`);
      for (const mixer of mixers.values()) mixer.stopAllAction();
      let mixer: THREE.AnimationMixer | undefined;
      if (clip) {
        // One mixer per clip, so switching clips starts from a clean pose.
        mixer = mixers.get(clip.name);
        if (!mixer) mixers.set(clip.name, (mixer = new lib.AnimationMixer(model.scene)));
        mixer.clipAction(clip).play();
      }
      // Framed in the clip's first pose: the camera keeps still while the animation plays.
      const shape = `${clip?.name}|${width}x${height}|${options.azimuth}|${options.elevation}`;
      if (framed !== shape) {
        mixer?.setTime(0);
        camera.aspect = width / height;
        const middle = frameObject(camera, model.scene, { azimuth: options.azimuth, elevation: options.elevation });
        const toward = camera.position.clone().sub(middle);
        const side = new lib.Vector3().crossVectors(new lib.Vector3(0, 1, 0), toward).normalize();
        key.position.copy(camera.position).addScaledVector(side, toward.length() * 0.6).add(new lib.Vector3(0, toward.length() * 0.8, 0));
        key.target.position.copy(middle);
        framed = shape;
      }
      mixer?.setTime(options.time ?? 0);
      renderer.render(scene, camera);
      ctx.drawImage(renderer.domElement, 0, 0, width, height);
    },
    dispose() {
      for (const mixer of mixers.values()) mixer.stopAllAction();
      disposeObject(scene);
    },
  };
}

async function openLottie(src: string): Promise<Loaded> {
  const { assetUrl } = await import("../engine/types");
  const { createLottieScene } = await import("../engine/lottie-adapter");
  const response = await fetch(assetUrl(src));
  if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）：${src}`);
  const data = validateLottie(await response.json());
  const duration = (data.op - data.ip) / data.fr;
  // Drawn at its own size (at most 2048 wide), scaled for each picture.
  const fit = Math.min(1, 2048 / Math.max(data.w, data.h));
  const scene: Scene = await createLottieScene({ width: Math.round(data.w * fit), height: Math.round(data.h * fit), quality: "high" }, assetUrl(src));
  return {
    info: { src, kind: "lottie", width: data.w, height: data.h, duration: +duration.toFixed(3), fps: data.fr, frames: Math.round(data.op - data.ip) },
    aspect: () => data.w / data.h,
    async draw(ctx, width, height, options) {
      await scene.render(Math.max(0, Math.min(duration - 1 / data.fr, options.time ?? duration / 2)));
      ctx.drawImage(scene.canvas, 0, 0, width, height);
    },
    dispose: () => scene.dispose(),
  };
}

async function openEnvironment(src: string): Promise<Loaded> {
  const { renderer, lib } = await webgl();
  const { assetUrl } = await import("../engine/types");
  const texture: THREE.Texture = /\.exr$/i.test(src)
    ? await new (await import("three/addons/loaders/EXRLoader.js")).EXRLoader().loadAsync(assetUrl(src))
    : await new (await import("three/addons/loaders/HDRLoader.js")).HDRLoader().loadAsync(assetUrl(src));
  const image = texture.image as { width: number; height: number };
  const scene = new lib.Scene();
  const plane = new lib.Mesh(new lib.PlaneGeometry(2, 1), new lib.MeshBasicMaterial({ map: texture }));
  scene.add(plane);
  const camera = new lib.OrthographicCamera(-1, 1, 0.5, -0.5, -1, 1);
  return {
    info: { src, kind: "environment", width: image.width, height: image.height },
    aspect: () => 2,
    draw(ctx, width, height) {
      renderer.setSize(width, height, false);
      renderer.toneMapping = lib.ACESFilmicToneMapping;
      renderer.render(scene, camera);
      ctx.drawImage(renderer.domElement, 0, 0, width, height);
    },
    dispose() {
      plane.geometry.dispose();
      plane.material.dispose();
      texture.dispose();
    },
  };
}

let fonts = 0;
async function openFont(src: string): Promise<Loaded> {
  const { assetUrl } = await import("../engine/types");
  const family = `frame-asset-${++fonts}`;
  const face = await new FontFace(family, `url(${JSON.stringify(assetUrl(src))})`).load();
  document.fonts.add(face);
  const name = src.split("/").pop()!.replace(/\.[^.]+$/, "");
  const lines: [string, number][] = [
    [name, 0.11],
    ["永和九年，岁在癸丑", 0.15],
    ["The quick brown fox 0123", 0.1],
    ["ABCDEFG abcdefg ！？，。", 0.075],
  ];
  return {
    info: { src, kind: "font" },
    aspect: () => 16 / 9,
    draw(ctx, width, height) {
      ctx.fillStyle = "#1d2127";
      ctx.textBaseline = "alphabetic";
      let y = height * 0.08;
      for (const [text, size] of lines) {
        const px = Math.round(height * size);
        y += px * 1.25;
        ctx.font = `${px}px "${family}"`;
        ctx.fillText(text, width * 0.05, y, width * 0.9);
      }
    },
    dispose: () => void document.fonts.delete(face),
  };
}

/** One drawing at a time: the WebGL renderer and the loaded file are shared. */
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = tail.then(task, task);
  tail = next.catch(() => {});
  return next;
}

async function paint(canvas: HTMLCanvasElement, width: number, height: number, options: AssetFrameOptions) {
  if (!loaded) throw new Error("还没有打开文件");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d")!;
  const backdrop = ctx.createLinearGradient(0, 0, 0, canvas.height);
  backdrop.addColorStop(0, BACKDROP[0]);
  backdrop.addColorStop(1, BACKDROP[1]);
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await loaded.draw(ctx, canvas.width, canvas.height, options);
}

// Turning a model in the editor tab: drag around, the wheel is not used (the tab scrolls).
const turn = { azimuth: 0, elevation: 0 };
let dragging: { x: number; y: number } | null = null;
let shown: AssetFrameOptions | null = null;
const reshow = () => shown && void api.show(shown).catch(() => {});
visible.addEventListener("pointerdown", (event) => {
  if (loaded?.info.kind !== "model") return;
  dragging = { x: event.clientX, y: event.clientY };
  visible.setPointerCapture(event.pointerId);
  visible.style.cursor = "grabbing";
});
visible.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  turn.azimuth -= (event.clientX - dragging.x) * 0.5;
  turn.elevation = Math.max(-85, Math.min(85, turn.elevation + (event.clientY - dragging.y) * 0.5));
  dragging = { x: event.clientX, y: event.clientY };
  reshow();
});
visible.addEventListener("pointerup", () => {
  dragging = null;
  if (loaded?.info.kind === "model") visible.style.cursor = "grab";
});
visible.addEventListener("dblclick", () => {
  Object.assign(turn, { azimuth: 0, elevation: 0 });
  reshow();
});
let refit = 0;
addEventListener("resize", () => {
  cancelAnimationFrame(refit);
  refit = requestAnimationFrame(reshow);
});

const api: AssetPageApi = {
  ready: false,
  info: null,
  open(src, kind) {
    return serial(async () => {
      const type = kind ?? kindOfFile(src);
      if (!type) throw new Error(`不能在这里预览这种文件：${src}`);
      loaded?.dispose();
      loaded = null;
      api.info = null;
      loaded = await (type === "model" ? openModel(src) : type === "lottie" ? openLottie(src) : type === "environment" ? openEnvironment(src) : openFont(src));
      Object.assign(turn, { azimuth: 0, elevation: 0 });
      visible.style.cursor = type === "model" ? "grab" : "";
      api.info = loaded.info;
      return loaded.info;
    });
  },
  show(options) {
    shown = options;
    return serial(async () => {
      if (!loaded) return;
      const ratio = devicePixelRatio || 1;
      const aspect = loaded.aspect(view.clientWidth / Math.max(1, view.clientHeight));
      const width = Math.max(1, Math.min(view.clientWidth, view.clientHeight * aspect));
      visible.style.width = Math.round(width) + "px";
      visible.style.height = Math.round(width / aspect) + "px";
      const look = loaded.info.kind === "model" ? { azimuth: (options.azimuth ?? 20) + turn.azimuth, elevation: (options.elevation ?? 10) + turn.elevation } : {};
      try {
        await paint(visible, width * ratio, (width / aspect) * ratio, { ...options, ...look });
        say("");
      } catch (error) {
        say(messageOf(error));
        throw error;
      }
    });
  },
  render({ width = 640, ...options }) {
    return serial(async () => {
      if (!loaded) throw new Error("还没有打开文件");
      const canvas = document.createElement("canvas");
      await paint(canvas, width, width / loaded.aspect(4 / 3), options);
      return canvas.toDataURL("image/png");
    });
  },
};
window.__FRAME_ASSET__ = api;
addEventListener("error", (event) => say("运行错误：" + event.message));
addEventListener("unhandledrejection", (event) => say("运行错误：" + messageOf(event.reason)));
const first = query.get("src");
try {
  if (first) await api.open(first, (query.get("kind") as AssetKind | null) ?? undefined);
  api.ready = true;
} catch (error) {
  api.error = messageOf(error);
  say("无法打开 " + first + "：" + api.error);
}
