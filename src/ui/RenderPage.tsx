import { useEffect, useRef, useState } from "react";
import { FrameRenderer } from "../engine/renderer";
import type { AnimationProject } from "../engine/types";
import type { StudioApi } from "../engine/debug";
import { OfflineAudioRenderer } from "../engine/audio-graph";
import { frameDimensions, fitComposition } from "../engine/dimensions.mjs";
export function RenderPage({ project }: { project: AnimationProject }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    let width: number, height: number;
    try {
      ({ width, height } = frameDimensions(project, params.has("width") ? Number(params.get("width")) : fitComposition(project, 1280).width));
    } catch (error) { setError(String(error)); return; }
    const renderer = new FrameRenderer(canvas.current!, project);
    const audio = new OfflineAudioRenderer(project);
    let canceled = false;
    let time = 0;
    const api: StudioApi = {
      ready: false,
      projectId: project.id,
      duration: project.duration,
      async frame(t, subtitles = false) {
        time = Math.max(0, Math.min(project.duration, t));
        await renderer.render(time, subtitles);
      },
      async seek(t) {
        await this.frame(t);
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
      dataURL: () => renderer.dataURL(),
      capture: () => renderer.capture(),
      audioChunk: (start, duration) => audio.pcm(start, duration),
    };
    window.__FRAME_STUDIO__ = api;
    renderer
      .init(width, height, "high")
      .then(async () => {
        await document.fonts.ready;
        if (canceled) return;
        await api.frame(
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
      audio.dispose();
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
