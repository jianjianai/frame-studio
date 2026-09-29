import { createPlayerSession } from "../engine/player-session";
import { exportPlayerVideo } from "./player-export";
import { compositionSize, fitComposition } from "../engine/dimensions.mjs";
import { playerCommandSchema } from "../contracts/platform.mjs";
import { useEffect, useRef, useState } from "react";
import { TimelineDisclosure } from "./TimelineDisclosure";
import { Timeline } from "./Timeline";
import { ResizeHandle } from "./ResizeHandle";
import { ShotThumbnail } from "./ShotThumbnail";
import {
  readPreference,
  writePreference,
  boundedPreference,
} from "./view-preferences";
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
  RefreshCw,
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
  const [workContext, setWorkContext] = useState<{
    title: string;
    compact: boolean;
    previewStatus: "ready" | "stale" | "building" | "unknown";
    updateDisabled: boolean;
  } | null>(null);
  const audioTracks = projectAudioTracks(project);
  const composition = compositionSize(project);
  const exportSizes = [640, 1280, 1920, 3840].map((edge) =>
    fitComposition(project, edge),
  );
  const [trackControls, setTrackControls] = useState<
    Record<string, { gain: number; muted: boolean }>
  >({});
  const [soloTracks, setSoloTracks] = useState<string[]>([]);
  const trackControlsRef = useRef(trackControls);
  trackControlsRef.current = Object.fromEntries(
    audioTracks.map((track) => {
      const control = trackControls[track.id] ?? {
        gain: track.gain ?? 1,
        muted: track.muted ?? false,
      };
      return [
        track.id,
        {
          ...control,
          muted:
            control.muted ||
            (soloTracks.length > 0 && !soloTracks.includes(track.id)),
        },
      ];
    }),
  );
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
  const initialView = useRef(
    readPreference<Record<string, unknown>>("frame.player-view", {}),
  );
  const editingArea = useRef<HTMLDivElement>(null);
  const [timelineVisible, setTimelineVisible] = useState(
    initialView.current.timelineVisible !== false,
  );
  const [videoRatio, setVideoRatio] = useState(() =>
    boundedPreference(initialView.current.videoRatio, 68, 25, 85),
  );
  const [resizing, setResizing] = useState(false);
  const [hoverShot, setHoverShot] = useState<{
    time: number;
    title: string;
    x: number;
    y: number;
  } | null>(null);
  const [quality, setQuality] = useState<Quality>(() =>
    ["draft", "standard", "high"].includes(String(initialView.current.quality))
      ? (initialView.current.quality as Quality)
      : "standard",
  );
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const viewConfigured = useRef(!embedded);
  const preferences = useRef({ timelineVisible, videoRatio, quality });
  preferences.current = { timelineVisible, videoRatio, quality };
  useEffect(() => {
    if (!viewConfigured.current) return;
    writePreference("frame.player-view", preferences.current);
    if (embedded && parent !== window)
      parent.postMessage(
        { type: "frame-player-preferences", preferences: preferences.current },
        "*",
      );
  }, [timelineVisible, videoRatio, quality, embedded]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportWidth, setExportWidth] = useState(
    () => fitComposition(project, 1920).width,
  );
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
  const [selection, setSelection] = useState<{ start?: number; end?: number }>(
    {},
  );
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const segmentEnd = useRef<number | null>(null);
  const frameTime = (time: number) =>
    `${formatTime(time)}:${String(Math.floor(time * project.fps + 0.001) % project.fps).padStart(2, "0")}`;
  const updateSelection = (value: { start?: number; end?: number }) => {
    segmentEnd.current = null;
    selectionRef.current = value;
    setSelection(value);
  };
  const exportAbort = useRef<AbortController | null>(null);
  const lastExport = useRef<Blob | null>(null);
  const reportExport = (
    id: string | undefined,
    result: Record<string, unknown>,
  ) => {
    if (id && embedded && parent !== window)
      parent.postMessage({ type: "frame-export-state", id, ...result }, "*");
  };
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
            composition,
            quality: qualityRef.current,
            subtitles: subtitleRef.current,
            selection: selectionRef.current,
            shotId: project.beats.reduce<(typeof project.beats)[number] | undefined>((found, shot) => shot.at <= value.time && (!found || shot.at > found.at) ? shot : found, undefined)?.id,
          },
          "*",
        );
    }
  };
  const commandHandler = useRef<(data: Record<string, any>) => void>(() => {});
  commandHandler.current = (data) => {
    if (data.command === "export") setExportOpen(true);
    if (data.command === "export-start")
      void renderWebm({ ...data.options, requestId: String(data.id || "") });
    if (data.command === "export-cancel") exportAbort.current?.abort();
    if (data.command === "export-download" && lastExport.current)
      downloadBlob(lastExport.current, project.id + ".webm");
    if (data.command === "snapshot" && canvas.current)
      void downloadCanvas(
        canvas.current,
        project.id + "-frame-" + Math.round(view.time * project.fps) + ".png",
      ).catch((error) =>
        parent.postMessage(
          { type: "frame-download-error", message: String(error) },
          "*",
        ),
      );
    if (data.command === "subtitles")
      downloadBlob(
        new Blob([toSrt(project.subtitles)], {
          type: "text/plain;charset=utf-8",
        }),
        project.id + ".srt",
      );
    if (data.command === "pause") {
      transport.current?.pause();
      publish();
    }
    if (data.command === "play" && transport.current && !loading && !exporting) {
      segmentEnd.current = Number.isFinite(data.end) ? Math.min(project.duration, data.end) : null;
      void transport.current.play().then(publish).catch(error => setError(String(error.message || error)));
    }
    if (data.command === "seek" && Number.isFinite(data.time)) {
      transport.current?.pause();
      if (
        data.selection &&
        Number.isFinite(data.selection.start) &&
        Number.isFinite(data.selection.end) &&
        data.selection.end > data.selection.start
      ) {
        const start = Math.max(0, Math.min(project.duration, data.selection.start));
        const end = Math.min(project.duration, data.selection.end);
        updateSelection(end > start ? { start, end } : {});
      }
      else updateSelection({});
      seek(data.time);
    }
    if (data.command === "configure-work") setWorkContext(data.context);
    if (
      data.command === "configure-view" &&
      data.preferences &&
      typeof data.preferences === "object"
    ) {
      const p = data.preferences;
      viewConfigured.current = true;
      if (typeof p.timelineVisible === "boolean")
        setTimelineVisible(p.timelineVisible);
      if (Number.isFinite(p.videoRatio))
        setVideoRatio(boundedPreference(p.videoRatio, 68, 25, 85));
      if (
        ["draft", "standard", "high"].includes(p.quality) &&
        p.quality !== qualityRef.current
      ) {
        transport.current?.pause();
        publish();
        setQuality(p.quality);
      }
    }
  };
  useEffect(() => {
    if (!embedded || parent === window) return;
    const receive = (event: MessageEvent) => {
      if (
        event.source === parent &&
        event.data?.type === "frame-player-command"
      ) {
        const message = playerCommandSchema.safeParse(event.data);
        if (message.success) commandHandler.current(message.data);
      }
    };
    window.addEventListener("message", receive);
    parent.postMessage({ type: "frame-player-ready" }, "*");
    return () => window.removeEventListener("message", receive);
  }, [embedded]);
  useEffect(() => {
    publish();
  }, [selection]);
  const seek = (t: number) => {
    if (exporting || exportAbort.current) return;
    transport.current?.seek(t);
    renderer.current?.render(
      transport.current?.clock.time() ?? 0,
      subtitleRef.current,
    ).catch((error) => { transport.current?.pause(); setError(String(error)); });
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
      await renderer.current?.render(a.clock.time(),subtitleRef.current);
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
    const session = createPlayerSession({
      canvas: canvas.current!,
      project,
      quality,
      embedded,
      initial: saved.current,
      controls: trackControlsRef.current,
      subtitles: () => subtitleRef.current,
      segmentEnd: () => segmentEnd.current,
      onSegmentEnd: () => {
        segmentEnd.current = null;
      },
      onSnapshot: (value) => {
        saved.current = value;
        setView(value);
        publish();
      },
      onLoading: setLoading,
      onError: setError,
      onFps: setFps,
      onTrackControl: (id, control) =>
        setTrackControls((previous) => ({ ...previous, [id]: control })),
    });
    transport.current = session.audio;
    renderer.current = session.renderer;
    return () => {
      exportAbort.current?.abort();
      const snapshot = session.snapshot();
      saved.current = { ...snapshot, playing: false, buffering: false };
      session.dispose();
      if (transport.current === session.audio) transport.current = null;
      if (renderer.current === session.renderer) renderer.current = null;
    };
  }, [project, quality, retry]);
  useEffect(() => {
    for (const [id, control] of Object.entries(trackControlsRef.current))
      transport.current?.setTrack(id, control);
  }, [project, quality, retry, trackControls, soloTracks]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const element = e.target as HTMLElement;
      if (
        element.closest(
          "input,textarea,select,button,a,summary,[role=slider],[role=separator]",
        ) ||
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
  async function renderWebm(options?: Parameters<typeof exportPlayerVideo>[1]) {
    return exportPlayerVideo(
      {
        project,
        transport,
        exportAbort,
        publish,
        setError,
        setExporting,
        setExportOpen,
        setExportProgress,
        exportToDisk,
        exportWidth,
        exportFps,
        subtitleRef,
        loading,
        reportExport,
        lastExport,
      },
      options,
    );
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
    <div
      className={"player-page" + (embedded ? " work-player" : "")}
      style={
        {
          "--frame-aspect": `${composition.width} / ${composition.height}`,
        } as React.CSSProperties
      }
    >
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
        <div
          ref={editingArea}
          className={
            "editing-area review-layout " +
            (resizing ? "dragging" : "") +
            (timelineVisible ? "" : " timeline-hidden")
          }
          style={{
            gridTemplateRows: timelineVisible
              ? `minmax(min(200px, 45%), ${videoRatio}fr) 1px minmax(min(144px, 40%), ${100 - videoRatio}fr) auto`
              : "minmax(0,1fr) auto",
          }}
        >
          <div className="theater" ref={theater}>
            <div className={"stage-top" + (embedded ? " work-stage-top" : "")}>
              <span>
                {embedded && !workContext?.compact ? (
                  <span
                    className="work-preview-title"
                    role="heading"
                    aria-level={1}
                    title={workContext?.title || project.title}
                  >
                    {workContext?.title || project.title}
                  </span>
                ) : (
                  <>
                    <i className="status-dot" /> 实时画面
                  </>
                )}
                <select
                  className="preview-quality"
                  aria-label="预览画质"
                  value={quality}
                  disabled={loading || exporting}
                  onChange={(event) => {
                    viewConfigured.current = true;
                    transport.current?.pause();
                    publish();
                    setQuality(event.target.value as Quality);
                  }}
                >
                  <option value="draft">流畅 360p</option>
                  <option value="standard">标准 720p</option>
                  <option value="high">精细 1080p</option>
                </select>
              </span>
              {embedded && workContext && (
                <div className="preview-update-controls">
                  <span
                    className={
                      "work-preview-status " + workContext.previewStatus
                    }
                    role="status"
                  >
                    {
                      {
                        ready: "预览最新",
                        stale: "预览待更新",
                        building: "正在更新预览",
                        unknown: "版本核对失败",
                      }[workContext.previewStatus]
                    }
                  </span>
                  <button
                    type="button"
                    className="preview-update-button"
                    aria-label="更新预览"
                    title="根据最新作品代码重新生成预览，不改变保存或远端同步状态"
                    disabled={workContext.updateDisabled || exporting}
                    onClick={() =>
                      parent.postMessage(
                        { type: "frame-preview-update-request" },
                        "*",
                      )
                    }
                  >
                    {workContext.previewStatus === "building" ? (
                      <LoaderCircle className="spin" size={13} />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    <span>更新预览</span>
                  </button>
                </div>
              )}
              <span className="stage-diagnostics">
                {(() => {
                  const size = fitComposition(
                    project,
                    quality === "high"
                      ? 1920
                      : quality === "draft"
                        ? 640
                        : 1280,
                  );
                  return `${size.width} × ${size.height}`;
                })()}{" "}
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
              <input
                className="video-progress"
                type="range"
                min={0}
                max={project.duration}
                step={1 / project.fps}
                aria-label="视频播放进度"
                aria-valuetext={
                  frameTime(view.time) + " / " + frameTime(project.duration)
                }
                value={view.time}
                disabled={loading || exporting}
                onChange={(event) => seek(Number(event.target.value))}
                style={
                  {
                    "--progress": (view.time / project.duration) * 100 + "%",
                  } as React.CSSProperties
                }
              />
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
                  className="icon-button"
                  aria-label="上一帧"
                  title="上一帧（,）"
                  disabled={loading || exporting}
                  onClick={() => {
                    transport.current?.pause();
                    segmentEnd.current = null;
                    seek(view.time - 1 / project.fps);
                  }}
                >
                  <StepBack size={17} />
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
                <button
                  className="icon-button"
                  aria-label="下一帧"
                  title="下一帧（.）"
                  disabled={loading || exporting}
                  onClick={() => {
                    transport.current?.pause();
                    segmentEnd.current = null;
                    seek(view.time + 1 / project.fps);
                  }}
                >
                  <StepForward size={17} />
                </button>
                <TimelineDisclosure
                  className="timeline-options timecode-disclosure"
                  label="定位与选段"
                  summary={
                    <div className="timecode">
                      <strong data-testid="timecode">
                        {frameTime(view.time)}
                      </strong>
                      <span>/ {frameTime(project.duration)}</span>
                    </div>
                  }
                >
                  <div className="range-controls">
                    <label>
                      定位帧{" "}
                      <input
                        aria-label="定位帧"
                        type="number"
                        min="0"
                        max={Math.round(project.duration * project.fps)}
                        placeholder={String(
                          Math.round(view.time * project.fps),
                        )}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            event.currentTarget.value !== ""
                          ) {
                            seek(
                              Number(event.currentTarget.value) / project.fps,
                            );
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </label>
                    <button
                      disabled={loading || exporting}
                      onClick={() =>
                        updateSelection({
                          ...selection,
                          start:
                            Math.floor(view.time * project.fps) / project.fps,
                          ...(selection.end !== undefined &&
                          selection.end <= view.time
                            ? { end: undefined }
                            : {}),
                        })
                      }
                    >
                      设为入点
                    </button>
                    <button
                      disabled={loading || exporting}
                      onClick={() =>
                        updateSelection({
                          ...selection,
                          end: Math.ceil(view.time * project.fps) / project.fps,
                          ...(selection.start !== undefined &&
                          selection.start >= view.time
                            ? { start: undefined }
                            : {}),
                        })
                      }
                    >
                      设为出点
                    </button>
                    <span>
                      {selection.start === undefined
                        ? "—"
                        : frameTime(selection.start)}{" "}
                      →{" "}
                      {selection.end === undefined
                        ? "—"
                        : frameTime(selection.end)}
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
                          updateSelection({});
                        }}
                      >
                        清除选段
                      </button>
                    )}
                  </div>
                </TimelineDisclosure>
              </div>
              <div className="transport-right">
                <button
                  className={
                    "icon-button timeline-toggle " +
                    (timelineVisible ? "active" : "")
                  }
                  aria-label={timelineVisible ? "隐藏时间轴" : "显示时间轴"}
                  aria-controls="work-timeline"
                  aria-expanded={timelineVisible}
                  title={timelineVisible ? "隐藏时间轴" : "显示时间轴"}
                  onClick={() => {
                    viewConfigured.current = true;
                    setTimelineVisible(!timelineVisible);
                  }}
                >
                  <SlidersHorizontal size={18} />
                </button>
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
          {timelineVisible && (
            <ResizeHandle
              axis="horizontal"
              value={videoRatio}
              min={25}
              max={85}
              containerRef={editingArea}
              onChange={(value) => {
                viewConfigured.current = true;
                setVideoRatio(value);
              }}
              onDragChange={setResizing}
              label="调整视频与时间轴高度"
            />
          )}
          <Timeline
            project={project}
            tracks={audioTracks}
            waveforms={waveforms}
            time={view.time}
            playing={view.playing}
            visible={timelineVisible}
            disabled={loading || exporting}
            selection={selection}
            onSelection={updateSelection}
            onSeek={seek}
            onPause={() => {
              transport.current?.pause();
              segmentEnd.current = null;
              publish();
            }}
            onToggle={() => void toggle()}
            controls={trackControls}
            onTrackChange={(id, control) =>
              setTrackControls((previous) => ({ ...previous, [id]: control }))
            }
            solo={soloTracks}
            onSolo={(id) =>
              setSoloTracks((previous) =>
                previous.includes(id)
                  ? previous.filter((track) => track !== id)
                  : [...previous, id],
              )
            }
            subtitles={showSubtitles}
            onSubtitles={() => setShowSubtitles((value) => !value)}
            onHoverShot={setHoverShot}
          />
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
            {currentBeat && <div className="info-block director">
              <span className="eyebrow">当前镜头</span>
              <h4>{currentBeat.title}</h4>
              <p>{currentBeat.detail}</p>
            </div>}
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
      {hoverShot && timelineVisible && !exporting && (
        <ShotThumbnail key={hoverShot.time} project={project} {...hoverShot} />
      )}
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
                  {exportSizes.map((size) => (
                    <option key={size.width} value={size.width}>
                      {size.width} × {size.height}
                    </option>
                  ))}
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
