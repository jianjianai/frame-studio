import type { AnimationProject, Scene, Quality } from "./types";
import { activeSubtitle, paintSubtitle } from "./subtitles";
/** One serialized frame transaction; only the newest request may commit to the output. */
export class FrameRenderer {
  private scene?: Scene;
  private ctx: CanvasRenderingContext2D;
  private destroyed = false;
  private lastTime = 0;
  private renderMs = 0;
  private renderCount = 0;
  private revision = 0;
  private request?: AbortController;
  private tail: Promise<unknown> = Promise.resolve();
  private preparing = false;
  constructor(
    public readonly canvas: HTMLCanvasElement,
    public readonly project: AnimationProject,
  ) {
    const context = canvas.getContext("2d", {
      alpha: false,
      colorSpace: "srgb",
    });
    if (!context) throw new Error("此浏览器不支持 Canvas 2D");
    this.ctx = context;
  }
  async init(
    width = 1280,
    height = 720,
    quality: Quality = "standard",
  ): Promise<void> {
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
    await this.render(0, true);
  }
  render(
    time: number,
    subtitles = true,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!Number.isFinite(time) || time < 0 || time > this.project.duration)
      return Promise.reject(new Error("Invalid frame time"));
    const revision = ++this.revision;
    this.request?.abort();
    const request = (this.request = new AbortController());
    const abort = () => request.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        if (request.signal.aborted || this.destroyed || !this.scene) {
          signal?.throwIfAborted();
          return false;
        }
        this.preparing = true;
        const began = performance.now();
        try {
          const combined = AbortSignal.any([
            request.signal,
            AbortSignal.timeout(45000),
          ]);
          await this.scene.prepareFrame?.(time, { signal: combined });
          combined.throwIfAborted();
          await this.scene.render(time);
          combined.throwIfAborted();
          if (revision !== this.revision || this.destroyed) return false;
          // Always clear: transparent layers must not retain the previous frame.
          this.ctx.fillStyle = "#000000";
          this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
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
          return true;
        } catch (error) {
          signal?.throwIfAborted();
          if (
            request.signal.aborted ||
            this.destroyed ||
            revision !== this.revision
          )
            return false;
          throw error;
        } finally {
          this.preparing = false;
        }
      })
      .finally(() => signal?.removeEventListener("abort", abort));
    this.tail = task;
    return task;
  }
  async settled() {
    await this.tail;
  }
  diagnostics() {
    return {
      ready: Boolean(this.scene) && !this.destroyed,
      preparing: this.preparing,
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
    if (this.destroyed) return;
    this.destroyed = true;
    this.request?.abort();
    this.revision++;
    const scene = this.scene;
    void this.tail
      .catch(() => {})
      .then(() => {
        scene?.dispose();
        if (this.scene === scene) this.scene = undefined;
      });
  }
}
