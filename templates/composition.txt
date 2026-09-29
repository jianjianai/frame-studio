import type { SceneOptions } from "../../src/engine/types";
import { createCompositionScene } from "../../src/engine/compositor";
import visual from "./visual.json";

// Register project-local scene modules here when needed. No engine is selected by default.
export function createScene(options: SceneOptions) {
  return createCompositionScene(options, visual, {});
}
