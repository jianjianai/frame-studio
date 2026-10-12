import type { Scene, SceneOptions } from "./types";
import type * as THREE from "three";
import type { Application } from "pixi.js";
import { disposeObject } from "./three-assets";
/** Lazy, transparent, manually driven Three adapter. Build owns no independent clock. */
export async function createThreeScene(
  options: SceneOptions,
  build: (
    renderer: THREE.WebGLRenderer,
  ) =>
    | Promise<{
        scene: THREE.Scene;
        camera: THREE.Camera;
        update: (time: number) => void | Promise<void>;
      }>
    | {
        scene: THREE.Scene;
        camera: THREE.Camera;
        update: (time: number) => void | Promise<void>;
      },
): Promise<Scene> {
  const THREE = await import("three");
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(options.width, options.height);
  renderer.setClearColor(0, 0);
  try {
    const { scene, camera, update } = await build(renderer);
    return {
      canvas: renderer.domElement,
      async render(time) {
        await update(time);
        renderer.render(scene, camera);
      },
      dispose() {
        disposeObject(scene);
        renderer.dispose();
        renderer.forceContextLoss();
      },
    };
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
}
/**
 * One Pixi renderer for every Pixi scene of the page. A browser keeps only about 16 WebGL
 * contexts alive and silently drops the oldest beyond that, so a context per layer loses
 * layers in busy pictures. Each scene gets its own stage and canvas; its picture is copied
 * there after rendering. Never destroyed: destroying a renderer also releases Pixi's global
 * pools, which every other scene still uses.
 */
let shared: Promise<Application> | undefined;
function sharedPixi(): Promise<Application> {
  shared ??= (async () => {
    await import("pixi.js/unsafe-eval");
    const { Application } = await import("pixi.js");
    const app = new Application();
    await app.init({
      width: 2,
      height: 2,
      autoStart: false,
      sharedTicker: false,
      antialias: true,
      preserveDrawingBuffer: true,
      backgroundAlpha: 0,
    });
    return app;
  })();
  shared.catch(() => (shared = undefined));
  return shared;
}
/**
 * A Pixi scene: `build(app)` adds its display objects to `app.stage` and returns
 * `update(time)`. `app` is the shared application seen through this scene's own stage:
 * do not destroy it or change the renderer's size or settings.
 */
export async function createPixiScene(
  options: SceneOptions,
  build: (
    app: Application,
  ) =>
    | Promise<(time: number) => void | Promise<void>>
    | ((time: number) => void | Promise<void>),
): Promise<Scene> {
  const app = await sharedPixi();
  const { Container } = await import("pixi.js");
  const fit = () => {
    if (app.renderer.width !== options.width || app.renderer.height !== options.height)
      app.renderer.resize(options.width, options.height, 1);
  };
  fit();
  const stage = new Container();
  const view = Object.create(app, { stage: { value: stage } }) as Application;
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const ctx = canvas.getContext("2d")!;
  try {
    const update = await build(view);
    return {
      canvas,
      async render(time) {
        await update(time);
        fit();
        app.renderer.render({ container: stage, clear: true });
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(app.canvas as HTMLCanvasElement, 0, 0);
      },
      dispose() {
        stage.destroy({ children: true });
        canvas.width = canvas.height = 1;
      },
    };
  } catch (error) {
    stage.destroy({ children: true });
    throw error;
  }
}
