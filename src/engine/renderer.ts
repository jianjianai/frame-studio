import type { AnimationProject, Scene, Quality } from "./types";
import { activeSubtitle, paintSubtitle } from "./subtitles";
export class FrameRenderer {
  private scene?: Scene;
  private ctx: CanvasRenderingContext2D;
  private destroyed = false;
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
  }
  dispose(): void {
    this.destroyed = true;
    this.scene?.dispose();
    this.scene = undefined;
  }
}
