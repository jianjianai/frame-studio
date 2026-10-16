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
  Columns2,
  Clapperboard,
  X,
  FileVideo,
  Upload,
} from "lucide-react";
import { api, formatBytes, formatTime, sampleName, workPath } from "../lib/api";
import { coverFromFrame } from "../lib/covers";
import type { FileEntry, WorkInfo } from "../lib/types";
import { useContextMenu, usePersistent, useToast, type MenuItem } from "../lib/ui";
import { uploadBlobs } from "../views/upload";
import { Observable, StageController, useObservable, useWorkbench } from "./store";
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

/** Videos the browser plays: what can be compared beside the film besides samples. */
export const isVideo = (path: string) => /\.(mp4|m4v|webm|mov)$/i.test(path);

/** The sample compared beside the film (a sample module or a video of the work), or null. */
export const compareTarget = new Observable<string | null>(null);
const compareKey = (work: WorkInfo) => `frame:compare:${work.repo}/${work.id}`;
/** Compare a sample beside the film, or stop (null); remembered for the work in this browser. */
export function setCompare(work: WorkInfo, path: string | null) {
  compareTarget.set(path);
  try {
    if (path) localStorage.setItem(compareKey(work), path);
    else localStorage.removeItem(compareKey(work));
  } catch {}
}
/** What can be compared: the work's samples (modules that declare `sample`), and its videos, those in sheets/ first. */
async function comparablesOf(work: WorkInfo) {
  const entries = await api<FileEntry[]>(`${workPath(work.repo, work.id)}/tree`).catch(() => [] as FileEntry[]);
  const videos = entries.filter((entry) => entry.type === "file" && isVideo(entry.path));
  return {
    samples: entries.filter((entry) => entry.scene === "sample"),
    videos: [...videos.filter((entry) => entry.path.startsWith("sheets/")), ...videos.filter((entry) => !entry.path.startsWith("sheets/"))],
  };
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
  // The comparison open when this work was last here.
  const compare = useObservable(compareTarget);
  useEffect(() => {
    try {
      compareTarget.set(localStorage.getItem(compareKey(work)));
    } catch {}
    return () => compareTarget.set(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work.repo, work.id]);
  const [openMenu, menu] = useContextMenu();
  /** Upload a video of the user's own into sheets/ and compare it. */
  const uploadVideo = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      toast(`正在上传 ${file.name}（${formatBytes(file.size)}）…`);
      try {
        const [saved] = await uploadBlobs(work, [file], "sheets");
        setCompare(work, saved.path);
        toast(`已上传到 ${saved.path}，放在成片旁边对比`, "ok");
      } catch (error) {
        toast((error as Error).message, "error");
      }
    };
    input.click();
  };
  /** Pick what to compare: a sample or a video of the work, or upload a video. */
  const pickSample = async (event: React.MouseEvent) => {
    const at = { clientX: event.clientX, clientY: event.clientY };
    const { samples, videos } = await comparablesOf(work);
    const choices = [...samples, ...videos];
    if (!choices.length && readOnly) return toast("作品里还没有样片或视频可以对比");
    // Only one thing it could be: no menu (an editable work offers uploading as well).
    if (choices.length === 1 && readOnly && !compare) return setCompare(work, choices[0].path);
    const item = (entry: FileEntry, video: boolean): MenuItem => ({
      label: `${video ? `视频：${entry.path}` : sampleName(entry.path)}${entry.duration ? `（${formatTime(entry.duration, false)}）` : ""}`,
      icon: video ? <FileVideo size={14} /> : <Clapperboard size={14} />,
      disabled: entry.path === compare,
      onClick: () => setCompare(work, entry.path),
    });
    openMenu(at, [
      ...samples.map((entry) => item(entry, false)),
      ...videos.map((entry) => item(entry, true)),
      ...(readOnly
        ? []
        : ([
            ...(choices.length ? ["separator"] : []),
            { label: "上传视频…（放进 sheets/，不进时间轴）", icon: <Upload size={14} />, onClick: uploadVideo },
          ] as MenuItem[])),
    ]);
  };
  return (
    <div className={`preview-pair ${compare ? "comparing" : ""}`}>
      <div className="preview-row">
        <StagePane
          stage={stage}
          src={src}
          title="作品预览"
          record
          onCover={readOnly ? undefined : coverHere}
          comparing={Boolean(compare)}
          onCompare={(event) => (compare ? setCompare(work, null) : void pickSample(event))}
        />
        {compare && <ComparePane key={compare} file={compare} onPick={pickSample} onClose={() => setCompare(work, null)} />}
      </div>
      {menu}
    </div>
  );
}

/**
 * A sample or a video beside the film. It plays and pauses with the film (and loops, being
 * short); its own controls are only where it is and how loud.
 */
function ComparePane({ file, onPick, onClose }: { file: string; onPick: (event: React.MouseEvent) => void; onClose: () => void }) {
  const video = isVideo(file);
  return (
    <div className="compare-pane">
      <div className="compare-head">
        {video ? <FileVideo size={13} /> : <Clapperboard size={13} />}
        <button className="compare-pick ellipsis" title={`对比的${video ? "视频" : "样片"}：${file}（点击换一个）`} onClick={onPick}>
          对比：{video ? file.split("/").pop() : sampleName(file)}
        </button>
        <span className="grow" />
        <button className="icon-btn" title="关闭对比" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {video ? <CompareVideo file={file} /> : <CompareSample file={file} />}
    </div>
  );
}

function CompareSample({ file }: { file: string }) {
  const { work, stage: film } = useWorkbench();
  const stage = useMemo(() => new StageController(), []);
  useEffect(() => {
    stage.follow(film);
    return () => stage.dispose();
  }, [stage, film]);
  const ready = useObservable(stage.status).status === "ready";
  useEffect(() => {
    if (!ready) return;
    stage.api?.setLoop?.(true);
    if (film.playback.get().playing) void stage.play();
  }, [ready, stage, film]);
  const src = useMemo(
    () => sampleStageSrc(work, file),
    // The stage hot-reloads itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [work.id, work.repo, file],
  );
  return <StagePane stage={stage} src={src} title={`对比样片 ${file}`} scene={file} compact />;
}

/**
 * A video of the work beside the film (one the user uploaded, say): like a sample, it plays and
 * pauses with the film and loops, with only its own scrubber and volume.
 */
function CompareVideo({ file }: { file: string }) {
  const { work, stage: film } = useWorkbench();
  const ref = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [failed, setFailed] = useState("");
  // The browser may refuse sound that did not start from a click on the page itself.
  const [silenced, setSilenced] = useState(false);
  const src = `${workPath(work.repo, work.id)}/raw?path=${encodeURIComponent(file)}`;
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const follow = (playing: boolean) => {
      if (!playing) return video.pause();
      video.play().catch((error: Error) => {
        if (error.name !== "NotAllowedError") return;
        video.muted = true;
        setSilenced(true);
        void video.play().catch(() => {});
      });
    };
    let playing = film.playback.get().playing;
    if (playing) follow(true);
    const stop = film.playback.subscribe(() => {
      const now = film.playback.get().playing;
      if (now === playing) return;
      playing = now;
      follow(now);
    });
    // The bar moves smoothly (timeupdate comes only a few times a second).
    let frame = requestAnimationFrame(function tick() {
      setTime(video.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => {
      stop();
      cancelAnimationFrame(frame);
      video.pause();
    };
  }, [film, src]);
  const setLevel = (value: number) => {
    const video = ref.current;
    if (!video) return;
    video.volume = value;
    video.muted = false;
    setVolume(value);
    setSilenced(false);
  };
  return (
    <div className="preview">
      <div className="preview-stage">
        <video
          ref={ref}
          className="compare-video"
          src={src}
          loop
          playsInline
          preload="auto"
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          onError={() => setFailed("浏览器播放不了这个视频（可能是 HEVC 等编码），请转成 MP4（H.264）后再上传")}
        />
        {failed && (
          <div className="preview-overlay error">
            <AlertTriangle size={22} />
            <pre>{failed}</pre>
          </div>
        )}
      </div>
      <div className="transport compact">
        <div className="scrubber">
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.001}
            value={time}
            disabled={!duration}
            aria-label="视频位置"
            style={{ "--progress": `${duration ? (time / duration) * 100 : 0}%` } as React.CSSProperties}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (ref.current) ref.current.currentTime = value;
              setTime(value);
            }}
          />
        </div>
        <div className="transport-row">
          <span className="time mono">
            {formatTime(time)} <span className="faint">/ {formatTime(duration)}</span>
          </span>
          {silenced ? (
            <button className="btn small" title="浏览器先静音播放了，点一下打开声音" onClick={() => setLevel(volume || 1)}>
              <VolumeX size={13} /> 打开声音
            </button>
          ) : (
            <span className="faint small-text ellipsis" title="成片播放、暂停时它也一起播放、暂停；播完从头循环">
              随成片播放、暂停
            </span>
          )}
          <span className="grow" />
          <div className="compare-volume">
            <button className="icon-btn" title="静音" onClick={() => setLevel(volume > 0 && !silenced ? 0 : 1)}>
              {volume > 0 && !silenced ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={silenced ? 0 : volume}
              aria-label="视频音量"
              onChange={(event) => setLevel(Number(event.target.value))}
            />
          </div>
        </div>
      </div>
    </div>
  );
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
  compact,
  comparing,
  onCompare,
}: {
  stage: StageController;
  src: string;
  title: string;
  scene?: string;
  /** Voice-over recording: for the film only. */
  record?: boolean;
  onCover?: () => void;
  /** Beside the film: only where it is and how loud. */
  compact?: boolean;
  /** The film: a sample is beside it; the button opens or closes that. */
  comparing?: boolean;
  onCompare?: (event: React.MouseEvent) => void;
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
      {compact ? (
        <CompactTransport stage={stage} />
      ) : (
        <Transport
          stage={stage}
          comparing={comparing}
          onCompare={onCompare}
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
      )}
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

function CompactTransport({ stage }: { stage: StageController }) {
  const { playback, time, drag } = useScrub(stage);
  const duration = useObservable(stage.status).project?.duration ?? 0;
  return (
    <div className="transport compact">
      <Scrubber stage={stage} time={time} drag={drag} />
      <div className="transport-row">
        <span className="time mono">
          {formatTime(time)} <span className="faint">/ {formatTime(duration)}</span>
        </span>
        <span className="faint small-text ellipsis" title="成片播放、暂停时它也一起播放、暂停；播完从头循环">
          随成片播放、暂停
        </span>
        <span className="grow" />
        <div className="compare-volume">
          <button className="icon-btn" title="静音" onClick={() => stage.api?.setVolume?.(playback.volume > 0 ? 0 : 1)}>
            {playback.volume > 0 ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={playback.volume}
            aria-label="样片音量"
            onChange={(event) => stage.api?.setVolume?.(Number(event.target.value))}
          />
        </div>
      </div>
    </div>
  );
}

function Transport({
  stage,
  comparing,
  onCompare,
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
  comparing?: boolean;
  onCompare?: (event: React.MouseEvent) => void;
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
        {onCompare && (
          <button className={`icon-btn ${comparing ? "active" : ""}`} title={comparing ? "关闭对比" : "和样片对比（并排播放）"} onClick={onCompare}>
            <Columns2 size={16} />
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
