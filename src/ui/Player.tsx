import { Fragment, useEffect, useRef, useState } from "react";
import { ResizeHandle } from "./ResizeHandle";
import { ShotThumbnail } from "./ShotThumbnail";
import { readPreference, writePreference, boundedPreference } from "./view-preferences";
import {
  Play,
  Pause,
  SkipBack,
  StepBack,
  StepForward,
  Volume2,
  VolumeX,
  Repeat2,
  Maximize,
  Captions,
  Download,
  X,
  Image,
  FileText,
  Video,
  Copy,
  Check,
  ArrowLeft,
  LoaderCircle,
  SlidersHorizontal,
} from "lucide-react";
import {
  assetUrl,
  projectAudioTracks,
  type AnimationProject,
  type Quality,
} from "../engine/types";
import { FrameRenderer } from "../engine/renderer";
import { AudioTransport } from "../engine/audio";
import type { ExportProgress } from "../engine/browser-export";
import { activeSubtitle, toSrt } from "../engine/subtitles";
import { downloadBlob, downloadCanvas } from "../engine/download";
import { clamp, formatTime } from "../engine/math";
import { waitForStudio, type StudioApi } from "../engine/debug";
interface Playback {
  time: number;
  playing: boolean;
  buffering: boolean;
  rate: number;
  loop: boolean;
  volume: number;
  muted: boolean;
}
export function Player({
  project,
  embedded = false,
}: {
  project: AnimationProject;
  embedded?: boolean;
}) {
  const audioTracks = projectAudioTracks(project);
  const [trackControls, setTrackControls] = useState<
    Record<string, { gain: number; muted: boolean }>
  >({});
  const trackControlsRef = useRef(trackControls);
  trackControlsRef.current = trackControls;
  const canvas = useRef<HTMLCanvasElement>(null);
  const theater = useRef<HTMLDivElement>(null);
  const transport = useRef<AudioTransport | null>(null);
  const renderer = useRef<FrameRenderer | null>(null);
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({});
  useEffect(() => {
    let canceled = false;
    fetch(assetUrl("films/" + project.id + "/waveforms.json"))
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        if (!canceled) {
          setWaveforms(
            Object.fromEntries(
              Object.entries(data || {})
                .filter(([, value]) => Array.isArray(value))
                .map(([key, value]) => [
                  key,
                  (value as unknown[]).map((n) =>
                    typeof n === "number" ? clamp(n) : 0,
                  ),
                ]),
            ),
          );
        }
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [project.id]);
  const initialView = useRef(readPreference<Record<string, unknown>>("frame.player-view", {}));
  const editingArea = useRef<HTMLDivElement>(null);
  const [timelineVisible, setTimelineVisible] = useState(initialView.current.timelineVisible !== false);
  const [videoRatio, setVideoRatio] = useState(() => boundedPreference(initialView.current.videoRatio, 68, 25, 85));
  const [resizing, setResizing] = useState(false);
  const [hoverShot, setHoverShot] = useState<{ time: number; title: string; x: number; y: number } | null>(null);
  const [quality, setQuality] = useState<Quality>(() => ["draft", "standard", "high"].includes(String(initialView.current.quality)) ? initialView.current.quality as Quality : "standard");
  const qualityRef = useRef(quality); qualityRef.current = quality;
  const viewConfigured = useRef(!embedded);
  const preferences = useRef({ timelineVisible, videoRatio, quality });
  preferences.current = { timelineVisible, videoRatio, quality };
  useEffect(() => {
    if (!viewConfigured.current) return;
    writePreference("frame.player-view", preferences.current);
    if (embedded && parent !== window) parent.postMessage({ type: "frame-player-preferences", preferences: preferences.current }, "*");
  }, [timelineVisible, videoRatio, quality, embedded]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportWidth, setExportWidth] = useState(1920);
  const [exportFps, setExportFps] = useState(project.fps);
  const [exportToDisk, setExportToDisk] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(
    null,
  );
  const [starting, setStarting] = useState(false);
  const [fps, setFps] = useState(0);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const subtitleRef = useRef(true);
  subtitleRef.current = showSubtitles;
  const saved = useRef<Playback>({
    time: 0,
    playing: false,
    buffering: false,
    rate: 1,
    loop: false,
    volume: 0.65,
    muted: false,
  });
  const [view, setView] = useState<Playback>(saved.current);
  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState<{ start?: number; end?: number }>(
    {},
  );
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const segmentEnd = useRef<number | null>(null);
  const timelineScroll = useRef<HTMLDivElement>(null);
  const frameTime = (time: number) =>
    `${formatTime(time)}:${String(Math.floor(time * project.fps + 0.001) % project.fps).padStart(2, "0")}`;
  useEffect(() => {
    const element = timelineScroll.current;
    if (!element || !view.playing || zoom === 1) return;
    const x = (view.time / project.duration) * element.scrollWidth;
    if (
      x < element.scrollLeft ||
      x > element.scrollLeft + element.clientWidth - 24
    )
      element.scrollLeft = Math.max(0, x - element.clientWidth / 4);
  }, [view.time, view.playing, zoom, project.duration]);
  const exportAbort = useRef<AbortController | null>(null);
  const publish = () => {
    const a = transport.current;
    if (a) {
      const value = {
        time: a.clock.time(),
        playing: a.clock.playing,
        buffering: a.buffering,
        rate: a.clock.rate,
        loop: a.clock.loop,
        volume: a.volume,
        muted: a.muted,
      };
      saved.current = value;
      setView(value);
      if (embedded && parent !== window)
        parent.postMessage(
          {
            type: "frame-player-state",
            ...value,
            duration: project.duration,
            fps: project.fps,
            quality: qualityRef.current,
            subtitles: subtitleRef.current,
            selection: selectionRef.current,
          },
          "*",
        );
    }
  };
  const commandHandler = useRef<(data: Record<string, any>) => void>(() => {});
  commandHandler.current = (data) => {
    if (data.command === "export") setExportOpen(true);
    if (data.command === "pause") { transport.current?.pause(); publish(); }
    if (data.command === "seek" && Number.isFinite(data.time)) {
      transport.current?.pause();
      if (data.selection && Number.isFinite(data.selection.start) && Number.isFinite(data.selection.end) && data.selection.end > data.selection.start)
        setSelection({ start: Math.max(0, data.selection.start), end: Math.min(project.duration, data.selection.end) });
      seek(data.time);
    }
    if (data.command === "configure-view" && data.preferences && typeof data.preferences === "object") {
      const p = data.preferences;
      viewConfigured.current = true;
      if (typeof p.timelineVisible === "boolean") setTimelineVisible(p.timelineVisible);
      if (Number.isFinite(p.videoRatio)) setVideoRatio(boundedPreference(p.videoRatio, 68, 25, 85));
      if (["draft", "standard", "high"].includes(p.quality) && p.quality !== qualityRef.current) {
        transport.current?.pause(); publish(); setQuality(p.quality);
      }
    }
  };
  useEffect(() => {
    if (!embedded || parent === window) return;
    const receive = (event: MessageEvent) => {
      if (event.source === parent && event.data?.type === "frame-player-command") commandHandler.current(event.data);
    };
    window.addEventListener("message", receive);
    parent.postMessage({ type: "frame-player-ready" }, "*");
    return () => window.removeEventListener("message", receive);
  }, [embedded]);
  useEffect(() => { publish(); }, [selection]);
  const seek = (t: number) => {
    if (exporting) return;
    transport.current?.seek(t);
    renderer.current?.render(
      transport.current?.clock.time() ?? 0,
      subtitleRef.current,
    );
    publish();
  };
  const toggle = async () => {
    const a = transport.current;
    if (!a || loading || exporting) return;
    setError("");
    if (a.clock.playing || a.buffering) {
      a.pause();
      segmentEnd.current = null;
      setStarting(false);
      publish();
      return;
    }
    setStarting(true);
    try {
      await a.play();
      publish();
    } catch (e) {
      setError("播放未能开始：" + String(e));
    } finally {
      setStarting(false);
    }
  };
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void theater.current
        ?.requestFullscreen()
        .catch((e) => setError("全屏未能开启：" + String(e)));
  };
  useEffect(() => {
    let canceled = false,
      raf = 0,
      lastRender = -1,
      lastSub = false,
      uiAt = 0,
      frames = 0,
      fpsAt = performance.now();
    const output = new FrameRenderer(canvas.current!, project);
    const diagnosticErrors: string[] = [];
    const sound = new AudioTransport(project, (error) => {
      diagnosticErrors.push(error.message);
      if (!canceled) {
        setError("播放已暂停：" + error.message);
        publish();
      }
    });
    for (const [id, control] of Object.entries(trackControlsRef.current))
      if (sound.controls.has(id)) sound.setTrack(id, control);
    renderer.current = output;
    transport.current = sound;
    sound.seek(saved.current.time);
    sound.setRate(saved.current.rate);
    sound.setLoop(saved.current.loop);
    sound.setVolume(saved.current.volume);
    sound.setMuted(saved.current.muted);
    setLoading(true);
    document.getElementById("frame-boot")?.remove();
    if (embedded && parent !== window)
      parent.postMessage(
        { type: "frame-preview-loading", message: "正在准备画面与素材…" },
        "*",
      );
    setError("");
    const w = quality === "high" ? 1920 : quality === "draft" ? 640 : 1280;
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
        output.render(sound.clock.time(), subtitleRef.current);
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
        width: w,
        height: Math.round((w * 9) / 16),
      }),
      dataURL: () => canvas.current!.toDataURL("image/png"),
      async waitUntilReady(options = {}) {
        await waitForStudio(api, options);
        if (options.audio)
          await sound.preparePosition(
            AbortSignal.timeout(options.timeoutMs ?? 60000),
          );
      },
      async captureAt(t, options = {}) {
        await waitForStudio(api, options);
        api.frame(t, options.subtitles ?? subtitleRef.current);
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
        setTrackControls((previous) => ({
          ...previous,
          [id]: sound.controls.get(id)!,
        }));
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
        output.render(sound.clock.time(), subtitleRef.current);
        publish();
      },
      setOverlay(enabled) {
        output.setOverlay(enabled);
        output.render(sound.clock.time(), subtitleRef.current);
      },
    };
    if (
      embedded ||
      import.meta.env.DEV ||
      new URLSearchParams(location.search).has("debug")
    )
      window.__FRAME_STUDIO__ = api;
    output
      .init(w, Math.round((w * 9) / 16), quality)
      .then(() => {
        if (canceled) return;
        output.render(sound.clock.time(), subtitleRef.current);
        setLoading(false);
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
            if (segmentEnd.current !== null && t >= segmentEnd.current) {
              sound.pause();
              sound.seek(segmentEnd.current);
              segmentEnd.current = null;
            }
            if (
              sound.clock.playing ||
              lastRender !== t ||
              lastSub !== subtitleRef.current
            ) {
              output.render(t, subtitleRef.current);
              frames++;
              lastRender = t;
              lastSub = subtitleRef.current;
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
              setFps(
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
            setError("渲染错误：" + String(e));
          }
        };
        raf = requestAnimationFrame(tick);
      })
      .catch((e) => {
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
          setError(
            "场景载入失败：" +
              String(e) +
              (embedded
                ? "。可尝试刷新预览，或把错误告诉 AI 修复作品。"
                : "。请检查浏览器硬件加速或运行 pnpm env:check。"),
          );
          setLoading(false);
        }
      });
    const visibility = () => {
      if (document.hidden) {
        sound.pause();
        publish();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      canceled = true;
      cancelAnimationFrame(raf);
      exportAbort.current?.abort();
      document.removeEventListener("visibilitychange", visibility);
      sound.pause();
      saved.current = {
        ...saved.current,
        time: sound.clock.time(),
        playing: false,
        buffering: false,
      };
      void sound.dispose();
      output.dispose();
      if (window.__FRAME_STUDIO__ === api) delete window.__FRAME_STUDIO__;
    };
  }, [project, quality, retry]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const element = e.target as HTMLElement;
      if (
        element.closest("input,textarea,select,button,a") ||
        element.isContentEditable ||
        exporting
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        void toggle();
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        seek((transport.current?.clock.time() ?? 0) + 5);
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        seek((transport.current?.clock.time() ?? 0) - 5);
      } else if (e.code === "Home") {
        e.preventDefault();
        seek(0);
      } else if (e.code === "KeyF") fullscreen();
      else if (e.code === "KeyC") setShowSubtitles((v) => !v);
      else if (e.code === "KeyM") {
        const a = transport.current;
        if (a) {
          a.setMuted(!a.muted);
          publish();
        }
      } else if (e.key === ",")
        seek((transport.current?.clock.time() ?? 0) - 1 / project.fps);
      else if (e.key === ".")
        seek((transport.current?.clock.time() ?? 0) + 1 / project.fps);
      else if (e.code === "Escape") setExportOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  async function renderWebm() {
    const sound = transport.current;
    if (!sound || exportAbort.current) return;
    const abort = new AbortController();
    exportAbort.current = abort;
    sound.pause();
    publish();
    setError("");
    setExporting(true);
    setExportOpen(false);
    setExportProgress({ phase: "preparing", completed: 0, total: 0 });
    try {
      type FileWriter = {
        write(chunk: unknown): Promise<void>;
        close(): Promise<void>;
        abort(): Promise<void>;
      };
      const picker = (
        window as unknown as {
          showSaveFilePicker?: (
            options: unknown,
          ) => Promise<{ createWritable(): Promise<FileWriter> }>;
        }
      ).showSaveFilePicker;
      const writer =
        exportToDisk && picker
          ? await (
              await picker.call(window, {
                suggestedName: project.id + ".webm",
                types: [
                  {
                    description: "WebM 视频",
                    accept: { "video/webm": [".webm"] },
                  },
                ],
              })
            ).createWritable()
          : undefined;
      let blob: Blob | null;
      try {
        const { exportWebm } = await import("../engine/browser-export");
        blob = await exportWebm(project, {
          width: exportWidth,
          fps: exportFps,
          subtitles: subtitleRef.current,
          controls: new Map(sound.controls),
          volume: sound.muted ? 0 : sound.volume,
          signal: abort.signal,
          onProgress: setExportProgress,
          writable: writer
            ? new WritableStream({ write: (chunk) => writer.write(chunk) })
            : undefined,
        });
        if (abort.signal.aborted) throw abort.signal.reason;
        await writer?.close();
      } catch (error) {
        await writer?.abort().catch(() => {});
        throw error;
      }
      if (blob && !abort.signal.aborted)
        downloadBlob(blob, project.id + ".webm");
    } catch (error) {
      if (!abort.signal.aborted) setError("逐帧导出失败：" + String(error));
    } finally {
      if (exportAbort.current === abort) {
        exportAbort.current = null;
        setExporting(false);
        setExportProgress(null);
      }
    }
  }
  const command =
    "pnpm film export " +
    project.id +
    " --width " +
    exportWidth +
    " --fps " +
    exportFps;
  const currentBeat =
    [...project.beats].reverse().find((b) => view.time >= b.at) ??
    project.beats[0];
  return (
    <div className={"player-page" + (embedded ? " work-player" : "")}>
      {!embedded && (
        <header className="player-heading">
          <div>
            <a href="#/" className="back-link">
              <ArrowLeft size={15} /> 返回作品库
            </a>
            <div className="title-line">
              <h1>{project.title}</h1>
              <span className="pill">
                {project.status === "draft"
                  ? "制作中"
                  : project.status === "film"
                    ? "FILM"
                    : "DEMO"}
              </span>
            </div>
            <p>{project.subtitle}</p>
          </div>
          <button
            className="button primary"
            disabled={loading || exporting}
            onClick={() => setExportOpen(true)}
          >
            <Download size={16} /> 导出作品
          </button>
        </header>
      )}
      <div className="studio-layout">
        <div ref={editingArea} className={"editing-area review-layout " + (resizing ? "dragging" : "") + (timelineVisible ? "" : " timeline-hidden")}
          style={{ gridTemplateRows: timelineVisible ? `minmax(0, ${videoRatio}fr) 1px minmax(0, ${100 - videoRatio}fr) auto` : "minmax(0,1fr) auto" }}>
          <div className="theater" ref={theater}>
            <div className="stage-top">
              <span>
                <i className="status-dot" /> 实时画面
                <select className="preview-quality" aria-label="预览画质" value={quality} disabled={loading || exporting} onChange={(event) => {
                  viewConfigured.current = true; transport.current?.pause(); publish(); setQuality(event.target.value as Quality);
                }}>
                  <option value="draft">流畅 360p</option><option value="standard">标准 720p</option><option value="high">精细 1080p</option>
                </select>
              </span>
              <span>
                {quality === "high"
                  ? "1920 × 1080"
                  : quality === "draft"
                    ? "640 × 360"
                    : "1280 × 720"}{" "}
                <b>·</b>{" "}
                {view.buffering
                  ? "正在准备声音"
                  : fps
                    ? fps + " FPS"
                    : "已暂停"}
              </span>
            </div>
            <div className="stage-viewport">
              <canvas
                ref={canvas}
                data-testid="stage-canvas"
                aria-label={project.title + " 动画画面"}
              />
              {loading && (
                <div className="stage-message">
                  <LoaderCircle className="spin" size={28} />
                  <strong>正在准备场景</strong>
                  <progress aria-label="画面加载进度" />
                  <span>载入本地素材与渲染器</span>
                </div>
              )}
              {error && (
                <div className="stage-error" role="alert">
                  <p>{error}</p>
                  <button
                    className="button"
                    onClick={() => setRetry((n) => n + 1)}
                  >
                    重新载入
                  </button>
                </div>
              )}
              {!loading && !error && !view.playing && view.time < 0.05 && (
                <button
                  className="center-play"
                  aria-label={
                    starting || view.buffering ? "取消播放" : "开始播放"
                  }
                  onClick={() => void toggle()}
                >
                  {starting || view.buffering ? (
                    <LoaderCircle className="spin" size={32} />
                  ) : (
                    <Play fill="currentColor" size={32} />
                  )}
                </button>
              )}
              {exporting && (
                <div className="recording-badge">
                  <i />{" "}
                  {exportProgress?.phase === "preparing"
                    ? "正在准备导出"
                    : exportProgress?.phase === "finalizing"
                      ? "正在封装视频"
                      : `正在逐帧渲染 · ${exportProgress?.completed} / ${exportProgress?.total} 帧`}{" "}
                  <button onClick={() => exportAbort.current?.abort()}>
                    取消
                  </button>
                </div>
              )}
            </div>
            <div className="video-progress-wrap">
              <input className="video-progress" type="range" min={0} max={project.duration} step={1 / project.fps}
                aria-label="视频播放进度" aria-valuetext={frameTime(view.time) + " / " + frameTime(project.duration)}
                value={view.time} disabled={loading || exporting} onChange={(event) => seek(Number(event.target.value))}
                style={{ "--progress": (view.time / project.duration) * 100 + "%" } as React.CSSProperties} />
            </div>
            <div className="transport">
              <div className="transport-left">
                <button
                  className="icon-button"
                  aria-label="回到起点"
                  disabled={loading || exporting}
                  onClick={() => seek(0)}
                >
                  <SkipBack size={18} />
                </button>
                <button
                  className="play-button"
                  data-testid="play-toggle"
                  aria-label={
                    view.playing || starting || view.buffering ? "暂停" : "播放"
                  }
                  disabled={loading || exporting}
                  onClick={() => void toggle()}
                >
                  {starting || view.buffering ? (
                    <LoaderCircle className="spin" size={20} />
                  ) : view.playing ? (
                    <Pause fill="currentColor" size={19} />
                  ) : (
                    <Play fill="currentColor" size={19} />
                  )}
                </button>
                <div className="timecode">
                  <strong data-testid="timecode">{frameTime(view.time)}</strong>
                  <span>/ {frameTime(project.duration)}</span>
                </div>
              </div>
              <div className="transport-right">
                <button className={"icon-button timeline-toggle " + (timelineVisible ? "active" : "")}
                  aria-label={timelineVisible ? "隐藏时间轴" : "显示时间轴"} aria-controls="work-timeline" aria-expanded={timelineVisible}
                  title={timelineVisible ? "隐藏时间轴" : "显示时间轴"}
                  onClick={() => { viewConfigured.current = true; setTimelineVisible(!timelineVisible); }}><SlidersHorizontal size={18} /></button>
                <select
                  aria-label="播放速度"
                  value={view.rate}
                  disabled={exporting}
                  onChange={(e) => {
                    transport.current?.setRate(Number(e.target.value));
                    publish();
                  }}
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map((n) => (
                    <option key={n} value={n}>
                      {n}×
                    </option>
                  ))}
                </select>
                <button
                  className={"icon-button " + (view.loop ? "active" : "")}
                  aria-label="循环播放"
                  aria-pressed={view.loop}
                  disabled={exporting}
                  onClick={() => {
                    transport.current?.setLoop(!view.loop);
                    publish();
                  }}
                >
                  <Repeat2 size={18} />
                </button>
                <button
                  className={"icon-button " + (showSubtitles ? "active" : "")}
                  aria-label="中文字幕"
                  aria-pressed={showSubtitles}
                  disabled={exporting}
                  onClick={() => setShowSubtitles((s) => !s)}
                >
                  <Captions size={20} />
                </button>
                <button
                  className="icon-button"
                  aria-label={view.muted ? "取消静音" : "静音"}
                  onClick={() => {
                    transport.current?.setMuted(!view.muted);
                    publish();
                  }}
                >
                  {view.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                </button>
                <input
                  className="volume-slider"
                  type="range"
                  min="0"
                  max="1"
                  step=".01"
                  value={view.volume}
                  aria-label="音量"
                  onChange={(e) => {
                    transport.current?.setVolume(Number(e.target.value));
                    publish();
                  }}
                />
                <button
                  className="icon-button"
                  aria-label="全屏"
                  onClick={fullscreen}
                >
                  <Maximize size={18} />
                </button>
              </div>
            </div>
          </div>
          {timelineVisible && <ResizeHandle axis="horizontal" value={videoRatio} min={25} max={85} containerRef={editingArea}
            onChange={(value) => { viewConfigured.current = true; setVideoRatio(value); }} onDragChange={setResizing} label="调整视频与时间轴高度" />}
          <section id="work-timeline" className="timeline-panel" hidden={!timelineVisible}>
            <div className="panel-heading">
              <div>
                <SlidersHorizontal size={15} />
                <strong>主时间轴</strong>
              </div>
              <div className="frame-controls">
                <select
                  aria-label="时间轴缩放"
                  value={zoom}
                  onChange={(event) => setZoom(Number(event.target.value))}
                >
                  {[1, 2, 4, 8, 16].map((value) => (
                    <option key={value} value={value}>
                      {value === 1 ? "全片" : value + "×"}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  aria-label="上一帧"
                  disabled={exporting}
                  onClick={() => seek(view.time - 1 / project.fps)}
                >
                  <StepBack size={15} />
                </button>
                <span>
                  F{" "}
                  {String(Math.round(view.time * project.fps)).padStart(4, "0")}
                </span>
                <button
                  className="icon-button"
                  aria-label="下一帧"
                  disabled={exporting}
                  onClick={() => seek(view.time + 1 / project.fps)}
                >
                  <StepForward size={15} />
                </button>
              </div>
            </div>
            <p className="current-shot" title={currentBeat?.detail}>当前镜头 · {currentBeat?.title || "全片"}</p>
            <details className="timeline-options">
              <summary>
                定位与选段
                {selection.start !== undefined && selection.end !== undefined
                  ? ` · ${frameTime(selection.start)} → ${frameTime(selection.end)}`
                  : ""}
              </summary>
              <div className="range-controls">
                <label>
                  定位帧{" "}
                  <input
                    aria-label="定位帧"
                    type="number"
                    min="0"
                    max={Math.round(project.duration * project.fps)}
                    placeholder={String(Math.round(view.time * project.fps))}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        event.currentTarget.value !== ""
                      ) {
                        seek(Number(event.currentTarget.value) / project.fps);
                        event.currentTarget.blur();
                      }
                    }}
                  />
                </label>
                <button
                  disabled={loading || exporting}
                  onClick={() =>
                    setSelection((previous) => ({
                      ...previous,
                      start: Math.floor(view.time * project.fps) / project.fps,
                    }))
                  }
                >
                  设为入点
                </button>
                <button
                  disabled={loading || exporting}
                  onClick={() =>
                    setSelection((previous) => ({
                      ...previous,
                      end: Math.ceil(view.time * project.fps) / project.fps,
                    }))
                  }
                >
                  设为出点
                </button>
                <span>
                  {selection.start === undefined
                    ? "—"
                    : frameTime(selection.start)}{" "}
                  →{" "}
                  {selection.end === undefined ? "—" : frameTime(selection.end)}
                </span>
                <button
                  disabled={
                    loading ||
                    exporting ||
                    selection.start === undefined ||
                    selection.end === undefined ||
                    selection.end <= selection.start
                  }
                  onClick={async () => {
                    transport.current?.pause();
                    seek(selection.start!);
                    segmentEnd.current = selection.end!;
                    try {
                      await transport.current?.play();
                      publish();
                    } catch (error) {
                      setError("片段播放失败：" + String(error));
                    }
                  }}
                >
                  播放选段
                </button>
                {(selection.start !== undefined ||
                  selection.end !== undefined) && (
                  <button
                    onClick={() => {
                      setSelection({});
                      segmentEnd.current = null;
                    }}
                  >
                    清除选段
                  </button>
                )}
              </div>
            </details>
            <div className="timeline-scroll" ref={timelineScroll}>
              <div
                className="timeline-content"
                style={{ width: `${zoom * 100}%` }}
              >
                <div className="time-ruler">
                  {Array.from({ length: 8 * zoom + 1 }, (_, i) => (
                    <span key={i}>
                      {frameTime((i * project.duration) / (8 * zoom))}
                    </span>
                  ))}
                </div>
                <input
                  data-testid="timeline"
                  className="master-slider"
                  aria-label="动画进度"
                  type="range"
                  min="0"
                  max={project.duration}
                  step={1 / project.fps}
                  value={view.time}
                  disabled={loading || exporting}
                  onChange={(e) => seek(Number(e.target.value))}
                  style={
                    {
                      "--progress": (view.time / project.duration) * 100 + "%",
                    } as React.CSSProperties
                  }
                />
                <div className="tracks">
                  {selection.start !== undefined &&
                    selection.end !== undefined &&
                    selection.end > selection.start && (
                      <div
                        className="timeline-selection"
                        style={{
                          left: `calc(44px + (100% - 44px) * ${selection.start / project.duration})`,
                          width: `calc((100% - 44px) * ${(selection.end - selection.start) / project.duration})`,
                        }}
                      />
                    )}
                  <div className="track-label">镜头</div>
                  <div className="shot-track">
                    {project.beats.map((b, i) => (
                      <button
                        key={b.at}
                        style={{
                          flex:
                            (project.beats[i + 1]?.at ?? project.duration) -
                            b.at,
                        }}
                        className={currentBeat === b ? "selected" : ""}
                        disabled={exporting}
                        onClick={() => { setHoverShot(null); seek(b.at); }}
                        onMouseEnter={(event) => { const r = event.currentTarget.getBoundingClientRect(); setHoverShot({ time: b.at, title: b.title, x: r.left + r.width / 2, y: r.top }); }}
                        onMouseLeave={() => setHoverShot(null)}
                        onFocus={(event) => { const r = event.currentTarget.getBoundingClientRect(); setHoverShot({ time: b.at, title: b.title, x: r.left + r.width / 2, y: r.top }); }}
                        onBlur={() => setHoverShot(null)}
                        aria-label={b.title + "，" + b.at.toFixed(2) + " 秒"}
                        title={b.detail}
                      >
                        <span>{String(i + 1).padStart(2, "0")}</span>
                        {b.title}
                      </button>
                    ))}
                  </div>
                  {audioTracks.map((track) => {
                    const control = trackControls[track.id] ?? {
                      gain: track.gain ?? 1,
                      muted: track.muted ?? false,
                    };
                    const update = (change: Partial<typeof control>) => {
                      const next = { ...control, ...change };
                      transport.current?.setTrack(track.id, next);
                      setTrackControls((previous) => ({
                        ...previous,
                        [track.id]: next,
                      }));
                    };
                    const values =
                      waveforms[track.kind === "file" ? track.src : track.id] ||
                      [];
                    return (
                      <Fragment key={track.id}>
                        <div className="track-label audio-label">
                          <details className="track-volume">
                            <summary
                              aria-label={`${track.name}音轨控制`}
                              title={track.name}
                            >
                              {control.muted ? (
                                <VolumeX size={16} />
                              ) : (
                                <Volume2 size={16} />
                              )}
                            </summary>
                            <div className="track-volume-popup">
                              <strong>{track.name}</strong>
                              <button
                                aria-label={`${track.name}静音`}
                                aria-pressed={control.muted}
                                disabled={exporting}
                                onClick={() =>
                                  update({ muted: !control.muted })
                                }
                              >
                                {control.muted ? "取消静音" : "静音"}
                              </button>
                              <input
                                aria-label={`${track.name}音量`}
                                type="range"
                                min="0"
                                max="4"
                                step="0.01"
                                value={control.gain}
                                disabled={exporting}
                                onChange={(event) =>
                                  update({ gain: Number(event.target.value) })
                                }
                              />
                              <output>{Math.round(control.gain * 100)}%</output>
                            </div>
                          </details>
                        </div>
                        <div
                          className={
                            "audio-track individual-track " +
                            (control.muted ? "muted" : "")
                          }
                          aria-label={`${track.name}时间轨道`}
                        >
                          <button
                            className="audio-clip"
                            disabled={exporting}
                            style={{
                              left:
                                ((track.start ?? 0) / project.duration) * 100 +
                                "%",
                              width:
                                (Math.min(
                                  track.duration ?? project.duration,
                                  project.duration - (track.start ?? 0),
                                ) /
                                  project.duration) *
                                  100 +
                                "%",
                            }}
                            onClick={() => seek(track.start ?? 0)}
                          >
                            <span>{track.name}</span>
                            {values.length > 0 && (
                              <svg
                                viewBox="0 0 720 32"
                                preserveAspectRatio="none"
                                aria-hidden="true"
                              >
                                {values.slice(0, 180).map((value, i) => (
                                  <rect
                                    key={i}
                                    x={(i * 720) / Math.min(180, values.length)}
                                    y={16 - clamp(value) * 14}
                                    width="2"
                                    height={2 + clamp(value) * 28}
                                    rx="1"
                                  />
                                ))}
                              </svg>
                            )}
                          </button>
                        </div>
                      </Fragment>
                    );
                  })}
                  <div className="track-label">字幕</div>
                  <div className="subtitle-track">
                    {project.subtitles.map((s) => (
                      <button
                        key={s.start}
                        style={{
                          left: (s.start / project.duration) * 100 + "%",
                          width:
                            ((s.end - s.start) / project.duration) * 100 + "%",
                        }}
                        title={s.text}
                        disabled={exporting}
                        onClick={() => seek(s.start)}
                      >
                        {s.text}
                      </button>
                    ))}
                  </div>
                  <div
                    className="track-playhead"
                    style={{
                      left:
                        "calc(44px + (100% - 44px) * " +
                        clamp(view.time / project.duration) +
                        ")",
                    }}
                  />
                </div>
              </div>
            </div>
          </section>
          <div className="keyboard-hint">
            <span>
              <kbd>Space</kbd> 播放 / 暂停
            </span>
            <span>
              <kbd>←</kbd>
              <kbd>→</kbd> 跳转 5 秒
            </span>
            <span>
              <kbd>,</kbd>
              <kbd>.</kbd> 逐帧
            </span>
            <span>
              <kbd>C</kbd> 字幕
            </span>
            <span>
              <kbd>F</kbd> 全屏
            </span>
          </div>
        </div>
        {!embedded && (
          <aside className="inspector">
            <div className="inspector-header">
              作品信息 <span>PROJECT</span>
            </div>
            <div className="info-block">
              <span className="eyebrow">RENDER ENGINE</span>
              <h3>
                {project.renderer === "three"
                  ? "Three.js"
                  : project.renderer === "pixi"
                    ? "PixiJS"
                    : "Canvas + Flubber"}
              </h3>
              <p>{project.description}</p>
              <div className="tags">
                {project.tags.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            </div>
            <div className="info-block">
              <div className="info-row">
                <span>片长</span>
                <strong>{formatTime(project.duration)}</strong>
              </div>
              <div className="info-row">
                <span>项目帧率</span>
                <strong>{project.fps} fps</strong>
              </div>
              <div className="info-row">
                <span>画面比例</span>
                <strong>16 : 9</strong>
              </div>
              <label className="quality-label">
                预览画质
                <select
                  aria-label="信息栏预览画质"
                  value={quality}
                  disabled={exporting}
                  onChange={(e) => {
                    transport.current?.pause();
                    publish();
                    setQuality(e.target.value as Quality);
                  }}
                >
                  <option value="draft">流畅 · 360p</option>
                  <option value="standard">标准 · 720p</option>
                  <option value="high">精细 · 1080p</option>
                </select>
              </label>
            </div>
            <div className="info-block director">
              <span className="eyebrow">当前镜头</span>
              <h4>{currentBeat.title}</h4>
              <p>{currentBeat.detail}</p>
            </div>
            <div className="info-block subtitle-preview">
              <span className="eyebrow">中文字幕</span>
              <p>
                {activeSubtitle(project.subtitles, view.time) ||
                  "当前没有字幕，让画面自己说话。"}
              </p>
            </div>
            <div className="info-block credits">
              <span className="eyebrow">素材与署名</span>
              {project.credits.map((c) => (
                <p key={c}>{c}</p>
              ))}
            </div>
          </aside>
        )}
      </div>
      {hoverShot && timelineVisible && !exporting && <ShotThumbnail key={hoverShot.time} project={project} {...hoverShot} />}
      {exportOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setExportOpen(false);
          }}
        >
          <section
            className="export-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="导出作品"
          >
            <header>
              <div>
                <span className="eyebrow">EXPORT</span>
                <h2>从预览，到成片。</h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭导出"
                onClick={() => setExportOpen(false)}
              >
                <X size={22} />
              </button>
            </header>
            <button
              className="export-option"
              onClick={() => {
                if (canvas.current)
                  void downloadCanvas(
                    canvas.current,
                    project.id +
                      "-frame-" +
                      Math.round(view.time * project.fps) +
                      ".png",
                  ).catch((e) => setError(String(e)));
              }}
            >
              <Image size={23} />
              <div>
                <strong>当前帧 · PNG</strong>
                <span>按当前画质导出，包含已开启的字幕。</span>
              </div>
              <Download size={18} />
            </button>
            <button
              className="export-option"
              onClick={() =>
                downloadBlob(
                  new Blob([toSrt(project.subtitles)], {
                    type: "text/plain;charset=utf-8",
                  }),
                  project.id + ".srt",
                )
              }
            >
              <FileText size={23} />
              <div>
                <strong>中文字幕 · SRT</strong>
                <span>可继续用于剪辑、配音与多语言制作。</span>
              </div>
              <Download size={18} />
            </button>
            <div className="export-settings">
              <label>
                导出分辨率
                <select
                  aria-label="导出分辨率"
                  value={exportWidth}
                  onChange={(e) => setExportWidth(Number(e.target.value))}
                >
                  <option value={640}>640 × 360</option>
                  <option value={1280}>1280 × 720</option>
                  <option value={1920}>1920 × 1080</option>
                  <option value={3840}>3840 × 2160</option>
                </select>
              </label>
              <label>
                导出帧率
                <select
                  aria-label="导出帧率"
                  value={exportFps}
                  onChange={(e) => setExportFps(Number(e.target.value))}
                >
                  {[...new Set([12, 24, 25, 30, 60, project.fps])]
                    .sort((a, b) => a - b)
                    .map((fps) => (
                      <option key={fps} value={fps}>
                        {fps} fps
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {"showSaveFilePicker" in window && (
              <label>
                <input
                  type="checkbox"
                  checked={exportToDisk}
                  onChange={(event) => setExportToDisk(event.target.checked)}
                />
                直接保存到文件，适合较长作品
              </label>
            )}
            <button className="export-option" onClick={() => void renderWebm()}>
              <Video size={23} />
              <div>
                <strong>浏览器逐帧导出 · WebM</strong>
                <span>
                  逐帧渲染并离线混音，使用当前混音设置，可取消；预览卡顿不影响导出帧数。
                </span>
              </div>
              <Play size={18} />
            </button>
            {!embedded && (
              <div className="offline-export">
                <strong>正式输出 · 逐帧 MP4</strong>
                <p>
                  本地 FFmpeg + Playwright
                  逐帧渲染，不受实时播放掉帧影响。输出在项目 exports/ 目录。
                </p>
                <div className="command">
                  <code>{command}</code>
                  <button
                    className="icon-button"
                    aria-label="复制导出命令"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(command)
                        .then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        })
                        .catch(() => setError("剪贴板不可用，请手动复制命令。"))
                    }
                  >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
                <small>
                  支持 --width 3840、--fps 60、--start / --end、--no-subtitles。
                </small>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
