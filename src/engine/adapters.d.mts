export type RendererId =
  "composition" | "remotion" | "canvas" | "pixi" | "three" | "babylon";
export const rendererIds: [RendererId, ...RendererId[]];
export const adapters: ReadonlyArray<{
  id: string;
  name: string;
  category: string;
  template: boolean;
  seek: string;
  alpha: boolean;
  offline: boolean;
}>;
