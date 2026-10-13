import type { z } from "zod";
import type { Scene, SceneModule, SceneOptions } from "./types";
import { assetUrl } from "./types";
import {
  visualDocumentSchema,
  validateVisualDocument,
  clipTime,
  sampleValue,
} from "./visual-document.mjs";
import {
  openImageSource,
  openVideoSource,
  type MediaFrame,
} from "./media-source";
export type VisualDocument = z.infer<typeof visualDocumentSchema>;
export type SceneLoaders = Record<string, () => Promise<SceneModule>>;
type Clip = VisualDocument["clips"][number];
interface Source {
  /** `box`: the pixels the layer covers on screen (a model is rendered at that size). */
  frame(time: number, signal: AbortSignal, box: { width: number; height: number }): Promise<MediaFrame>;
  dispose(): void;
}
async function source(
  clip: Clip,
  options: SceneOptions,
  loaders: SceneLoaders,
  signal: AbortSignal,
): Promise<Source> {
  const src = clip.source;
  if (src.kind === "image") {
    const image = await openImageSource(src.src, signal, options.width, options.height);
    return {
      async frame() {
        return { image, width: image.width, height: image.height };
      },
      dispose() {
        image.close();
      },
    };
  }
  if (src.kind === "video")
    return openVideoSource(src.src, options.width, signal);
  if (src.kind === "sequence") {
    let index = -1,
      image: ImageBitmap | undefined;
    return {
      async frame(time, signal) {
        const next = Math.floor(time * src.fps);
        if (next < 0 || next >= src.frames.length)
          throw new Error("图像序列超出范围：" + clip.id);
        if (next !== index) {
          const loaded = await openImageSource(src.frames[next], signal, options.width, options.height);
          image?.close();
          image = loaded;
          index = next;
        }
        return { image: image!, width: image!.width, height: image!.height };
      },
      dispose() {
        image?.close();
      },
    };
  }
  if (src.kind === "lottie") {
    const { loadLottie, lottieScene } = await import("./lottie-adapter");
    const data = await loadLottie(assetUrl(src.src), signal);
    // Drawn at the animation's own shape, as large as the picture holds: crop and fit then
    // work on the animation's frame, not on a picture-shaped canvas with empty bands.
    const fit = Math.min(options.width / data.w, options.height / data.h);
    const width = Math.max(1, Math.round(data.w * fit));
    const height = Math.max(1, Math.round(data.h * fit));
    const scene = await lottieScene({ ...options, width, height }, data, signal);
    return {
      async frame(time) {
        if (time >= scene.duration)
          throw new Error(
            `Lottie 图层「${clip.id}」在这一刻要播放动画的第 ${time.toFixed(2)} 秒，但 ${src.src} 只有 ${scene.duration.toFixed(2)} 秒。动画时间 = offset + (经过的时间 × rate + phase)，有 loop 时括号部分对 loop 取余：offset + loop 不能超过动画时长，循环错开用 phase`,
          );
        await scene.render(time);
        return { image: scene.canvas, width, height };
      },
      dispose: () => scene.dispose(),
    };
  }
  if (src.kind === "model") {
    const { createModelLayer } = await import("./model-layer");
    const layer = await createModelLayer(src, signal);
    return {
      async frame(time, _signal, box) {
        return layer.frame(time, box.width, box.height);
      },
      dispose: () => layer.dispose(),
    };
  }
  if (src.kind === "scene") {
    const load = loaders[src.module];
    if (!load)
      throw new Error(
        `场景模块未注册：${src.module}。在 scene.ts 的 createCompositionScene 第三个参数中加入 ${src.module}: () => import("./scenes/${src.module}")（已注册：${Object.keys(loaders).join("、") || "无"}）`,
      );
    if (src.engine === "pixi") await import("pixi.js/unsafe-eval");
    const mod = await load();
    signal.throwIfAborted();
    const scene = await mod.createScene(options);
    if (signal.aborted) {
      scene.dispose();
      signal.throwIfAborted();
    }
    try {
      if (src.parameters) {
        const parameters = scene.debug?.parameters();
        for (const [key, value] of Object.entries(src.parameters))
          if (
            !parameters?.[key] ||
            value < parameters[key].min ||
            value > parameters[key].max
          )
            throw new Error("Invalid scene parameter: " + key);
        scene.debug?.setParameters(src.parameters);
      }
    } catch (error) {
      scene.dispose();
      throw error;
    }
    return {
      async frame(time, signal) {
        await scene.prepareFrame?.(time, { signal });
        signal.throwIfAborted();
        await scene.render(time);
        signal.throwIfAborted();
        return {
          image: scene.canvas,
          width: scene.canvas.width,
          height: scene.canvas.height,
        };
      },
      dispose: () => scene.dispose(),
    };
  }
  throw new Error("Unsupported source");
}
/** All layers are prepared into a private frame, then committed atomically by FrameRenderer. */
export function createCompositionScene(
  options: SceneOptions,
  value: unknown,
  loaders: SceneLoaders = {},
): Scene {
  const doc = validateVisualDocument(value);
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const ctx = canvas.getContext("2d")!;
  let mask: HTMLCanvasElement | undefined;
  const sources = new Map<string, Source>();
  let disposed = false;
  const release = () => {
    for (const s of sources.values()) s.dispose();
    sources.clear();
  };
  return {
    canvas,
    async prepareFrame(time, { signal }) {
      signal.throwIfAborted();
      if (disposed) throw new Error("Composition disposed");
      const active = doc.clips.filter((c) => clipTime(c, time) !== null);
      // Inactive engine instances and decoders never accumulate across the film.
      for (const [id, s] of sources)
        if (!active.some((c) => c.id === id)) {
          s.dispose();
          sources.delete(id);
        }
      const pixels = options.width * options.height;
      if (
        active.length > 32 ||
        pixels * 4 * (active.length + 3) > 512 * 1024 * 1024
      )
        throw new Error("合成资源预算不足；请减少同时活跃的图层或降低输出尺寸");
      // Three.js scenes and model layers each hold a WebGL context; a browser keeps about 16
      // and silently drops the oldest, so say so instead of losing layers.
      const contexts = active.filter((c) => c.source.kind === "model" || (c.source.kind === "scene" && c.source.engine === "three"));
      if (contexts.length > 12)
        throw new Error(
          `同一时刻有 ${contexts.length} 个三维图层（three 场景和模型图层，${contexts.map((c) => c.id).join("、")}），每个占一个 WebGL 上下文，浏览器最多同时保留约 16 个：同一时刻请不超过 12 个，把几个物体放进同一个 three 场景`,
        );
      // New layers load together (modules, fonts, media): one after another, each would wait
      // for the network in turn. Drawing below stays in layer order.
      const opened = await Promise.allSettled(
        active
          .filter((clip) => clip.source.kind !== "color" && !sources.has(clip.id))
          .map(async (clip) => {
            const current = await source(clip, options, loaders, signal);
            if (disposed || signal.aborted || sources.has(clip.id)) current.dispose();
            else sources.set(clip.id, current);
          }),
      );
      signal.throwIfAborted();
      if (disposed) throw new Error("Composition disposed");
      const failed = opened.find((result) => result.status === "rejected");
      if (failed) throw (failed as PromiseRejectedResult).reason;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (doc.background !== "transparent") {
        ctx.fillStyle = doc.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      try {
        for (const clip of active) {
          const t = clipTime(clip, time)!;
          const p = clip.transform ?? {};
          const w = Math.max(0, sampleValue(p.width, t, 1)) * canvas.width,
            h = Math.max(0, sampleValue(p.height, t, 1)) * canvas.height;
          const x = sampleValue(p.x, t, 0) * canvas.width,
            y = sampleValue(p.y, t, 0) * canvas.height;
          const zoom = Math.max(0, sampleValue(p.scale, t, 1));
          let frame: MediaFrame | undefined;
          if (clip.source.kind !== "color") {
            let current = sources.get(clip.id);
            if (!current) {
              current = await source(clip, options, loaders, signal);
              if (disposed || signal.aborted) {
                current.dispose();
                signal.throwIfAborted();
                throw new Error("Composition disposed");
              }
              sources.set(clip.id, current);
            }
            frame = await current.frame(t, signal, { width: w * zoom, height: h * zoom });
          }
          signal.throwIfAborted();
          const elapsed = time - clip.start + (clip.fadeOffset ?? 0);
          const fade = Math.min(
            1,
            clip.fadeIn ? elapsed / clip.fadeIn : 1,
            clip.fadeOut
              ? ((clip.fadeDuration ?? clip.duration) - elapsed) / clip.fadeOut
              : 1,
          );
          const isMask =
            clip.blend === "destination-in" || clip.blend === "destination-out";
          if (isMask && !mask) {
            mask = document.createElement("canvas");
            mask.width = canvas.width;
            mask.height = canvas.height;
          }
          const paint = isMask ? mask!.getContext("2d")! : ctx;
          if (isMask) paint.clearRect(0, 0, canvas.width, canvas.height);
          paint.save();
          try {
            paint.globalAlpha = Math.max(
              0,
              Math.min(1, sampleValue(p.opacity, t, 1) * fade),
            );
            paint.globalCompositeOperation = isMask
              ? "source-over"
              : clip.blend;
            paint.translate(x + w / 2, y + h / 2);
            paint.rotate((sampleValue(p.rotation, t, 0) * Math.PI) / 180);
            paint.scale(zoom, zoom);
            paint.beginPath();
            paint.rect(-w / 2, -h / 2, w, h);
            paint.clip();
            if (clip.source.kind === "color") {
              paint.fillStyle = clip.source.color;
              paint.fillRect(-w / 2, -h / 2, w, h);
            } else if (frame && w && h) {
              const crop = clip.crop ?? { x: 0, y: 0, width: 1, height: 1 };
              const sw = frame.width * crop.width,
                sh = frame.height * crop.height;
              const scale =
                clip.fit === "cover"
                  ? Math.max(w / sw, h / sh)
                  : Math.min(w / sw, h / sh);
              const dw = clip.fit === "fill" ? w : sw * scale,
                dh = clip.fit === "fill" ? h : sh * scale;
              paint.drawImage(
                frame.image,
                frame.width * crop.x,
                frame.height * crop.y,
                sw,
                sh,
                -dw / 2,
                -dh / 2,
                dw,
                dh,
              );
            }
          } finally {
            paint.restore();
          }
          if (isMask) {
            ctx.save();
            try {
              ctx.globalCompositeOperation = clip.blend;
              ctx.drawImage(mask!, 0, 0);
            } finally {
              ctx.restore();
            }
          }
        }
      } catch (error) {
        // A stale seek cancels its frame, not the retained source ownership.
        if (!signal.aborted) release();
        throw error;
      }
    },
    render() {},
    dispose() {
      disposed = true;
      release();
      canvas.width = canvas.height = 1;
      if (mask) mask.width = mask.height = 1;
    },
    debug: {
      parameters: () => ({}),
      setParameters() {},
      diagnostics: () => ({
        activeSources: sources.size,
        clips: doc.clips.length,
        colorSpace: "srgb",
        budgetBytes: 512 * 1024 * 1024,
      }),
    },
  };
}
