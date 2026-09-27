import { useEffect, useRef, useState } from "react";
import { FrameRenderer } from "../engine/renderer";
import type { AnimationProject } from "../engine/types";
import type { StudioApi } from "../engine/debug";
export function RenderPage({ project }: { project: AnimationProject }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const w = Number(params.get("width") || 1280);
    const width = Number.isFinite(w)
      ? Math.min(3840, Math.max(320, Math.round(w / 2) * 2))
      : 1280;
    const height = Math.round((width * 9) / 16 / 2) * 2;
    const renderer = new FrameRenderer(canvas.current!, project);
    let canceled = false;
    let time = 0;
    const api: StudioApi = {
      ready: false,
      projectId: project.id,
      duration: project.duration,
      frame(t, subtitles = false) {
        time = Math.max(0, Math.min(project.duration, t));
        renderer.render(time, subtitles);
      },
      seek(t) {
        this.frame(t);
      },
      async play() {},
      pause() {},
      getState: () => ({
        time,
        playing: false,
        rate: 1,
        loop: false,
        audioState: "offline",
        width,
        height,
      }),
      dataURL: () => canvas.current!.toDataURL("image/png"),
    };
    window.__FRAME_STUDIO__ = api;
    renderer
      .init(
        width,
        height,
        width >= 1920 ? "high" : width <= 640 ? "draft" : "standard",
      )
      .then(async () => {
        await document.fonts.ready;
        if (canceled) return;
        api.frame(
          Number(params.get("time")) || 0,
          params.get("subtitles") === "1",
        );
        api.ready = true;
      })
      .catch((e) => {
        if (!canceled) setError(String(e));
      });
    return () => {
      canceled = true;
      renderer.dispose();
      if (window.__FRAME_STUDIO__ === api) delete window.__FRAME_STUDIO__;
    };
  }, [project]);
  return (
    <div className="render-page">
      <canvas ref={canvas} data-testid="stage-canvas" />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
