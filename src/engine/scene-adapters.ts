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
export async function createPixiScene(
  options: SceneOptions,
  build: (
    app: Application,
  ) =>
    | Promise<(time: number) => void | Promise<void>>
    | ((time: number) => void | Promise<void>),
): Promise<Scene> {
  await import("pixi.js/unsafe-eval");
  const { Application } = await import("pixi.js");
  const app = new Application();
  try {
    await app.init({
      width: options.width,
      height: options.height,
      autoStart: false,
      sharedTicker: false,
      antialias: true,
      preserveDrawingBuffer: true,
      backgroundAlpha: 0,
    });
    const update = await build(app);
    return {
      canvas: app.canvas as HTMLCanvasElement,
      async render(time) {
        await update(time);
        app.renderer.render(app.stage);
      },
      dispose() {
        app.destroy(true, { children: true });
      },
    };
  } catch (error) {
    if (app.renderer) app.destroy(true, { children: true });
    throw error;
  }
}
