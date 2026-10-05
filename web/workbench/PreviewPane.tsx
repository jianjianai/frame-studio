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
} from "lucide-react";
import { formatTime } from "../lib/api";
import { usePersistent } from "../lib/ui";
import { useObservable, useWorkbench } from "./store";
import { RecordButton } from "./RecordButton";

export function PreviewPane() {
  const { work, stage, askAi, addToChat } = useWorkbench();
  const frame = useRef<HTMLIFrameElement>(null);
  const [quality, setQuality] = usePersistent<"draft" | "standard" | "high">("quality", "standard");
  const [subtitles, setSubtitles] = usePersistent("subtitles", true);
  const status = useObservable(stage.status);
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

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.source !== "frame-stage") return;
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
    addToChat({ type: "frame", time: stage.playback.get().time, data: dataUrl.split(",")[1], mimeType: "image/png" });
  };

  return (
    <div className="preview">
      <div className="preview-stage">
        <iframe ref={frame} src={src} title="作品预览" allow="autoplay; microphone; fullscreen" />
        {status.status === "loading" && (
          <div className="preview-overlay">
            <Loader2 className="spin" size={22} />
            <span>正在加载作品…</span>
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
              <button className="btn primary" onClick={() => askAi(`预览加载失败，请修复：\n${status.error}`)}>
                <Sparkles size={14} /> 让 AI 修复
              </button>
            </div>
          </div>
        )}
        {status.updating && <div className="preview-updating">正在更新…</div>}
      </div>
      <Transport
        quality={quality}
        setQuality={setQuality}
        subtitles={subtitles}
        setSubtitles={setSubtitles}
        onCapture={capture}
        onFullscreen={() => frame.current?.requestFullscreen()}
      />
    </div>
  );
}

function Transport({
  quality,
  setQuality,
  subtitles,
  setSubtitles,
  onCapture,
  onFullscreen,
}: {
  quality: string;
  setQuality: (value: "draft" | "standard" | "high") => void;
  subtitles: boolean;
  setSubtitles: (value: boolean) => void;
  onCapture: () => void;
  onFullscreen: () => void;
}) {
  const { stage } = useWorkbench();
  const playback = useObservable(stage.playback);
  const status = useObservable(stage.status);
  const duration = status.project?.duration ?? 0;
  const ready = status.status === "ready";
  const [scrub, setScrub] = useState<number | null>(null);
  const time = scrub ?? playback.time;
  return (
    <div className="transport">
      <div className="scrubber">
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.001}
          value={time}
          disabled={!ready}
          aria-label="播放位置"
          style={{ "--progress": `${duration ? (time / duration) * 100 : 0}%` } as React.CSSProperties}
          onChange={(event) => {
            const value = Number(event.target.value);
            setScrub(value);
            void stage.seek(value);
          }}
          onPointerUp={() => setScrub(null)}
          onKeyUp={() => setScrub(null)}
        />
      </div>
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
        <RecordButton />
        <button className="icon-btn" title="把当前画面发给 AI" disabled={!ready} onClick={onCapture}>
          <Camera size={16} />
        </button>
        <button className={`icon-btn ${playback.loop ? "active" : ""}`} title="循环" disabled={!ready} onClick={() => stage.api?.setLoop?.(!playback.loop)}>
          <Repeat size={16} />
        </button>
        <button className={`icon-btn ${subtitles ? "active" : ""}`} title="字幕" onClick={() => setSubtitles(!subtitles)}>
          <Captions size={16} />
        </button>
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
