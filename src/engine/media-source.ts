import { Input, UrlSource, ALL_FORMATS, CanvasSink } from "mediabunny";
import { assetUrl } from "./types";
export interface MediaFrame {
  image: CanvasImageSource;
  width: number;
  height: number;
}
export interface VideoSource {
  duration: number;
  frame(time: number, signal?: AbortSignal): Promise<MediaFrame>;
  dispose(): void;
}
/** One bounded input per live clip. CanvasSink applies rotation and pixel-aspect metadata. */
export async function openVideoSource(
  src: string,
  width: number,
  signal?: AbortSignal,
): Promise<VideoSource> {
  const input = new Input({
    source: new UrlSource(assetUrl(src), {
      maxCacheSize: 8 * 1024 * 1024,
      getRetryDelay: () => null,
    }),
    formats: ALL_FORMATS,
  });
  const abort = () => input.dispose();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode()))
      throw new Error(
        "无法解码视频 " + src + "；请通过素材转码生成兼容的 H.264/VP9 副本",
      );
    const firstTimestamp = await track.getFirstTimestamp();
    const duration = (await track.computeDuration()) - firstTimestamp;
    const sink = new CanvasSink(track, { width, alpha: true, poolSize: 2 });
    signal?.throwIfAborted();
    signal?.removeEventListener("abort", abort);
    return {
      duration,
      async frame(time, frameSignal) {
        frameSignal?.throwIfAborted();
        if (time < 0 || time >= duration)
          throw new Error("视频片段超出素材时长：" + src + " @ " + time);
        const cancel = () => input.dispose();
        frameSignal?.addEventListener("abort", cancel, { once: true });
        try {
          const frame = await sink.getCanvas(firstTimestamp + time);
          frameSignal?.throwIfAborted();
          if (!frame)
            throw new Error("视频目标帧不存在：" + src + " @ " + time);
          return {
            image: frame.canvas,
            width: frame.canvas.width,
            height: frame.canvas.height,
          };
        } finally {
          frameSignal?.removeEventListener("abort", cancel);
        }
      },
      dispose: () => input.dispose(),
    };
  } catch (error) {
    input.dispose();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
export async function openImageSource(
  src: string,
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  const response = await fetch(assetUrl(src), { signal });
  if (!response.ok)
    throw new Error("图片加载失败：" + src + " (" + response.status + ")");
  const blob = await response.blob();
  // SVG is decoded by the browser image implementation, including its intrinsic dimensions.
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    signal?.throwIfAborted();
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}
