import { useEffect, useRef } from "react";
import { attachZoom, type Zoom } from "../../src/preview/zoom";

/**
 * An image in a tab that zooms like an image viewer (src/preview/zoom.ts): it fills the room it
 * is given, fitted, and a new picture starts fitted again.
 */
export function ZoomImage({ src, alt, onLoad, onError }: { src: string; alt: string; onLoad?: (image: HTMLImageElement) => void; onError?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const zoom = useRef<Zoom | null>(null);
  useEffect(() => {
    zoom.current = attachZoom(box.current!, image.current!, { keys: box.current! });
    return () => zoom.current?.dispose();
  }, []);
  useEffect(() => zoom.current?.reset(), [src]);
  return (
    <div ref={box} className="zoom-box" tabIndex={-1} title="Ctrl/Alt + 滚轮或双指捏合缩放，双击在适应窗口和原始大小之间切换">
      <img ref={image} src={src} alt={alt} onLoad={(event) => onLoad?.(event.currentTarget)} onError={onError} />
    </div>
  );
}
