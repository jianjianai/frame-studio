import { useRef } from "react";
import {
  MIN_TIMELINE_SPAN,
  moveTimelineWindow,
  timelineWindow,
  type TimelineWindow,
} from "./timeline-layout";

/** One overview bar: drag its middle to pan, either edge to zoom, double-click to fit. */
export function TimelineNavigator({
  view,
  onChange,
  time,
  duration,
  beats,
}: {
  view: TimelineWindow;
  onChange: (next: TimelineWindow) => void;
  time: number;
  duration: number;
  beats: { at: number }[];
}) {
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: number;
    x: number;
    width: number;
    view: TimelineWindow;
    mode: "pan" | "start" | "end";
  } | null>(null);
  const span = view.end - view.start;
  const minSpan = () =>
    Math.min(
      1,
      Math.max(MIN_TIMELINE_SPAN, 36 / (bar.current?.clientWidth || 640)),
    );
  const change = (mode: "pan" | "start" | "end", delta: number) =>
    onChange(moveTimelineWindow(view, mode, delta, minSpan()));
  return (
    <div
      className="timeline-navigator"
      ref={bar}
      title="拖动中间平移；拖动两端缩放；双击查看全片"
      onDoubleClick={() => onChange({ start: 0, end: 1 })}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          event.target !== event.currentTarget ||
          !bar.current
        )
          return;
        const r = bar.current.getBoundingClientRect();
        const start = (event.clientX - r.left) / r.width - span / 2;
        onChange(timelineWindow(start, start + span));
      }}
    >
      <div className="navigator-marks" aria-hidden="true">
        {beats.map((beat) => (
          <i key={beat.at} style={{ left: `${(beat.at / duration) * 100}%` }} />
        ))}
      </div>
      <i
        className="navigator-playhead"
        aria-hidden="true"
        style={{ left: `${(time / duration) * 100}%` }}
      />
      <div
        className="navigator-window"
        style={{ left: `${view.start * 100}%`, width: `${span * 100}%` }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !bar.current) return;
          event.preventDefault();
          const target = event.target as HTMLElement;
          const mode =
            target.dataset.edge === "start"
              ? "start"
              : target.dataset.edge === "end"
                ? "end"
                : "pan";
          target.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            width: bar.current.clientWidth,
            view: { ...view },
            mode,
          };
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (d?.id === event.pointerId)
            onChange(
              moveTimelineWindow(
                d.view,
                d.mode,
                (event.clientX - d.x) / d.width,
                minSpan(),
              ),
            );
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        {(["start", "pan", "end"] as const).map((mode) => (
          <div
            key={mode}
            data-edge={mode}
            className={`navigator-${mode}`}
            role="slider"
            tabIndex={0}
            aria-label={
              mode === "pan"
                ? "时间轴可视范围"
                : mode === "start"
                  ? "时间轴可视起点"
                  : "时间轴可视终点"
            }
            aria-valuemin={mode === "end" ? view.start * duration : 0}
            aria-valuemax={mode === "start" ? view.end * duration : duration}
            aria-valuenow={(mode === "end" ? view.end : view.start) * duration}
            aria-valuetext={`${(view.start * duration).toFixed(2)} 至 ${(view.end * duration).toFixed(2)} 秒`}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End", "0"].includes(
                  event.key,
                )
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "0") onChange({ start: 0, end: 1 });
              else
                change(
                  mode,
                  event.key === "Home"
                    ? -1
                    : event.key === "End"
                      ? 1
                      : (event.key === "ArrowLeft" ? -1 : 1) *
                        span *
                        (event.shiftKey ? 0.1 : 0.02),
                );
            }}
          />
        ))}
      </div>
    </div>
  );
}
