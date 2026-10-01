import type { AnimationProject, Scene, Quality, ScenePlayback } from "./types";
import { activeSubtitle, paintSubtitle } from "./subtitles";

export interface RendererUpdateOptions {
  width: number;
  height: number;
  quality: Quality;
  time: () => number;
  subtitles: () => boolean;
  signal?: AbortSignal;
}
export interface PreparedRendererUpdate {
  refresh(): Promise<void>;
  commit(): boolean;
  dispose(): void;
}
/** One serialized frame transaction; scene replacements stage before touching the visible surface. */
export class FrameRenderer {
  private scene?: Scene;
  onBuffering?: (waiting: boolean) => void;
  private ctx: CanvasRenderingContext2D;
  private destroyed = false;
  private lastTime = 0;
  private renderMs = 0;
  private renderCount = 0;
  private sceneEpoch = 0;
  private revision = 0;
  private replacementRevision = 0;
  private replacement?: AbortController;
  private request?: AbortController;
  private tail: Promise<unknown> = Promise.resolve();
  private preparing = false;
  private cleanupSurface?: () => void;
  private cleanupErrors: string[] = [];
  private sceneBuffering = false;
  private slowFrames = new Set<number>();
  private publishBuffering() { this.onBuffering?.(this.sceneBuffering || this.slowFrames.size > 0); }
  constructor(
    public readonly canvas: HTMLCanvasElement,
    public project: AnimationProject,
  ) {
    const context = canvas.getContext("2d", { alpha: false, colorSpace: "srgb" });
    if (!context) throw new Error("此浏览器不支持 Canvas 2D");
    this.ctx = context;
  }
  private disposeScene(scene?: Scene) {
    try { scene?.dispose(); }
    catch (error) {
      this.cleanupErrors.push(String(error));
      if (this.cleanupErrors.length > 50) this.cleanupErrors.shift();
    }
  }
  private mountSurface(scene: Scene) {
    if (!scene.element || !this.canvas.parentElement) return undefined;
    const parent = this.canvas.parentElement, el = scene.element;
    const position = parent.style.position, visibility = this.canvas.style.visibility;
    const css = el.style.cssText;
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    this.canvas.style.visibility = "hidden";
    el.style.cssText = "position:absolute;overflow:hidden;pointer-events:none";
    parent.append(el);
    const resize = () => Object.assign(el.style, {
      left: this.canvas.offsetLeft + "px", top: this.canvas.offsetTop + "px",
      width: this.canvas.clientWidth + "px", height: this.canvas.clientHeight + "px",
    });
    const observer = new ResizeObserver(resize);
    observer.observe(this.canvas);
    resize();
    return () => {
      observer.disconnect();
      el.remove();
      el.style.cssText = css;
      parent.style.position = position;
      this.canvas.style.visibility = visibility;
    };
  }
  private paint(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, scene: Scene, project: AnimationProject, time: number, subtitles: boolean) {
    context.fillStyle = "#000000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(scene.canvas, 0, 0, canvas.width, canvas.height);
    if (subtitles && !scene.element)
      paintSubtitle(context, activeSubtitle(project.subtitles, time), canvas.width, canvas.height);
  }
  async init(width = 1280, height = 720, quality: Quality = "standard"): Promise<void> {
    const prepared = await this.prepareProject(this.project, {
      width, height, quality, time: () => 0, subtitles: () => true,
    });
    prepared.commit();
  }
  /** Preparation may overlap the old scene's playback; failed/stale candidates never change it. */
  async prepareProject(project: AnimationProject, options: RendererUpdateOptions): Promise<PreparedRendererUpdate> {
    if (this.destroyed) throw new Error("Renderer disposed");
    const epoch = ++this.replacementRevision;
    this.replacement?.abort();
    const controller = this.replacement = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(60000)]);
    let scene: Scene | undefined, stage: HTMLDivElement | undefined, stagedStyle = "";
    let owned = true;
    const releaseStage = () => {
      if (scene?.element && stage?.contains(scene.element)) {
        scene.element.remove();
        scene.element.style.cssText = stagedStyle;
      }
      stage?.remove();
      stage = undefined;
    };
    const dispose = () => {
      if (!owned) return;
      owned = false;
      signal.removeEventListener("abort", dispose);
      releaseStage();
      this.disposeScene(scene);
    };
    try {
      if (project.renderer === "pixi") await import("pixi.js/unsafe-eval");
      signal.throwIfAborted();
      const mod = await project.load();
      signal.throwIfAborted();
      scene = await mod.createScene({
        width: options.width, height: options.height, quality: options.quality,
        onBuffering: waiting => { if (this.scene === scene && !this.destroyed) { this.sceneBuffering = waiting; this.publishBuffering(); } },
      });
      signal.throwIfAborted();
      if (this.destroyed || epoch !== this.replacementRevision) throw new DOMException("Superseded scene", "AbortError");
      // DOM/Remotion scenes need a connected element to initialize. They stay invisible until commit.
      if (scene.element && this.canvas.parentElement) {
        stagedStyle = scene.element.style.cssText;
        stage = document.createElement("div");
        stage.style.cssText = "position:absolute;inset:0;opacity:0;pointer-events:none;overflow:hidden";
        Object.assign(stage.style, { width: this.canvas.clientWidth + "px", height: this.canvas.clientHeight + "px" });
        scene.element.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:hidden;pointer-events:none";
        stage.append(scene.element);
        this.canvas.parentElement.append(stage);
      }
      let time = Math.max(0, Math.min(project.duration, options.time()));
      let captions = options.subtitles();
      scene.setPlayback?.({ time, playing: false, rate: 1, volume: 0, muted: true });
      scene.setSubtitles?.(captions);
      await scene.prepareFrame?.(time, { signal });
      signal.throwIfAborted();
      await scene.render(time);
      signal.throwIfAborted();
      // Validate drawing into a private surface before replacing a usable frame.
      const surface = document.createElement("canvas");
      surface.width = options.width; surface.height = options.height;
      const context = surface.getContext("2d", { alpha: false, colorSpace: "srgb" });
      if (!context) throw new Error("Cannot create staging canvas");
      this.paint(context, surface, scene, project, time, captions);
      signal.throwIfAborted();
      const candidate = scene;
      signal.addEventListener("abort", dispose, { once: true });
      return {
        dispose,
        refresh: async () => {
          signal.throwIfAborted();
          if (!owned) throw new Error("Candidate already released");
          const nextTime = Math.max(0, Math.min(project.duration, options.time()));
          const nextCaptions = options.subtitles();
          if (nextTime === time && nextCaptions === captions) return;
          candidate.setPlayback?.({ time: nextTime, playing: false, rate: 1, volume: 0, muted: true });
          candidate.setSubtitles?.(nextCaptions);
          await candidate.prepareFrame?.(nextTime, { signal });
          signal.throwIfAborted();
          await candidate.render(nextTime);
          signal.throwIfAborted();
          this.paint(context, surface, candidate, project, nextTime, nextCaptions);
          time = nextTime;
          captions = nextCaptions;
        },
        commit: () => {
          if (!owned || signal.aborted || this.destroyed || epoch !== this.replacementRevision) { dispose(); return false; }
          const previous = this.scene, previousTail = this.tail;
          ++this.revision;
          this.request?.abort();
          this.cleanupSurface?.();
          this.cleanupSurface = undefined;
          releaseStage();
          this.canvas.width = options.width; this.canvas.height = options.height;
          this.ctx.drawImage(surface, 0, 0);
          this.scene = candidate;
          this.project = project;
          this.cleanupSurface = this.mountSurface(candidate);
          this.lastTime = time;
          this.renderCount++;
          this.sceneEpoch++;
          this.sceneBuffering = false;
          this.slowFrames.clear();
          this.publishBuffering();
          owned = false;
          signal.removeEventListener("abort", dispose);
          void previousTail.catch(() => {}).then(() => this.disposeScene(previous));
          return true;
        },
      };
    } catch (error) {
      dispose();
      throw error;
    }
  }
  /** Metadata/subtitles update does not recreate the renderer or scene. */
  updateMetadata(project: AnimationProject) {
    if (project.id !== this.project.id) throw new Error("Cannot change renderer project identity");
    this.project = project;
  }
  render(time: number, subtitles = true, signal?: AbortSignal): Promise<boolean> {
    if (!Number.isFinite(time) || time < 0 || time > this.project.duration)
      return Promise.reject(new Error("Invalid frame time"));
    const revision = ++this.revision;
    this.request?.abort();
    const request = this.request = new AbortController();
    const abort = () => request.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const task = this.tail.catch(() => {}).then(async () => {
      const scene = this.scene, project = this.project;
      if (request.signal.aborted || this.destroyed || !scene) { signal?.throwIfAborted(); return false; }
      this.preparing = true;
      const began = performance.now();
      // Network waits freeze the common audio/visual clock without stalling fast asynchronous frames.
      const bufferingTimer = setTimeout(() => {
        if (!this.destroyed && revision === this.revision && this.scene === scene) {
          this.slowFrames.add(revision);
          this.publishBuffering();
        }
      }, 100);
      try {
        const combined = AbortSignal.any([request.signal, AbortSignal.timeout(45000)]);
        scene.setSubtitles?.(subtitles);
        await scene.prepareFrame?.(time, { signal: combined });
        combined.throwIfAborted();
        await scene.render(time);
        combined.throwIfAborted();
        if (revision !== this.revision || this.destroyed || this.scene !== scene) return false;
        this.paint(this.ctx, this.canvas, scene, project, time, subtitles);
        this.lastTime = time;
        this.renderMs = performance.now() - began;
        this.renderCount++;
        return true;
      } catch (error) {
        signal?.throwIfAborted();
        if (request.signal.aborted || this.destroyed || revision !== this.revision) return false;
        throw error;
      } finally {
        clearTimeout(bufferingTimer);
        if (this.slowFrames.delete(revision)) this.publishBuffering();
        this.preparing = false;
      }
    }).finally(() => signal?.removeEventListener("abort", abort));
    this.tail = task;
    return task;
  }
  dataURL(): string {
    if (this.scene?.element) throw new Error("DOM scene capture is asynchronous; use await capture() or captureAt().");
    return this.canvas.toDataURL("image/png");
  }
  setPlayback(state: ScenePlayback) { this.scene?.setPlayback?.(state); }
  async capture(): Promise<string> {
    if (this.destroyed) throw new Error("Renderer disposed");
    await this.settled();
    return this.scene?.capture ? this.scene.capture() : this.canvas.toDataURL("image/png");
  }
  async settled() { await this.tail; }
  diagnostics() {
    return {
      ready: Boolean(this.scene) && !this.destroyed, preparing: this.preparing, actualTime: this.lastTime,
      renderMs: this.renderMs, renderCount: this.renderCount, sceneEpoch: this.sceneEpoch,
      cleanupErrors: [...this.cleanupErrors], scene: this.scene?.debug?.diagnostics?.() ?? null,
    };
  }
  parameters() { return this.scene?.debug?.parameters() ?? {}; }
  setParameters(values: Record<string, number>) {
    const schema = this.parameters();
    for (const [key, value] of Object.entries(values)) {
      const parameter = schema[key];
      if (!parameter || !Number.isFinite(value) || value < parameter.min || value > parameter.max)
        throw new Error("Unknown or out-of-range scene parameter: " + key);
    }
    if (!this.scene?.debug) throw new Error("This scene does not expose parameters");
    this.scene.debug.setParameters(values);
  }
  setOverlay(enabled: boolean) { this.scene?.debug?.setOverlay?.(enabled); }
  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.request?.abort();
    this.replacement?.abort();
    this.scene?.setPlayback?.({ time: this.lastTime, playing: false, rate: 1, volume: 0, muted: true });
    this.cleanupSurface?.();
    this.sceneBuffering = false;
    this.slowFrames.clear();
    this.publishBuffering();
    this.revision++; this.replacementRevision++;
    const scene = this.scene;
    void this.tail.catch(() => {}).then(() => {
      this.disposeScene(scene);
      if (this.scene === scene) this.scene = undefined;
    });
  }
}
