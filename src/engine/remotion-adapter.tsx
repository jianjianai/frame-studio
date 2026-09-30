import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Player, type PlayerRef } from "@remotion/player";
import type {
  AnimationProject,
  Scene,
  SceneOptions,
  ScenePlayback,
} from "./types";
import { remotionConfig, withFrameSubtitles } from "./remotion-composition";

/** DOM stays native: no lossy HTML-to-canvas emulation in the live preview. */
export async function createRemotionScene(
  options: SceneOptions,
  project: AnimationProject,
): Promise<Scene> {
  if (!project.loadRemotion)
    throw new Error(
      "Remotion requires loadRemotion: () => import('./composition')",
    );
  const { default: component } = await project.loadRemotion();
  if (!component)
    throw new Error("Remotion module must default-export a React component");
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const element = document.createElement("div");
  element.dataset.remotionSurface = "";
  const root = createRoot(element),
    ref = { current: null as PlayerRef | null };
  const config = remotionConfig(project);
  let disposed = false,
    failure: Error | undefined,
    captions = true,
    lastFrame = 0,
    buffering = false;
  let state: ScenePlayback = {
    time: 0,
    playing: false,
    rate: 1,
    volume: 1,
    muted: false,
  };
  let Content = withFrameSubtitles(component, project, captions);
  const waiting = () => {
    buffering = true;
    options.onBuffering?.(true);
  };
  const resume = () => {
    buffering = false;
    options.onBuffering?.(false);
  };
  const bindPlayer = (player: PlayerRef | null) => {
    if (player === ref.current) return;
    ref.current?.removeEventListener("waiting", waiting);
    ref.current?.removeEventListener("resume", resume);
    ref.current = player;
    player?.addEventListener("waiting", waiting);
    player?.addEventListener("resume", resume);
  };
  const mount = () =>
    flushSync(() =>
      root.render(
        <Player
          ref={bindPlayer}
          component={Content}
          inputProps={project.remotion?.inputProps ?? {}}
          compositionWidth={config.width}
          compositionHeight={config.height}
          durationInFrames={config.durationInFrames}
          fps={config.fps}
          style={{ width: "100%", height: "100%" }}
          controls={false}
          clickToPlay={false}
          moveToBeginningWhenEnded={false}
          playbackRate={state.rate}
          errorFallback={({ error }) => {
            failure = error;
            return <div role="alert">{error.message}</div>;
          }}
        />,
      ),
    );
  try {
    mount();
  } catch (error) {
    root.unmount();
    element.remove();
    throw error;
  }
  const seek = (time: number) =>
    Math.min(
      config.durationInFrames - 1,
      Math.max(0, Math.floor(time * config.fps + 1e-7)),
    );
  return {
    canvas,
    element,
    setSubtitles(enabled) {
      if (enabled === captions) return;
      captions = enabled;
      Content = withFrameSubtitles(component, project, captions);
      mount();
    },
    render(time) {
      if (disposed) throw new Error("Remotion scene disposed");
      if (failure) throw failure;
      lastFrame = seek(time);
      // During playback the Player drives native audio; correct drift and discontinuous seeks.
      if (
        !state.playing ||
        Math.abs((ref.current?.getCurrentFrame() ?? -1) - lastFrame) > 1
      )
        flushSync(() => ref.current?.seekTo(lastFrame));
    },
    setPlayback(next) {
      const changedRate = state.rate !== next.rate;
      const wasPlaying = state.playing;
      state = next;
      if (changedRate) mount();
      ref.current?.setVolume(Math.min(1, Math.max(0, next.volume)));
      if (next.muted) ref.current?.mute();
      else ref.current?.unmute();
      if (!next.playing) ref.current?.pause();
      else if (!wasPlaying) {
        ref.current?.seekTo(seek(next.time));
        ref.current?.play();
      }
    },
    async capture() {
      const { renderStillOnWeb } = await import("@remotion/web-renderer");
      const result = await renderStillOnWeb({
        composition: { ...config, component: Content },
        inputProps: project.remotion?.inputProps ?? {},
        frame: lastFrame,
        scale: options.width / config.width,
      });
      const image = await result.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(image);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ref.current?.pause();
      root.unmount();
      element.remove();
      canvas.width = canvas.height = 1;
    },
    debug: {
      parameters: () => ({}),
      setParameters() {},
      diagnostics: () => ({
        engine: "remotion",
        frame: lastFrame,
        buffering,
        error: failure?.message,
      }),
    },
  };
}
