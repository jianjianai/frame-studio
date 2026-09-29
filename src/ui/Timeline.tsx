import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Captions, Film, Volume2, VolumeX } from "lucide-react";
import type { AnimationProject, AudioTrack } from "../engine/types";
import { clamp, formatTime } from "../engine/math";
import { TimelineDisclosure } from "./TimelineDisclosure";
import { TimelineNavigator } from "./TimelineNavigator";
import {
  snapTimelineTime,
  timelineTicks,
  timelineWheel,
  timelineWindow,
  type TimelineWindow,
} from "./timeline-layout";
import "./timeline.css";

type Selection = { start?: number; end?: number };
type Control = { gain: number; muted: boolean };
interface Props {
  project: AnimationProject;
  tracks: AudioTrack[];
  waveforms: Record<string, number[]>;
  time: number;
  playing: boolean;
  visible: boolean;
  disabled: boolean;
  selection: Selection;
  onSelection: (selection: Selection) => void;
  onSeek: (time: number) => void;
  onPause: () => void;
  onToggle: () => void;
  controls: Record<string, Control>;
  onTrackChange: (id: string, control: Control) => void;
  solo: string[];
  onSolo: (id: string) => void;
  subtitles: boolean;
  onSubtitles: () => void;
  onHoverShot: (
    shot: { time: number; title: string; x: number; y: number } | null,
  ) => void;
}

/** Source-defined clips stay immutable; this surface navigates, selects and mixes their preview. */
export function Timeline(p: Props) {
  const { project, time, selection, disabled } = p;
  const scroll = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [windowView, setWindowView] = useState<TimelineWindow>({
    start: 0,
    end: 1,
  });
  const [geometry, setGeometry] = useState({ width: 640, gutter: 152 });
  const [selected, setSelected] = useState("");
  const latest = useRef(p);
  latest.current = p;
  const viewRef = useRef(windowView);
  viewRef.current = windowView;
  const manualUntil = useRef(0);
  const drag = useRef<{
    id: number;
    mode: "seek" | "range" | "start" | "end";
    anchor: number;
    target: HTMLElement;
  } | null>(null);
  const frameTime = (value: number) =>
    `${formatTime(value)}:${String(Math.floor(value * project.fps + 0.001) % project.fps).padStart(2, "0")}`;
  const span = windowView.end - windowView.start;
  const laneWidth = geometry.width / span;
  const ticks = timelineTicks(project.duration, laneWidth, project.fps);
  const boundaries = useMemo(
    () => [
      0,
      project.duration,
      ...project.beats.map((b) => b.at),
      ...project.subtitles.flatMap((s) => [s.start, s.end]),
      ...p.tracks.flatMap((t) => [
        t.start ?? 0,
        (t.start ?? 0) + (t.duration ?? project.duration - (t.start ?? 0)),
      ]),
    ],
    [project],
  );
  const changeWindow = (next: TimelineWindow) => {
    manualUntil.current = performance.now() + 2500;
    p.onHoverShot(null);
    const minimum = Math.min(
      1,
      Math.max(1 / 64, 36 / Math.max(1, geometry.width + geometry.gutter - 18)),
    );
    setWindowView(
      timelineWindow(next.start, Math.max(next.end, next.start + minimum)),
    );
  };
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const measure = () => {
      if (!el.clientWidth) return;
      const gutter =
        parseFloat(
          getComputedStyle(el).getPropertyValue("--timeline-gutter"),
        ) || 152;
      setGeometry({ width: Math.max(1, el.clientWidth - gutter), gutter });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        (event.target as HTMLElement).closest(".timeline-popover")
      )
        return;
      event.preventDefault();
      manualUntil.current = performance.now() + 2500;
      const d = timelineWheel(
        event.deltaX,
        event.deltaY,
        event.deltaMode,
        event.shiftKey,
        el.clientWidth,
      );
      el.scrollLeft += d.left;
      el.scrollTop += d.top;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", wheel);
    };
  }, []);
  useLayoutEffect(() => {
    if (scroll.current && p.visible)
      scroll.current.scrollLeft = windowView.start * laneWidth;
  }, [windowView.start, windowView.end, geometry.width, p.visible]);
  useEffect(() => {
    if (!p.visible || drag.current || performance.now() < manualUntil.current)
      return;
    const view = viewRef.current,
      position = time / project.duration,
      size = view.end - view.start;
    if (position < view.start || position > view.end - size * 0.02)
      setWindowView(
        timelineWindow(position - size / 3, position + (size * 2) / 3),
      );
  }, [time, p.playing, p.visible, project.duration]);
  useEffect(() => {
    if (!p.visible) {
      drag.current = null;
      scroll.current
        ?.querySelectorAll<HTMLElement>(".timeline-popover:popover-open")
        .forEach((panel) => panel.hidePopover());
    }
  }, [p.visible]);
  useEffect(
    () => () => {
      drag.current = null;
    },
    [],
  );
  const pointerTime = (x: number, alt: boolean) => {
    const rect = ruler.current?.getBoundingClientRect();
    if (!rect) return 0;
    return snapTimelineTime(
      ((x - rect.left) / rect.width) * project.duration,
      project.duration,
      project.fps,
      boundaries,
      alt ? 0 : (project.duration / rect.width) * 6,
    );
  };
  const selectAt = (value: number) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === "range")
      p.onSelection({
        start: Math.min(d.anchor, value),
        end: Math.max(d.anchor, value),
      });
    else if (d.mode === "start")
      p.onSelection({
        ...latest.current.selection,
        start: Math.max(
          0,
          Math.min(
            value,
            (latest.current.selection.end ?? project.duration) -
              1 / project.fps,
          ),
        ),
      });
    else if (d.mode === "end")
      p.onSelection({
        ...latest.current.selection,
        end: Math.min(
          project.duration,
          Math.max(
            value,
            (latest.current.selection.start ?? 0) + 1 / project.fps,
          ),
        ),
      });
    else p.onSeek(value);
  };
  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    mode?: "start" | "end",
  ) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const value = pointerTime(event.clientX, event.altKey);
    const clip = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-clip]",
    );
    // Capture on the clip itself so the browser can still dispatch its double-click.
    const target = clip ?? event.currentTarget;
    target.focus({ preventScroll: true });
    target.setPointerCapture(event.pointerId);
    p.onPause();
    p.onHoverShot(null);
    drag.current = {
      id: event.pointerId,
      target,
      mode: mode ?? (event.shiftKey ? "range" : "seek"),
      anchor: value,
    };
    if (clip) setSelected(clip.dataset.clip!);
    selectAt(value);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    const el = scroll.current;
    if (el) {
      const r = el.getBoundingClientRect();
      if (event.clientX < r.left + geometry.gutter + 12) el.scrollLeft -= 18;
      else if (event.clientX > r.right - 12) el.scrollLeft += 18;
    }
    selectAt(pointerTime(event.clientX, event.altKey));
  };
  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d?.target.hasPointerCapture(event.pointerId))
      d.target.releasePointerCapture(event.pointerId);
  };
  const selectClip = (start: number, end: number) => {
    if (disabled) return;
    p.onPause();
    p.onSelection({ start, end });
    p.onSeek(start);
  };
  const fraction = (value: number) =>
    `${clamp(value / project.duration) * 100}%`;
  const selectionStyle =
    selection.start !== undefined &&
    selection.end !== undefined &&
    selection.end > selection.start
      ? {
          left: fraction(selection.start),
          width: `${((selection.end - selection.start) / project.duration) * 100}%`,
        }
      : undefined;
  const key = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (
      (event.target as HTMLElement).closest(
        "button:not([data-clip]),input,select,summary,[data-edge],.range-handle",
      ) ||
      disabled
    )
      return;
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        " ",
        "i",
        "I",
        "o",
        "O",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === " ") p.onToggle();
    else if (event.key.toLowerCase() === "i")
      p.onSelection({
        ...selection,
        start: time,
        ...(selection.end !== undefined && selection.end <= time
          ? { end: undefined }
          : {}),
      });
    else if (event.key.toLowerCase() === "o")
      p.onSelection({
        ...selection,
        end: time,
        ...(selection.start !== undefined && selection.start >= time
          ? { start: undefined }
          : {}),
      });
    else {
      p.onPause();
      p.onSeek(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? project.duration
            : time +
              (event.key === "ArrowLeft" ? -1 : 1) *
                (event.shiftKey ? 1 : 1 / project.fps),
      );
    }
  };
  return (
    <section
      id="work-timeline"
      className="timeline-panel editor-timeline"
      hidden={!p.visible}
      aria-label="作品时间轴"
      onKeyDown={key}
    >
      <div
        className="timeline-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label="时间轴轨道区域"
        title="滚轮横向滚动 · Shift＋滚轮上下滚动 · Shift＋拖动选段 · 双击片段选中范围"
        onScroll={() => {
          p.onHoverShot(null);
          const el = scroll.current;
          if (!el || !el.clientWidth) return;
          const start = el.scrollLeft / laneWidth;
          if (Math.abs(start - viewRef.current.start) > 0.0001)
            setWindowView(
              timelineWindow(
                start,
                start + (viewRef.current.end - viewRef.current.start),
              ),
            );
        }}
      >
        <div
          className="timeline-content"
          style={
            {
              width: geometry.gutter + laneWidth,
              "--tick-size": `${(ticks.interval / project.duration) * 100}%`,
            } as React.CSSProperties
          }
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
        >
          <div className="timeline-ruler-row">
            <div className="timeline-corner" aria-hidden="true">
              <span>{project.fps} FPS</span>
            </div>
            <div
              className="time-ruler"
              ref={ruler}
              role="slider"
              tabIndex={0}
              data-testid="timeline"
              aria-label="动画进度"
              aria-valuemin={0}
              aria-valuemax={project.duration}
              aria-valuenow={time}
              aria-valuetext={frameTime(time)}
              aria-disabled={disabled}
              onPointerDown={(e) => startDrag(e)}
            >
              {ticks.times.map((t, i) => (
                <span
                  key={t}
                  className={
                    i === 0
                      ? "tick-first"
                      : t === project.duration
                        ? "tick-last"
                        : ""
                  }
                  style={{ left: fraction(t) }}
                >
                  {frameTime(t)}
                </span>
              ))}
              {selectionStyle && (
                <div className="ruler-selection" style={selectionStyle} />
              )}
              <i className="ruler-playhead" style={{ left: fraction(time) }} />
              {(["start", "end"] as const).map(
                (edge) =>
                  selection[edge] !== undefined && (
                    <div
                      key={edge}
                      className={`range-handle range-${edge}`}
                      style={{ left: fraction(selection[edge]!) }}
                      role="slider"
                      tabIndex={0}
                      aria-label={edge === "start" ? "调整入点" : "调整出点"}
                      aria-valuemin={0}
                      aria-valuemax={project.duration}
                      aria-valuenow={selection[edge]}
                      aria-valuetext={frameTime(selection[edge]!)}
                      onPointerDown={(e) => startDrag(e, edge)}
                      onKeyDown={(event) => {
                        if (
                          !["ArrowLeft", "ArrowRight"].includes(event.key) ||
                          disabled
                        )
                          return;
                        event.preventDefault();
                        event.stopPropagation();
                        const value = clamp(
                          selection[edge]! +
                            (event.key === "ArrowLeft" ? -1 : 1) / project.fps,
                          0,
                          project.duration,
                        );
                        if (
                          edge === "start" &&
                          value >= (selection.end ?? project.duration)
                        )
                          return;
                        if (edge === "end" && value <= (selection.start ?? 0))
                          return;
                        p.onSelection({ ...selection, [edge]: value });
                      }}
                    >
                      {edge === "start" ? "I" : "O"}
                    </div>
                  ),
              )}
            </div>
          </div>
          <div className="tracks">
            <div className="track-label video-label">
              <Film size={14} />
              <span>V1 · 镜头</span>
              <small>{project.beats.length}</small>
            </div>
            <div
              className="clip-lane shot-track"
              tabIndex={-1}
              onPointerDown={(e) => startDrag(e)}
            >
              {project.beats.length === 0 && (
                <span className="empty-track">未定义镜头标记</span>
              )}
              {project.beats.map((b, i) => {
                const end = project.beats[i + 1]?.at ?? project.duration,
                  id = `shot-${i}`;
                return (
                  <button
                    key={id}
                    data-clip={id}
                    className={
                      selected === id || (time >= b.at && time < end)
                        ? "selected"
                        : ""
                    }
                    disabled={disabled}
                    style={{
                      left: fraction(b.at),
                      width: `${((end - b.at) / project.duration) * 100}%`,
                    }}
                    title={`${b.title} · ${frameTime(b.at)} → ${frameTime(end)}\n${b.detail}\n双击选择此镜头范围`}
                    aria-label={`${b.title}，${b.at.toFixed(2)} 秒`}
                    onClick={(e) => {
                      if (e.detail === 0) {
                        setSelected(id);
                        p.onPause();
                        p.onSeek(b.at);
                      }
                    }}
                    onDoubleClick={() => selectClip(b.at, end)}
                    onMouseEnter={(event) => {
                      if (drag.current) return;
                      const r = event.currentTarget.getBoundingClientRect();
                      p.onHoverShot({
                        time: b.at,
                        title: b.title,
                        x: Math.max(
                          geometry.gutter + 100,
                          Math.min(innerWidth - 100, r.left + r.width / 2),
                        ),
                        y: r.top,
                      });
                    }}
                    onMouseLeave={() => p.onHoverShot(null)}
                  >
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    {b.title}
                  </button>
                );
              })}
            </div>
            {p.tracks.map((track, i) => {
              const control = p.controls[track.id] ?? {
                gain: track.gain ?? 1,
                muted: track.muted ?? false,
              };
              const muted =
                control.muted ||
                (p.solo.length > 0 && !p.solo.includes(track.id));
              const update = (change: Partial<Control>) =>
                p.onTrackChange(track.id, { ...control, ...change });
              const values =
                p.waveforms[track.kind === "file" ? track.src : track.id] || [];
              const start = track.start ?? 0,
                end = start + (track.duration ?? project.duration - start);
              return (
                <Fragment key={track.id}>
                  <div className="track-label audio-label">
                    <TimelineDisclosure
                      className="track-volume"
                      label={`${track.name}音轨控制`}
                      summary={
                        <>
                          <small>A{i + 1}</small>
                          <span>{track.name}</span>
                        </>
                      }
                    >
                      <div className="track-volume-popup">
                        <label>
                          音量
                          <input
                            aria-label={`${track.name}音量`}
                            type="range"
                            min="0"
                            max="4"
                            step=".01"
                            value={control.gain}
                            disabled={disabled}
                            onChange={(e) =>
                              update({ gain: Number(e.target.value) })
                            }
                          />
                        </label>
                        <output>{Math.round(control.gain * 100)}%</output>
                        <small>
                          {track.kind === "file" ? "文件音频" : "代码生成音频"}{" "}
                          · {frameTime(start)} → {frameTime(end)}
                        </small>
                        <small>
                          源偏移 {frameTime(track.offset ?? 0)} ·
                          预览混音不改写作品文件
                        </small>
                      </div>
                    </TimelineDisclosure>
                    <button
                      className="track-mute"
                      aria-label={`${track.name}静音`}
                      title="静音"
                      aria-pressed={control.muted}
                      disabled={disabled}
                      onClick={() => update({ muted: !control.muted })}
                    >
                      {control.muted ? (
                        <VolumeX size={13} />
                      ) : (
                        <Volume2 size={13} />
                      )}
                    </button>
                    <button
                      className="track-solo"
                      aria-label={`${track.name}独听`}
                      title="独听"
                      aria-pressed={p.solo.includes(track.id)}
                      disabled={disabled}
                      onClick={() => p.onSolo(track.id)}
                    >
                      S
                    </button>
                  </div>
                  <div
                    className={`clip-lane audio-track individual-track ${muted ? "muted" : ""}`}
                    tabIndex={-1}
                    aria-label={`${track.name}时间轨道`}
                    onPointerDown={(e) => startDrag(e)}
                  >
                    <button
                      data-clip={`audio-${track.id}`}
                      className={`audio-clip ${selected === `audio-${track.id}` ? "selected" : ""} ${values.length ? "has-waveform" : "no-waveform"}`}
                      disabled={disabled}
                      style={{
                        left: fraction(start),
                        width: `${((end - start) / project.duration) * 100}%`,
                      }}
                      title={`${track.name} · ${frameTime(start)} → ${frameTime(end)}\n${track.kind === "file" ? "文件音频" : "代码音频"}${values.length ? "" : "（无预计算波形）"}`}
                      onClick={(e) => {
                        if (e.detail === 0) {
                          p.onPause();
                          p.onSeek(start);
                          setSelected(`audio-${track.id}`);
                        }
                      }}
                      onDoubleClick={() => selectClip(start, end)}
                    >
                      <span>
                        {track.name}
                        <small>
                          {track.kind === "generated" ? "代码音频" : "音频文件"}
                        </small>
                      </span>
                      {values.length > 0 && (
                        <svg
                          viewBox="0 0 720 32"
                          preserveAspectRatio="none"
                          aria-hidden="true"
                        >
                          {values.slice(0, 360).map((value, j) => (
                            <rect
                              key={j}
                              x={(j * 720) / Math.min(360, values.length)}
                              y={16 - clamp(value) * 14}
                              width="1.5"
                              height={2 + clamp(value) * 28}
                            />
                          ))}
                        </svg>
                      )}
                    </button>
                  </div>
                </Fragment>
              );
            })}
            <div className="track-label caption-label">
              <Captions size={14} />
              <span>C1 · 字幕</span>
              <button
                aria-label="时间轴字幕显示"
                title="显示或隐藏字幕"
                aria-pressed={p.subtitles}
                disabled={disabled}
                onClick={p.onSubtitles}
              >
                {p.subtitles ? "开" : "关"}
              </button>
            </div>
            <div
              className={`clip-lane subtitle-track ${p.subtitles ? "" : "muted"}`}
              tabIndex={-1}
              onPointerDown={(e) => startDrag(e)}
            >
              {project.subtitles.length === 0 && (
                <span className="empty-track">无字幕</span>
              )}
              {project.subtitles.map((s, i) => (
                <button
                  key={i}
                  data-clip={`subtitle-${i}`}
                  className={selected === `subtitle-${i}` ? "selected" : ""}
                  disabled={disabled}
                  style={{
                    left: fraction(s.start),
                    width: `${((s.end - s.start) / project.duration) * 100}%`,
                  }}
                  title={`${s.text}\n${frameTime(s.start)} → ${frameTime(s.end)}`}
                  onClick={(e) => {
                    if (e.detail === 0) {
                      p.onPause();
                      p.onSeek(s.start);
                      setSelected(`subtitle-${i}`);
                    }
                  }}
                  onDoubleClick={() => selectClip(s.start, s.end)}
                >
                  {s.text}
                </button>
              ))}
            </div>
            <div className="track-overlays" aria-hidden="true">
              <i className="track-playhead" style={{ left: fraction(time) }} />
              {selectionStyle && (
                <div className="timeline-selection" style={selectionStyle} />
              )}
            </div>
          </div>
        </div>
      </div>
      <TimelineNavigator
        view={windowView}
        onChange={changeWindow}
        time={time}
        duration={project.duration}
        beats={project.beats}
      />
    </section>
  );
}
