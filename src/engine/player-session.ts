import { FrameRenderer } from "./renderer";
import { AudioTransport } from "./audio";
import { waitForStudio, type StudioApi } from "./debug";
import type { AnimationProject, Quality } from "./types";
import { fitComposition } from "./dimensions.mjs";

export interface PlaybackSnapshot {
  time: number; playing: boolean; buffering: boolean; rate: number;
  loop: boolean; volume: number; muted: boolean;
}
type TrackControl = { gain: number; muted: boolean };
export function readPlayback(sound: AudioTransport): PlaybackSnapshot {
  return { time: sound.clock.time(), playing: sound.clock.playing, buffering: sound.buffering,
    rate: sound.clock.rate, loop: sound.clock.loop, volume: sound.volume, muted: sound.muted };
}
interface PlayerSessionOptions {
  canvas: HTMLCanvasElement; project: AnimationProject; quality: Quality; embedded: boolean;
  initial: PlaybackSnapshot; controls: Record<string, TrackControl>;
  subtitles: () => boolean; segmentEnd: () => number | null; onSegmentEnd: () => void;
  onSnapshot: (state: PlaybackSnapshot) => void; onLoading: (loading: boolean) => void;
  onError: (error: string) => void; onFps: (fps: number) => void;
  onTrackControl: (id: string, control: TrackControl) => void;
}
/** Owns one audio/render/diagnostic session. React only renders controls and observes snapshots. */
export function createPlayerSession({ canvas, project, quality, embedded, initial, controls,
  subtitles, segmentEnd, onSegmentEnd, onSnapshot, onLoading, onError, onFps, onTrackControl }: PlayerSessionOptions) {
    let canceled = false,
      raf = 0,
      lastRender = -1,
      lastSub = false,
      uiAt = 0,
      frames = 0,
      fpsAt = performance.now();
    const output = new FrameRenderer(canvas, project);
    const publish = () => { if (!canceled) onSnapshot(readPlayback(sound)); };
    const diagnosticErrors: string[] = [];
    const sound = new AudioTransport(project, (error) => {
      diagnosticErrors.push(error.message);
      if (!canceled) {
        onError("播放已暂停：" + error.message);
        publish();
      }
    });
    for (const [id, control] of Object.entries(controls))
      if (sound.controls.has(id)) sound.setTrack(id, control);
    sound.seek(initial.time);
    sound.setRate(initial.rate);
    sound.setLoop(initial.loop);
    sound.setVolume(initial.volume);
    sound.setMuted(initial.muted);
    onLoading(true);
    document.getElementById("frame-boot")?.remove();
    if (embedded && parent !== window)
      parent.postMessage(
        { type: "frame-preview-loading", message: "正在准备画面与素材…" },
        "*",
      );
    onError("");
    const size = fitComposition(project, quality === "high" ? 1920 : quality === "draft" ? 640 : 1280);
    const api: StudioApi = {
      ready: false,
      projectId: project.id,
      duration: project.duration,
      frame(t, subtitles = true) {
        sound.pause();
        sound.seek(t);
        output.render(sound.clock.time(), subtitles);
        publish();
      },
      seek(t) {
        sound.seek(t);
        output.render(sound.clock.time(), subtitles());
        publish();
      },
      async play() {
        await sound.play();
        publish();
      },
      pause() {
        sound.pause();
        publish();
      },
      getState: () => ({
        time: sound.clock.time(),
        playing: sound.clock.playing,
        rate: sound.clock.rate,
        loop: sound.clock.loop,
        audioState: sound.context?.state ?? "locked",
        width: size.width,
        height: size.height,
      }),
      dataURL: () => canvas.toDataURL("image/png"),
      async waitUntilReady(options = {}) {
        await waitForStudio(api, options);
        if (options.audio)
          await sound.preparePosition(
            AbortSignal.timeout(options.timeoutMs ?? 60000),
          );
      },
      async captureAt(t, options = {}) {
        await waitForStudio(api, options);
        api.frame(t, options.subtitles ?? subtitles());
        await api.waitUntilReady!(options);
        return {
          time: sound.clock.time(),
          dataURL: api.dataURL(),
          diagnostics: api.getDiagnostics!(),
        };
      },
      setRate(rate) {
        sound.setRate(rate);
        publish();
      },
      setLoop(loop) {
        sound.clock.loop = loop;
        publish();
      },
      setVolume(volume) {
        sound.setVolume(volume);
        publish();
      },
      setTrack(id, control) {
        sound.setTrack(id, control);
        onTrackControl(id, sound.controls.get(id)!);
        publish();
      },
      getDiagnostics: () => ({
        ...output.diagnostics(),
        audio: {
          state: sound.context?.state ?? "locked",
          buffering: sound.buffering,
          prepareMs: sound.prepareMs,
          tracks: Object.fromEntries(sound.controls),
          bufferedRanges: sound.bufferedRanges(),
        },
        errors: [...diagnosticErrors],
      }),
      getParameters: () => output.parameters(),
      setParameters(values) {
        sound.pause();
        output.setParameters(values);
        output.render(sound.clock.time(), subtitles());
        publish();
      },
      setOverlay(enabled) {
        output.setOverlay(enabled);
        output.render(sound.clock.time(), subtitles());
      },
    };
    if (
      embedded ||
      import.meta.env.DEV ||
      new URLSearchParams(location.search).has("debug")
    )
      window.__FRAME_STUDIO__ = api;
    output
      .init(size.width, size.height, quality)
      .then(() => {
        if (canceled) return;
        output.render(sound.clock.time(), subtitles());
        onLoading(false);
        api.ready = true;
        if (embedded && parent !== window)
          parent.postMessage(
            { type: "frame-preview-loading", message: "" },
            "*",
          );
        publish();
        sound.preload();
        const tick = (now: number) => {
          if (canceled) return;
          try {
            const t = sound.clock.time();
            const end = segmentEnd();
            if (end !== null && t >= end) {
              sound.pause();
              sound.seek(end);
              onSegmentEnd();
            }
            if (
              sound.clock.playing ||
              lastRender !== t ||
              lastSub !== subtitles()
            ) {
              output.render(t, subtitles());
              frames++;
              lastRender = t;
              lastSub = subtitles();
            }
            if (
              t >= project.duration &&
              sound.clock.playing &&
              !sound.clock.loop
            ) {
              sound.pause();
            }
            if (now - uiAt > 65) {
              publish();
              uiAt = now;
            }
            if (now - fpsAt > 1000) {
              onFps(
                sound.clock.playing
                  ? Math.round((frames * 1000) / (now - fpsAt))
                  : 0,
              );
              frames = 0;
              fpsAt = now;
            }
            raf = requestAnimationFrame(tick);
          } catch (e) {
            diagnosticErrors.push(String(e));
            sound.pause();
            onError("渲染错误：" + String(e));
          }
        };
        raf = requestAnimationFrame(tick);
      })
      .catch((e) => {
        if (canceled) return;
        if (embedded && parent !== window)
          parent.postMessage(
            {
              type: "frame-preview-loading",
              message: "加载失败，请点击刷新预览重试",
            },
            "*",
          );
        diagnosticErrors.push(String(e));
        if (!canceled) {
          onError(
            "场景载入失败：" +
              String(e) +
              (embedded
                ? "。可尝试刷新预览，或把错误告诉 AI 修复作品。"
                : "。请检查浏览器硬件加速或运行 pnpm env:check。"),
          );
          onLoading(false);
        }
      });
    const visibility = () => {
      if (document.hidden) {
        sound.pause();
        publish();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    const dispose = () => {
      if (canceled) return;
      canceled = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", visibility);
      sound.pause();
      void sound.dispose();
      output.dispose();
      if (window.__FRAME_STUDIO__ === api) delete window.__FRAME_STUDIO__;
    };
  return { audio: sound, renderer: output, api, snapshot: () => readPlayback(sound), dispose };
}
