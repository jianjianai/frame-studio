import { useEffect, useMemo, useRef, useState } from "react";
import {
  Play,
  Pause,
  SkipBack,
  StepBack,
  StepForward,
  Repeat,
  Volume2,
  VolumeX,
  Captions,
  Camera,
  Maximize2,
  RotateCw,
  Sparkles,
  AlertTriangle,
  Loader2,
  GalleryThumbnails,
} from "lucide-react";
import { formatTime } from "../lib/api";
import { coverFromFrame } from "../lib/covers";
import type { WorkInfo } from "../lib/types";
import { usePersistent, useToast } from "../lib/ui";
import { useObservable, useWorkbench, type StageController } from "./store";
import { RecordButton } from "./RecordButton";

/** The stage address of a module of the work played on its own (a sample). */
export function sampleStageSrc(work: WorkInfo, file: string) {
  let quality = "standard";
  try {
    quality = JSON.parse(localStorage.getItem("frame:quality") || '"standard"');
  } catch {}
  const params = new URLSearchParams({
    work: work.id,
    module: work.preview.module,
    assetBase: work.preview.assetBase,
    scene: work.preview.module.replace(/project\.ts$/, file),
    quality,
  });
  return `/preview/stage.html?${params}`;
}

/** The film on the workbench's stage: what the timeline, the AI's captures and the shortcuts work with. */
export function PreviewPane() {
  const { work, stage, readOnly } = useWorkbench();
  const toast = useToast();
  const [quality] = usePersistent<"draft" | "standard" | "high">("quality", "standard");
  const [subtitles] = usePersistent("subtitles", true);
  const src = useMemo(() => {
    const params = new URLSearchParams({
      work: work.id,
      module: work.preview.module,
      assetBase: work.preview.assetBase,
      quality,
      subtitles: subtitles ? "1" : "0",
    });
    return `/preview/stage.html?${params}`;
    // The stage hot-reloads itself; only a different work needs a new iframe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work.id, work.repo]);
  const coverHere = async () => {
    const time = stage.playback.get().time;
    try {
      await coverFromFrame(work.repo, work.id, time);
      toast(`已把 ${formatTime(time)} 的画面设为封面`, "ok");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  return <StagePane stage={stage} src={src} title="作品预览" record onCover={readOnly ? undefined : coverHere} />;
}

/**
 * A stage iframe with its player controls. `scene`: the module of the work it plays on its own
 * (a sample), so a frame sent to the AI says whose time it is.
 */
export function StagePane({
  stage,
  src,
  title,
  scene,
  record,
  onCover,
}: {
  stage: StageController;
  src: string;
  title: string;
  scene?: string;
  /** Voice-over recording: for the film only. */
  record?: boolean;
  onCover?: () => void;
}) {
  const { askAi, addToChat } = useWorkbench();
  const frame = useRef<HTMLIFrameElement>(null);
  const [quality, setQuality] = usePersistent<"draft" | "standard" | "high">("quality", "standard");
  const [subtitles, setSubtitles] = usePersistent("subtitles", true);
  const status = useObservable(stage.status);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.source !== "frame-stage") return;
      // Keys pressed while the preview has focus act as if pressed in the studio.
      if (event.data.type === "key") {
        const { key, code, ctrlKey, metaKey, shiftKey, altKey } = event.data;
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key, code, ctrlKey, metaKey, shiftKey, altKey, bubbles: true, cancelable: true }));
        return;
      }
      stage.handleMessage(event.data);
    };
    window.addEventListener("message", listener);
    stage.frame = frame.current;
    return () => window.removeEventListener("message", listener);
  }, [stage]);
  useEffect(() => stage.setQuality(quality), [quality, stage, status.status]);
  useEffect(() => stage.setSubtitles(subtitles), [subtitles, stage]);

  const capture = async () => {
    const dataUrl = await stage.capture();
    addToChat({ type: "frame", time: stage.playback.get().time, data: dataUrl.split(",")[1], mimeType: "image/png", ...(scene ? { scene } : {}) });
  };

  return (
    <div className="preview">
      <div className="preview-stage">
        <iframe ref={frame} src={src} title={title} allow="autoplay; microphone; fullscreen" />
        {status.status === "loading" && (
          <div className="preview-overlay">
            <Loader2 className="spin" size={22} />
            <span>{scene ? "正在加载样片…" : "正在加载作品…"}</span>
          </div>
        )}
        {status.status === "error" && (
          <div className="preview-overlay error">
            <AlertTriangle size={22} />
            <pre>{status.error}</pre>
            <div className="row">
              <button className="btn" onClick={() => stage.reload()}>
                <RotateCw size={14} /> 重新载入
              </button>
              <button className="btn primary" onClick={() => askAi(`${scene ? `样片 ${scene}` : "预览"}加载失败，请修复：\n${status.error}`)}>
                <Sparkles size={14} /> 让 AI 修复
              </button>
            </div>
          </div>
        )}
        {status.updating && <div className="preview-updating">正在更新…</div>}
      </div>
      <Transport
        stage={stage}
        quality={quality}
        setQuality={setQuality}
        subtitles={subtitles}
        // A silent sample has no subtitles to show.
        setSubtitles={scene && !status.project?.subtitles.length ? undefined : setSubtitles}
        record={record}
        onCapture={capture}
        onCover={onCover}
        onFullscreen={() => frame.current?.requestFullscreen()}
      />
    </div>
  );
}

/** The playhead while dragging: the dragged value until the stage reports the new position. */
function useScrub(stage: StageController) {
  const playback = useObservable(stage.playback);
  const [scrub, setScrub] = useState<number | null>(null);
  // It expires by itself: browsers do not reliably tell us when a slider drag ends (touch,
  // released elsewhere), and a value that never expired froze the bar while the video kept playing.
  const scrubTimer = useRef(0);
  useEffect(() => () => clearTimeout(scrubTimer.current), []);
  const drag = (value: number) => {
    setScrub(value);
    clearTimeout(scrubTimer.current);
    scrubTimer.current = window.setTimeout(() => setScrub(null), 400);
    void stage.seek(value);
  };
  return { playback, time: scrub ?? playback.time, drag };
}

function Scrubber({ stage, time, drag }: { stage: StageController; time: number; drag: (value: number) => void }) {
  const status = useObservable(stage.status);
  const duration = status.project?.duration ?? 0;
  return (
    <div className="scrubber">
      <input
        type="range"
        min={0}
        max={duration || 1}
        step={0.001}
        value={time}
        disabled={status.status !== "ready"}
        aria-label="播放位置"
        style={{ "--progress": `${duration ? (time / duration) * 100 : 0}%` } as React.CSSProperties}
        onChange={(event) => drag(Number(event.target.value))}
      />
    </div>
  );
}

function Transport({
  stage,
  quality,
  setQuality,
  subtitles,
  setSubtitles,
  record,
  onCapture,
  onCover,
  onFullscreen,
}: {
  stage: StageController;
  quality: string;
  setQuality: (value: "draft" | "standard" | "high") => void;
  subtitles: boolean;
  /** Absent when there are no subtitles to show. */
  setSubtitles?: (value: boolean) => void;
  record?: boolean;
  onCapture: () => void;
  /** Absent for a published work, and for a sample. */
  onCover?: () => void;
  onFullscreen: () => void;
}) {
  const { playback, time, drag } = useScrub(stage);
  const status = useObservable(stage.status);
  const duration = status.project?.duration ?? 0;
  const ready = status.status === "ready";
  return (
    <div className="transport">
      <Scrubber stage={stage} time={time} drag={drag} />
      <div className="transport-row">
        <button className="icon-btn" title="回到开头 (Home)" disabled={!ready} onClick={() => stage.seek(0)}>
          <SkipBack size={16} />
        </button>
        <button className="icon-btn" title="上一帧 (←)" disabled={!ready} onClick={() => stage.step(-1)}>
          <StepBack size={16} />
        </button>
        <button className="play-btn" title="播放/暂停 (空格)" disabled={!ready} onClick={() => stage.toggle()}>
          {playback.playing || playback.buffering ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button className="icon-btn" title="下一帧 (→)" disabled={!ready} onClick={() => stage.step(1)}>
          <StepForward size={16} />
        </button>
        <span className="time mono">
          {formatTime(time)} <span className="faint">/ {formatTime(duration)}</span>
        </span>
        {playback.buffering && <span className="badge warn">缓冲中</span>}
        <span className="grow" />
        {record && <RecordButton />}
        <button className="icon-btn" title="把当前画面发给 AI" disabled={!ready} onClick={onCapture}>
          <Camera size={16} />
        </button>
        {onCover && (
          <button className="icon-btn" title="把当前画面设为封面" disabled={!ready} onClick={onCover}>
            <GalleryThumbnails size={16} />
          </button>
        )}
        <button className={`icon-btn ${playback.loop ? "active" : ""}`} title="循环" disabled={!ready} onClick={() => stage.api?.setLoop?.(!playback.loop)}>
          <Repeat size={16} />
        </button>
        {setSubtitles && (
          <button className={`icon-btn ${subtitles ? "active" : ""}`} title="字幕" onClick={() => setSubtitles(!subtitles)}>
            <Captions size={16} />
          </button>
        )}
        <div className="volume">
          <button className="icon-btn" title="静音" onClick={() => stage.api?.setVolume?.(playback.volume > 0 ? 0 : 1)}>
            {playback.volume > 0 ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={playback.volume}
            aria-label="音量"
            onChange={(event) => stage.api?.setVolume?.(Number(event.target.value))}
          />
        </div>
        <select className="mini-select" value={playback.rate} title="播放速度" onChange={(event) => stage.api?.setRate?.(Number(event.target.value))}>
          {[0.25, 0.5, 1, 1.5, 2].map((rate) => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </select>
        <select className="mini-select" value={quality} title="预览画质" onChange={(event) => setQuality(event.target.value as "draft")}>
          <option value="draft">流畅</option>
          <option value="standard">标准</option>
          <option value="high">高清</option>
        </select>
        <button className="icon-btn" title="全屏" onClick={onFullscreen}>
          <Maximize2 size={15} />
        </button>
      </div>
    </div>
  );
}
