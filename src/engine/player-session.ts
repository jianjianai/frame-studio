import { FrameRenderer, type PreparedRendererUpdate } from "./renderer";
import { AudioTransport } from "./audio";
import { previewSnapshotBusy } from "./live-preview-lock";
import { waitForStudio, type StudioApi } from "./debug";
import type { AnimationProject, Quality } from "./types";
import { fitComposition } from "./dimensions.mjs";

export interface PlaybackSnapshot {
  time: number;
  playing: boolean;
  buffering: boolean;
  rate: number;
  loop: boolean;
  volume: number;
  muted: boolean;
}
export interface PlayerProjectUpdate {
  visualChanged?: boolean;
  audioChanged?: boolean;
  quality?: Quality;
  revision?: number;
  signal?: AbortSignal;
  /** Synchronous notification at the paired scene/audio acceptance boundary. */
  onCommit?: () => void;
}
type TrackControl = { gain: number; muted: boolean };
export function readPlayback(sound: AudioTransport): PlaybackSnapshot {
  return {
    time: sound.clock.time(),
    playing: sound.clock.playing,
    buffering: sound.buffering,
    rate: sound.clock.rate,
    loop: sound.clock.loop,
    volume: sound.volume,
    muted: sound.muted,
  };
}
interface PlayerSessionOptions {
  canvas: HTMLCanvasElement;
  project: AnimationProject;
  quality: Quality;
  embedded: boolean;
  initial: PlaybackSnapshot;
  controls: Record<string, TrackControl>;
  subtitles: () => boolean;
  segmentEnd: () => number | null;
  onSegmentEnd: () => void;
  onSnapshot: (state: PlaybackSnapshot) => void;
  onLoading: (loading: boolean) => void;
  onError: (error: string) => void;
  onFps: (fps: number) => void;
  onTrackControl: (id: string, control: TrackControl) => void;
}
/** Owns one audio/render/diagnostic session. React only renders controls and observes snapshots. */
export function createPlayerSession({
  canvas,
  project,
  quality,
  embedded,
  initial,
  controls,
  subtitles,
  segmentEnd,
  onSegmentEnd,
  onSnapshot,
  onLoading,
  onError,
  onFps,
  onTrackControl,
}: PlayerSessionOptions) {
  let canceled = false,
    raf = 0,
    lastRender = -1,
    lastSub = false,
    uiAt = 0,
    frames = 0,
    fpsAt = performance.now();
  const output = new FrameRenderer(canvas, project);
  const lifetime = new AbortController();
  let updateEpoch = 0, updating: AbortController | undefined, renderFailed = false;
  const livePreview = { revision: 0, updates: 0, lastError: "" };
  const publish = () => {
    if (!canceled) { output.setPlayback(readPlayback(sound)); onSnapshot(readPlayback(sound)); }
  };
  const diagnosticErrors: string[] = [];
  const recordError = (error: unknown) => { diagnosticErrors.push(String(error)); if (diagnosticErrors.length > 50) diagnosticErrors.shift(); };
  const sound = new AudioTransport(project, (error) => {
    recordError(error.message);
    if (!canceled) {
      onError("播放已暂停：" + error.message);
      publish();
    }
  });
  output.onBuffering = waiting => { sound.setVisualBuffering(waiting); publish(); };
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
  let size = fitComposition(
    project,
    quality === "high" ? 1920 : quality === "draft" ? 640 : 1280,
  );
  let manualFrames = 0;
  const drawRequested = async (time: number, captions: boolean) => {
    manualFrames++;
    try {
      const committed = await output.render(time, captions);
      if (committed) {
        lastRender = time;
        lastSub = captions;
      }
      return committed;
    } finally {
      manualFrames--;
    }
  };
  const api: StudioApi = {
    ready: false,
    projectId: project.id,
    duration: project.duration,
    async frame(t, subtitles = true) {
      sound.pause();
      sound.seek(t);
      await drawRequested(sound.clock.time(), subtitles);
      publish();
    },
    async seek(t) {
      sound.seek(t);
      await drawRequested(sound.clock.time(), subtitles());
      publish();
    },
    async play() {
      await drawRequested(sound.clock.time(), subtitles());
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
    dataURL: () => output.dataURL(),
    capture: () => output.capture(),
    async waitUntilReady(options = {}) {
      await waitForStudio(api, options);
      if (options.audio)
        await sound.preparePosition(
          AbortSignal.timeout(options.timeoutMs ?? 60000),
        );
    },
    async captureAt(t, options = {}) {
      await waitForStudio(api, options);
      await api.frame(t, options.subtitles ?? subtitles());
      await api.waitUntilReady!(options);
      return {
        time: sound.clock.time(),
        dataURL: await api.capture!(),
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
      livePreview: { ...livePreview, ...window.__FRAME_LIVE_STATUS__, lastError: window.__FRAME_LIVE_STATUS__?.error ?? livePreview.lastError },
      audio: {
        state: sound.context?.state ?? "locked",
        buffering: sound.buffering,
        prepareMs: sound.prepareMs,
        source: sound.diagnostics(),
        tracks: Object.fromEntries(sound.controls),
        bufferedRanges: sound.bufferedRanges(),
      },
      errors: [...diagnosticErrors],
    }),
    getParameters: () => output.parameters(),
    async setParameters(values) {
      output.setParameters(values);
      await drawRequested(sound.clock.time(), subtitles());
      publish();
    },
    async setOverlay(enabled) {
      output.setOverlay(enabled);
      await drawRequested(sound.clock.time(), subtitles());
    },
  };
  if (
    embedded ||
    import.meta.env.DEV ||
    new URLSearchParams(location.search).has("debug")
  )
    window.__FRAME_STUDIO__ = api;
  const tick = async (now: number) => {
    if (canceled) return;
    if (!api.ready) { raf = requestAnimationFrame(tick); return; }
    try {
      output.setPlayback(readPlayback(sound));
      const t = sound.clock.time();
      const end = segmentEnd();
      if (end !== null && t >= end) {
        sound.pause();
        sound.seek(end);
        onSegmentEnd();
      }
      if (
        manualFrames === 0 && !renderFailed &&
        (sound.clock.playing || lastRender !== t || lastSub !== subtitles())
      ) {
        const committed = await output.render(t, subtitles());
        if (canceled) return;
        if (committed) {
          frames++;
          lastRender = t;
          lastSub = subtitles();
        }
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
      recordError(e);
      renderFailed = true;
      sound.pause();
      onError("渲染错误：" + String(e));
      if (!canceled) raf = requestAnimationFrame(tick);
    }
  };
  const ready = output
    .init(size.width, size.height, quality)
    .then(async () => {
      if (canceled) return;
      await output.render(sound.clock.time(), subtitles());
      if (window.__FRAME_PREVIEW_MEDIA_MODE__ === "cached")
        await sound.warmPreview(lifetime.signal);
      if (canceled) return;
      onLoading(false);
      api.ready = true;
      if (embedded && parent !== window)
        parent.postMessage({ type: "frame-preview-loading", message: "" }, "*");
      publish();
      sound.preload();
      if (initial.playing) await sound.play();
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
      recordError(e);
      if (!canceled) {
        onError(
          "场景载入失败：" +
            String(e) +
            (embedded
              ? "。可尝试刷新预览，或把错误告诉 AI 修复作品。"
              : "。请检查浏览器硬件加速或运行 pnpm env:check。"),
        );
        onLoading(false);
        raf = requestAnimationFrame(tick);
      }
    });
  const updateProject = async (next: AnimationProject, options: PlayerProjectUpdate = {}) => {
    if (next.id !== project.id) throw new Error("A player session cannot change project identity");
    const epoch = ++updateEpoch;
    updating?.abort();
    const controller = updating = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    let candidate: PreparedRendererUpdate | undefined, committed = false;
    try {
      await ready;
      signal.throwIfAborted();
      if (canceled) throw new Error("Player session is unavailable");
      const nextQuality = options.quality ?? quality;
      const nextSize = fitComposition(next, nextQuality === "high" ? 1920 : nextQuality === "draft" ? 640 : 1280);
      if (!output.diagnostics().ready || options.visualChanged !== false || nextQuality !== quality || next.renderer !== project.renderer || nextSize.width !== size.width || nextSize.height !== size.height)
        candidate = await output.prepareProject(next, {
          ...nextSize, quality: nextQuality,
          time: () => sound.clock.time(), subtitles, signal,
        });
      signal.throwIfAborted();
      await sound.updateProject(next, {
        signal, audioChanged: options.audioChanged !== false,
        beforeCommit: () => candidate?.refresh(),
        onCommit: () => {
          signal.throwIfAborted();
          if (canceled || epoch !== updateEpoch || previewSnapshotBusy())
            throw new DOMException("Superseded player revision", "AbortError");
          if (candidate && !candidate.commit())
            throw new DOMException("Superseded scene", "AbortError");
          if (!candidate) output.updateMetadata(next);
        },
        onAccepted: () => {
          project = next;
          quality = nextQuality;
          size = nextSize;
          api.duration = next.duration;
          const recovered = !api.ready;
          api.ready = true;
          renderFailed = false;
          livePreview.revision = options.revision ?? livePreview.revision;
          livePreview.updates++;
          livePreview.lastError = "";
          lastRender = -1;
          committed = true;
          // Notify React and the event client before AudioContext.resume can
          // yield to another edit or an export that freezes this accepted source.
          options.onCommit?.();
          onLoading(false);
          onError("");
          if (recovered) {
            sound.preload();
            if (embedded && parent !== window) parent.postMessage({ type: "frame-preview-loading", message: "" }, "*");
          }
        },
      });
      // An abort after acceptance belongs to the next update/export. It cannot
      // turn an already paired picture/audio revision into a cancelled result.
      if (canceled || epoch !== updateEpoch || previewSnapshotBusy()) return committed;
      output.setPlayback(readPlayback(sound));
      try { await drawRequested(sound.clock.time(), subtitles()); }
      catch (error) { recordError(error); renderFailed = true; sound.pause(); onError("渲染错误：" + String(error)); }
      publish();
      return true;
    } catch (error) {
      if (committed) {
        recordError(error);
        return true;
      }
      if (signal.aborted || canceled || epoch !== updateEpoch || previewSnapshotBusy()) return false;
      livePreview.lastError = String(error);
      recordError(error);
      onError("更新失败，保留当前预览：" + String(error));
      throw error;
    } finally {
      candidate?.dispose();
    }
  };
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
    lifetime.abort();
    updating?.abort();
    ++updateEpoch;
    cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", visibility);
    sound.pause();
    void sound.dispose();
    output.dispose();
    if (window.__FRAME_STUDIO__ === api) delete window.__FRAME_STUDIO__;
  };
  return {
    audio: sound,
    renderer: output,
    ready,
    api,
    snapshot: () => readPlayback(sound),
    updateProject,
    dispose,
  };
}
