import { useRef, type RefObject } from "react";
import "./resize-handle.css";

/** One CSS pixel visually; a larger transparent hit target remains operable. */
export function ResizeHandle({ axis, value, min = 20, max = 80, containerRef, onChange, onDragChange, label }: {
  axis: "vertical" | "horizontal";
  value: number;
  min?: number;
  max?: number;
  containerRef: RefObject<HTMLElement | null>;
  onChange: (value: number) => void;
  onDragChange?: (dragging: boolean) => void;
  label: string;
}) {
  const pointer = useRef<number | null>(null);
  const update = (next: number) => onChange(Math.max(min, Math.min(max, next)));
  const finish = () => { pointer.current = null; onDragChange?.(false); };
  return <div className={"resize-handle " + axis} role="separator" aria-label={label}
    aria-orientation={axis} aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max}
    tabIndex={0}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      pointer.current = event.pointerId;
      onDragChange?.(true);
    }}
    onPointerMove={(event) => {
      if (pointer.current !== event.pointerId || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const length = axis === "vertical" ? rect.width : rect.height;
      if (length > 0) update(((axis === "vertical" ? event.clientX - rect.left : event.clientY - rect.top) / length) * 100);
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={(event) => {
      const previous = axis === "vertical" ? "ArrowLeft" : "ArrowUp";
      const next = axis === "vertical" ? "ArrowRight" : "ArrowDown";
      if (![previous, next, "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      update(event.key === "Home" ? min : event.key === "End" ? max : value + (event.key === previous ? -2 : 2));
    }} />;
}
