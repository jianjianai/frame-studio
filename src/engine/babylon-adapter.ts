import {
  Engine,
  Scene as BabylonScene,
  type AbstractEngine,
} from "@babylonjs/core";
import type { Scene, SceneOptions } from "./types";
/** The author updates all animated state from absolute seconds. No runRenderLoop. */
export async function createBabylonScene(
  options: SceneOptions,
  build: (
    engine: AbstractEngine,
    canvas: HTMLCanvasElement,
  ) =>
    | Promise<{ scene: BabylonScene; update: (time: number) => void }>
    | { scene: BabylonScene; update: (time: number) => void },
): Promise<Scene> {
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
    premultipliedAlpha: false,
  });
  try {
    const { scene, update } = await build(engine, canvas);
    scene.animationsEnabled = false;
    await scene.whenReadyAsync();
    return {
      canvas,
      render(time) {
        update(time);
        scene.render(false);
      },
      dispose() {
        scene.dispose();
        engine.dispose();
        canvas.width = canvas.height = 1;
      },
    };
  } catch (error) {
    engine.dispose();
    throw error;
  }
}
