import type { Scene, SceneOptions } from "./types";
import { validateLottie } from "./lottie-document.mjs";
export interface LottieScene extends Scene {
  /** The animation's own size and length (seconds). */
  width: number;
  height: number;
  duration: number;
}
type LottieData = ReturnType<typeof validateLottie>;

/** The animation document at `url`, checked. */
export async function loadLottie(url: string, signal?: AbortSignal): Promise<LottieData> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Lottie 加载失败：" + url);
  return validateLottie(await response.json());
}

/**
 * Canvas renderer only; Lottie never owns the playback clock. The canvas is
 * options.width × options.height, the animation fitted inside it.
 */
export async function createLottieScene(
  options: SceneOptions,
  url: string,
  signal?: AbortSignal,
): Promise<LottieScene> {
  return lottieScene(options, await loadLottie(url, signal), signal);
}

export async function lottieScene(
  options: SceneOptions,
  data: LottieData,
  signal?: AbortSignal,
): Promise<LottieScene> {
  const lottie = (await import("lottie-web/build/player/lottie_light_canvas"))
    .default;
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  // No container: given one, lottie-web draws into a canvas of its own inside it (sized by
  // the page layout) and ignores the context. dpr 1: the canvas keeps the size it was given.
  const animation = lottie.loadAnimation<"canvas">({
    renderer: "canvas",
    loop: false,
    autoplay: false,
    animationData: data,
    rendererSettings: {
      context: canvas.getContext("2d")!,
      clearCanvas: true,
      preserveAspectRatio: "xMidYMid meet",
      dpr: 1,
    },
  } as Parameters<typeof lottie.loadAnimation<"canvas">>[0]);
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const abort = () => finish(signal?.reason);
      const timer = setTimeout(
        () => finish(new Error("Lottie initialization timed out")),
        15000,
      );
      animation.addEventListener("DOMLoaded", () => finish());
      animation.addEventListener("data_failed", () =>
        finish(new Error("Lottie initialization failed")),
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (animation.isLoaded) finish();
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    animation.setSubframe(true);
    const duration = (data.op - data.ip) / data.fr;
    return {
      canvas,
      width: data.w,
      height: data.h,
      duration,
      render(time) {
        if (time < 0 || time >= duration)
          throw new Error(`Lottie 的时间 ${time.toFixed(3)} 秒超出了动画范围（0–${duration.toFixed(3)} 秒）`);
        animation.goToAndStop(time * data.fr, true);
      },
      dispose() {
        animation.destroy();
        canvas.width = canvas.height = 1;
      },
    };
  } catch (error) {
    animation.destroy();
    throw error;
  }
}
