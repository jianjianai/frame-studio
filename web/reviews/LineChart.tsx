import { useEffect, useMemo, useRef, useState } from "react";

export interface ChartSeries {
  id: string;
  label: string;
  /** A series color (validated slot, see reviews.css). */
  color: string;
  /** [x, y], ascending x. */
  points: [number, number][];
  /** A light wash under the line (one series only). */
  area?: boolean;
  /** A marker on every point: measured values, not a continuous curve. */
  dots?: boolean;
  /** Columns from the baseline instead of a line (amounts per hour). */
  bars?: boolean;
}

interface Props {
  series: ChartSeries[];
  /** Plot plus axes, in pixels. */
  height?: number;
  x: { domain: [number, number]; format: (value: number) => string; ticks?: number[] };
  /** `reference`: a value drawn as a labelled hairline (similar videos' level). */
  y: { domain?: [number, number]; format: (value: number) => string; reference?: { value: number; label: string } };
  /** Vertical hairlines with a label (the work's shots). */
  markers?: { at: number; label: string }[];
  /** Shaded stretches of x (where viewers leave). */
  bands?: { start: number; end: number }[];
  /** A vertical line that follows something outside (the playhead). */
  cursor?: number | null;
  /** The crosshair snaps to the points (measured values) or follows the pointer (curves). */
  snap?: "points" | "continuous";
  /** Click or drag on the plot. */
  onPick?: (x: number) => void;
  /** An extra line for the tooltip at x (e.g. the shot there). */
  describe?: (x: number) => string | null;
  label: string;
}

const MARGIN = { top: 10, right: 12, bottom: 22 };

/** A round step (1, 2, 2.5 or 5 × 10ⁿ) giving about `count` intervals over [min, max]. */
function niceStep(min: number, max: number, count: number) {
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw) ?? raw;
}

/** Round ticks inside [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 4) {
  if (!(max > min)) return [min];
  const step = niceStep(min, max, count);
  const ticks = [];
  for (let value = Math.ceil(min / step - 1e-9) * step; value <= max + step * 1e-9; value += step) ticks.push(+value.toPrecision(12));
  return ticks;
}

/**
 * A small line chart drawn at its container's width: thin lines, hairline grid, one
 * y-axis, a crosshair with one tooltip listing every series at that x, keyboard steps.
 */
export function LineChart({ series, height = 160, x, y, markers = [], bands = [], cursor = null, snap = "points", onPick, describe, label }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const yDomain = useMemo<[number, number]>(() => {
    if (y.domain) return y.domain;
    const values = [...series.flatMap((item) => item.points.map(([, value]) => value)), ...(y.reference ? [y.reference.value] : [])];
    // From zero (or below it, for values that can be negative), out to round ticks.
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    if (!(max > min)) return [0, 1];
    const step = niceStep(min, max, 4);
    return [Math.floor(min / step + 1e-9) * step, Math.ceil(max / step - 1e-9) * step];
  }, [series, y.domain, y.reference]);
  const yTicks = niceTicks(yDomain[0], yDomain[1], height < 140 ? 3 : 4);
  const left = Math.max(28, ...yTicks.map((tick) => y.format(tick).length * 6.5 + 8));
  const plotWidth = Math.max(10, width - left - MARGIN.right);
  const top = MARGIN.top + (markers.length ? 12 : 0);
  const plotHeight = Math.max(20, height - top - MARGIN.bottom);
  const [x0, x1] = x.domain;
  const sx = (value: number) => left + ((value - x0) / (x1 - x0 || 1)) * plotWidth;
  const sy = (value: number) => top + plotHeight - ((value - yDomain[0]) / (yDomain[1] - yDomain[0] || 1)) * plotHeight;
  const xTicks = x.ticks ?? niceTicks(x0, x1, Math.max(2, Math.floor(plotWidth / 70)));
  // Where the crosshair may stop: every point's x, or anywhere.
  const stops = useMemo(() => [...new Set(series.flatMap((item) => item.points.map(([at]) => at)))].sort((a, b) => a - b), [series]);
  const valueAt = (points: [number, number][], at: number): number | null => {
    if (!points.length || at < points[0][0] - 1e-9 || at > points[points.length - 1][0] + 1e-9) return null;
    for (let index = 0; index < points.length; index++) {
      if (Math.abs(points[index][0] - at) < 1e-9) return points[index][1];
      if (points[index][0] > at) {
        const [ax, ay] = points[index - 1];
        const [bx, by] = points[index];
        return ay + ((by - ay) * (at - ax)) / (bx - ax);
      }
    }
    return null;
  };
  const toX = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    const at = x0 + ((clientX - rect.left - left) / plotWidth) * (x1 - x0);
    const clamped = Math.max(x0, Math.min(x1, at));
    if (snap === "continuous" || !stops.length) return clamped;
    return stops.reduce((best, stop) => (Math.abs(stop - clamped) < Math.abs(best - clamped) ? stop : best), stops[0]);
  };
  const dragging = useRef(false);
  const path = (points: [number, number][]) => points.map(([at, value], index) => `${index ? "L" : "M"}${sx(at).toFixed(1)},${sy(value).toFixed(1)}`).join("");
  const shown = hover;
  // Measured series between two of their points are estimated there: marked "≈".
  const rows =
    shown === null
      ? []
      : series
          .map((item) => ({
            item,
            value: valueAt(item.points, shown),
            estimated: Boolean(item.dots) && !item.points.some(([at]) => Math.abs(at - shown) < 1e-9),
          }))
          .filter((row): row is { item: ChartSeries; value: number; estimated: boolean } => row.value !== null);
  const extra = shown !== null ? describe?.(shown) : null;
  // Shot labels only where they do not run into each other.
  let lastLabel = -Infinity;
  const labelled = markers.map((marker) => {
    const at = sx(marker.at);
    const show = at - lastLabel > 56 && at < left + plotWidth - 20;
    if (show) lastLabel = at;
    return { ...marker, x: at, show };
  });
  const step = (direction: number) => {
    const list = snap === "points" && stops.length ? stops : niceTicks(x0, x1, 20);
    const current = hover ?? (direction > 0 ? x0 - 1 : x1 + 1);
    const next = direction > 0 ? list.find((value) => value > current + 1e-9) : [...list].reverse().find((value) => value < current - 1e-9);
    if (next !== undefined) {
      setHover(next);
      onPick?.(next);
    }
  };

  return (
    <div
      ref={wrap}
      className={`line-chart ${onPick ? "pickable" : ""}`}
      style={{ height }}
      role="img"
      aria-label={label}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          step(event.key === "ArrowRight" ? 1 : -1);
        }
      }}
      onBlur={() => setHover(null)}
      onPointerMove={(event) => {
        if (!width) return;
        const at = toX(event.clientX);
        setHover(at);
        if (dragging.current) onPick?.(at);
      }}
      onPointerLeave={() => !dragging.current && setHover(null)}
      onPointerDown={(event) => {
        if (!onPick || !width) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        onPick(toX(event.clientX));
      }}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      {width > 0 && (
        <svg width={width} height={height} aria-hidden="true">
          {bands.map((band) => (
            <rect
              key={`${band.start}-${band.end}`}
              className="chart-band"
              x={sx(band.start)}
              y={top}
              width={Math.max(1, sx(band.end) - sx(band.start))}
              height={plotHeight}
            />
          ))}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line className={tick === 0 ? "chart-baseline" : "chart-grid"} x1={left} x2={left + plotWidth} y1={sy(tick)} y2={sy(tick)} />
              <text className="chart-tick" x={left - 6} y={sy(tick)} dy="0.32em" textAnchor="end">
                {y.format(tick)}
              </text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <text key={tick} className="chart-tick" x={sx(tick)} y={top + plotHeight + 15} textAnchor="middle">
              {x.format(tick)}
            </text>
          ))}
          {labelled.map((marker) => (
            <g key={`${marker.at}-${marker.label}`}>
              <line className="chart-marker" x1={marker.x} x2={marker.x} y1={top} y2={top + plotHeight} />
              {marker.show && (
                <text className="chart-marker-label" x={marker.x + 3} y={top - 4}>
                  {marker.label.length > 8 ? marker.label.slice(0, 7) + "…" : marker.label}
                </text>
              )}
            </g>
          ))}
          {series.map((item) =>
            item.area && item.points.length > 1 ? (
              <path
                key={`${item.id}-area`}
                d={`${path(item.points)}L${sx(item.points[item.points.length - 1][0]).toFixed(1)},${sy(yDomain[0])}L${sx(item.points[0][0]).toFixed(1)},${sy(yDomain[0])}Z`}
                fill={item.color}
                className="chart-area"
              />
            ) : null,
          )}
          {series.map((item) => {
            if (!item.bars) return <path key={item.id} d={path(item.points)} stroke={item.color} className="chart-line" />;
            // Thin columns with a rounded top, a gap between neighbours.
            const gap = item.points.length > 1 ? sx(item.points[1][0]) - sx(item.points[0][0]) : plotWidth;
            const barWidth = Math.max(1, Math.min(24, gap - 1));
            return (
              <g key={item.id}>
                {item.points.map(([at, value]) => {
                  const barTop = Math.min(sy(value), sy(0) - 0.5);
                  return (
                    <rect
                      key={at}
                      x={sx(at) - barWidth / 2}
                      y={barTop}
                      width={barWidth}
                      height={Math.max(0.5, sy(0) - barTop)}
                      rx={Math.min(2, barWidth / 2)}
                      fill={item.color}
                    />
                  );
                })}
              </g>
            );
          })}
          {y.reference && (
            <g>
              <line className="chart-reference" x1={left} x2={left + plotWidth} y1={sy(y.reference.value)} y2={sy(y.reference.value)} />
              <text className="chart-reference-label" x={left + plotWidth} y={sy(y.reference.value) - 3} textAnchor="end">
                {y.reference.label}
              </text>
            </g>
          )}
          {series.map((item) =>
            !item.bars && (item.dots || item.points.length === 1)
              ? item.points.map(([at, value]) => <circle key={`${item.id}-${at}`} className="chart-dot" cx={sx(at)} cy={sy(value)} r={4} fill={item.color} />)
              : null,
          )}
          {cursor !== null && cursor >= x0 && cursor <= x1 && (
            <line className="chart-cursor" x1={sx(cursor)} x2={sx(cursor)} y1={top - 2} y2={top + plotHeight} />
          )}
          {shown !== null && (
            <g>
              <line className="chart-crosshair" x1={sx(shown)} x2={sx(shown)} y1={top} y2={top + plotHeight} />
              {rows.map(({ item, value }) => (
                <circle key={item.id} className="chart-dot" cx={sx(shown)} cy={sy(value)} r={4} fill={item.color} />
              ))}
            </g>
          )}
        </svg>
      )}
      {shown !== null && (rows.length > 0 || extra) && (
        <div className={`chart-tooltip ${sx(shown) > width * 0.6 ? "left" : ""}`} style={{ left: sx(shown) }}>
          <div className="chart-tooltip-head">{x.format(shown)}</div>
          {rows.map(({ item, value, estimated }) => (
            <div key={item.id} className="chart-tooltip-row">
              <span className="chart-key" style={{ background: item.color }} />
              <strong title={estimated ? "两次记录之间的估计值" : undefined}>
                {estimated ? "≈ " : ""}
                {y.format(value)}
              </strong>
              {series.length > 1 && <span className="faint ellipsis">{item.label}</span>}
            </div>
          ))}
          {extra && <div className="chart-tooltip-extra faint">{extra}</div>}
        </div>
      )}
    </div>
  );
}

/** The legend under a chart of two or more series: a line key and the name. */
export function ChartLegend({ series }: { series: Pick<ChartSeries, "id" | "label" | "color">[] }) {
  if (series.length < 2) return null;
  return (
    <div className="chart-legend">
      {series.map((item) => (
        <span key={item.id} className="chart-legend-item">
          <span className="chart-key" style={{ background: item.color }} />
          <span className="ellipsis">{item.label}</span>
        </span>
      ))}
    </div>
  );
}
