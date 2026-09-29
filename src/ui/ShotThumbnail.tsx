import { useEffect, useRef, useState } from "react";
import { FrameRenderer } from "../engine/renderer";
import type { AnimationProject } from "../engine/types";

/** One delayed low-resolution scene. It never seeks or renders the main playback canvas. */
export function ShotThumbnail({ project, time, title, x, y }: { project: AnimationProject; time: number; title: string; x: number; y: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState("正在准备缩略图…");
  useEffect(() => {
    let renderer: FrameRenderer | undefined, cancelled = false;
    const timer = setTimeout(() => {
      if (!canvas.current) return;
      try {
        renderer = new FrameRenderer(canvas.current, project);
        void renderer.init(320, 180, "draft").then(() => {
          if (cancelled) return;
          renderer?.render(time, false); setState("");
        }).catch(() => { if (!cancelled) setState("缩略图暂不可用，点击镜头定位"); });
      } catch { setState("缩略图暂不可用，点击镜头定位"); }
    }, 240);
    return () => { cancelled = true; clearTimeout(timer); renderer?.dispose(); };
  }, [project, time]);
  return <div className="shot-thumbnail-popover" role="tooltip" style={{ left: Math.max(8, Math.min(window.innerWidth - 224, x - 108)), top: Math.max(8, y - 164) }}>
    <canvas ref={canvas} width={320} height={180} aria-label={title + " 缩略图"}/>
    {state && <span>{state}</span>}
    <strong>{title}</strong><small>{time.toFixed(2)} 秒 · 点击跳转</small>
  </div>;
}
