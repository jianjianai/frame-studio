import type { Scene, SceneOptions } from "./types";
import { validateLottie } from "./lottie-document.mjs";
/** Canvas renderer only; Lottie never owns the playback clock. */
export async function createLottieScene(
  options: SceneOptions,
  url: string,
  signal?: AbortSignal,
): Promise<Scene> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Lottie 加载失败：" + url);
  const data = validateLottie(await response.json());
  const lottie = (await import("lottie-web/build/player/lottie_light_canvas"))
    .default;
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const animation = lottie.loadAnimation<"canvas">({
    container: document.createElement("div"),
    renderer: "canvas",
    loop: false,
    autoplay: false,
    animationData: data,
    rendererSettings: {
      context: canvas.getContext("2d")!,
      clearCanvas: true,
      preserveAspectRatio: "xMidYMid meet",
    },
  });
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
    return {
      canvas,
      render(time) {
        if (time < 0 || time >= (data.op - data.ip) / data.fr)
          throw new Error("Lottie time exceeds animation duration");
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
