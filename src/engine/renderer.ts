import type { AnimationProject, Scene, Quality } from "./types";
import { activeSubtitle, paintSubtitle } from "./subtitles";
export class FrameRenderer {
  private scene?: Scene;
  private ctx: CanvasRenderingContext2D;
  private destroyed = false;
  private lastTime = 0;
  private renderMs = 0;
  private renderCount = 0;
  constructor(
    public readonly canvas: HTMLCanvasElement,
    public readonly project: AnimationProject,
  ) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("此浏览器不支持 Canvas 2D");
    this.ctx = context;
  }
  async init(
    width = 1280,
    height = 720,
    quality: Quality = "standard",
  ): Promise<void> {
    // Pixi's CSP adapter replaces generated JavaScript with static functions.
    // Load it before any scene initializes, including browser exports.
    if (this.project.renderer === "pixi") await import("pixi.js/unsafe-eval");
    const mod = await this.project.load();
    if (this.destroyed) return;
    const scene = await mod.createScene({ width, height, quality });
    if (this.destroyed) {
      scene.dispose();
      return;
    }
    this.scene = scene;
    this.canvas.width = width;
    this.canvas.height = height;
    this.render(0, true);
  }
  render(time: number, subtitles = true): void {
    if (!this.scene || this.destroyed) return;
    const began = performance.now();
    this.scene.render(time);
    this.ctx.drawImage(
      this.scene.canvas,
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );
    if (subtitles)
      paintSubtitle(
        this.ctx,
        activeSubtitle(this.project.subtitles, time),
        this.canvas.width,
        this.canvas.height,
      );
    this.lastTime = time;
    this.renderMs = performance.now() - began;
    this.renderCount++;
  }
  diagnostics() {
    return {
      ready: Boolean(this.scene) && !this.destroyed,
      actualTime: this.lastTime,
      renderMs: this.renderMs,
      renderCount: this.renderCount,
      scene: this.scene?.debug?.diagnostics?.() ?? null,
    };
  }
  parameters() {
    return this.scene?.debug?.parameters() ?? {};
  }
  setParameters(values: Record<string, number>) {
    const schema = this.parameters();
    for (const [key, value] of Object.entries(values)) {
      const parameter = schema[key];
      if (
        !parameter ||
        !Number.isFinite(value) ||
        value < parameter.min ||
        value > parameter.max
      )
        throw new Error("Unknown or out-of-range scene parameter: " + key);
    }
    if (!this.scene?.debug)
      throw new Error("This scene does not expose parameters");
    this.scene.debug.setParameters(values);
  }
  setOverlay(enabled: boolean) {
    this.scene?.debug?.setOverlay?.(enabled);
  }
  dispose(): void {
    this.destroyed = true;
    this.scene?.dispose();
    this.scene = undefined;
  }
}
