import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  useDelayRender,
} from "remotion";
import type { AnimationProject, Scene, SceneModule } from "./types";
import { compositionSize } from "./dimensions.mjs";
import { activeSubtitle } from "./subtitles";

/** One Frame project exposes one selected Remotion component, with ordinary React props. */
export interface RemotionModule {
  default: ComponentType<any>;
}
export function remotionConfig(project: AnimationProject) {
  return {
    id: "FrameComposition",
    ...compositionSize(project),
    fps: project.fps,
    durationInFrames: Math.ceil(project.duration * project.fps),
  };
}
export function withFrameSubtitles(
  Component: ComponentType<any>,
  project: AnimationProject,
  enabled: boolean,
) {
  return function FrameComposition(props: Record<string, unknown>) {
    const frame = useCurrentFrame(),
      { fps } = useVideoConfig();
    const text = enabled
      ? activeSubtitle(project.subtitles, frame / fps)
      : undefined;
    return (
      <AbsoluteFill>
        <Component {...props} />
        {text && (
          <div
            style={{
              position: "absolute",
              bottom: "6%",
              left: "7%",
              right: "7%",
              textAlign: "center",
              fontFamily: "sans-serif",
              fontSize: compositionSize(project).height * 0.037,
              color: "white",
              textShadow: "0 2px 5px black",
              whiteSpace: "pre-wrap",
            }}
          >
            {text}
          </div>
        )}
      </AbsoluteFill>
    );
  };
}
/** Embed any Frame Canvas/Pixi/Three/Babylon/composition scene in a Remotion Sequence. */
export function FrameScene({
  load,
  quality = "high",
}: {
  load: () => Promise<SceneModule>;
  quality?: "draft" | "standard" | "high";
}) {
  const frame = useCurrentFrame(),
    { fps, width, height } = useVideoConfig();
  const host = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<Scene>();
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    const handle = delayRender("Initialize Frame scene");
    let disposed = false,
      owned: Scene | undefined;
    setScene(undefined);
    const release = () => {
      const value = owned;
      owned = undefined;
      value?.dispose();
    };
    load()
      .then((mod) => mod.createScene({ width, height, quality }))
      .then(async (value) => {
        owned = value;
        if (disposed) {
          release();
          return;
        }
        if (value.element)
          throw new Error(
            "FrameScene embeds canvas scenes; nest Remotion components directly.",
          );
        // The initialization handle must cover the first pixels too: React may
        // commit setScene after the renderer observes that all handles cleared.
        const signal = AbortSignal.timeout(45000);
        await value.prepareFrame?.(frame / fps, { signal });
        await value.render(frame / fps);
        if (disposed) {
          release();
          return;
        }
        value.canvas.style.cssText = "width:100%;height:100%;display:block";
        host.current?.append(value.canvas);
        setScene(value);
      })
      .catch(cancelRender)
      .finally(() => continueRender(handle));
    return () => {
      disposed = true;
      void tail.current.catch(() => {}).then(release);
    };
  }, [load, width, height, quality, delayRender, continueRender, cancelRender]);
  useLayoutEffect(() => {
    if (!scene) return;
    const handle = delayRender("Prepare Frame scene at " + frame);
    const abort = new AbortController();
    tail.current = tail.current
      .catch(() => {})
      .then(async () => {
        if (abort.signal.aborted) return;
        await scene.prepareFrame?.(frame / fps, { signal: abort.signal });
        abort.signal.throwIfAborted();
        await scene.render(frame / fps);
      })
      .catch((error) => {
        if (!abort.signal.aborted) cancelRender(error);
      })
      .finally(() => continueRender(handle));
    return () => abort.abort();
  }, [scene, frame, fps, delayRender, continueRender, cancelRender]);
  return <AbsoluteFill ref={host} />;
}
