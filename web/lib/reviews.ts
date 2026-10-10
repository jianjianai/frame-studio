/** Reviews of posted videos (server/reviews.mjs): types, addresses and how numbers read. */

export interface Post {
  id: string;
  platform: string;
  account?: string;
  url?: string;
  title?: string;
  postedAt: string;
  /** Length of the posted video (seconds). */
  duration?: number;
  /** The exported file that was posted, and the work version it came from. */
  export?: string;
  version?: string;
  notes?: string;
}
export interface Snapshot {
  post: string;
  at: string;
  source?: string;
  /** Totals up to `at`; ratios 0–1, durations in seconds. */
  metrics: Record<string, number>;
  /** [second of the video, share still watching]. */
  retention?: [number, number][];
}
export interface Review {
  work: string;
  title: string;
  posts: Post[];
  snapshots: Snapshot[];
}
export interface MetricDefinition {
  key: string;
  label: string;
  kind: "count" | "ratio" | "seconds";
  of?: string[];
}
export interface Definitions {
  metrics: MetricDefinition[];
  derived: MetricDefinition[];
  platforms: string[];
  checkpoints: string[];
  columns: string[];
}
/** A stretch of the retention curve: viewers leaving (drop) or coming back (rise). */
export interface Stretch {
  start: number;
  end: number;
  from: number;
  to: number;
  shot?: { at: number; title: string };
  subtitle?: string;
}
export interface Analysis {
  opening: { seconds: number; kept: number; lost: number };
  half: number;
  end: number;
  drops: Stretch[];
  rises: Stretch[];
}
export interface RawFile {
  path: string;
  size: number;
  kind: string;
  /** Some snapshot names it as its source. */
  used: boolean;
}
export interface ReviewDetail {
  review: Review;
  files: RawFile[];
  documents: { path: string; title: string }[];
  /** The newest numbers per post with their rates; `ages` says how old each one is (days after posting). */
  summary: Record<string, { at: string; age: number; metrics: Record<string, number>; ages: Record<string, number> }>;
  /** Every snapshot per post (days after posting), with the derived rates. */
  history: Record<string, { at: string; age: number; metrics: Record<string, number> }[]>;
  analyses: Record<string, Analysis>;
  definitions: Definitions;
}
export interface CompareRow {
  repo: string;
  work: string;
  title: string;
  missing?: boolean;
  post: string;
  platform: string;
  postTitle: string;
  url: string;
  postedAt: string;
  duration: number;
  shape: string;
  tags: string[];
  experiences: string[];
  /** Days after posting of the numbers shown (null: none near the checkpoint). */
  age: number | null;
  metrics: Record<string, number>;
  /** Retention at 0, 2 %, … 100 % of the video. */
  curve?: [number, number][];
  /** Every snapshot: days after posting and its numbers. */
  history?: { age: number; metrics: Record<string, number> }[];
  snapshots: number[];
}

export const reviewsPath = (repo: string) => `/api/repos/${encodeURIComponent(repo)}/reviews`;

export const CHECKPOINT_LABELS: Record<string, string> = {
  "1d": "第 1 天",
  "3d": "第 3 天",
  "7d": "第 7 天",
  "14d": "第 14 天",
  "30d": "第 30 天",
  latest: "最新",
};

export function definitionOf(definitions: Definitions | null | undefined, key: string): MetricDefinition {
  const found = definitions && [...definitions.metrics, ...definitions.derived].find((item) => item.key === key);
  return found ?? { key, label: key, kind: /率|比例|占比/.test(key) ? "ratio" : "count" };
}

/** 0.314 → 31.4%, 0.0034 → 0.34%. */
export function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const percent = value * 100;
  return `${percent >= 10 ? +percent.toFixed(1) : percent >= 1 ? +percent.toFixed(2) : +percent.toPrecision(2)}%`;
}

/** Counts the Chinese way once they get long: 12,034 · 12.5万 · 1.2亿. */
export function formatCount(value: number, compact = false) {
  if (compact && Math.abs(value) >= 1e8) return `${+(value / 1e8).toFixed(2)}亿`;
  if (compact && Math.abs(value) >= 1e5) return `${+(value / 1e4).toFixed(1)}万`;
  return Number.isInteger(value) ? value.toLocaleString("en-US") : String(+value.toPrecision(6));
}

export function formatMetric(definitions: Definitions | null | undefined, key: string, value: number | null | undefined, compact = false) {
  if (value == null || !Number.isFinite(value)) return "—";
  const { kind } = definitionOf(definitions, key);
  if (kind === "ratio") return formatPercent(value);
  if (kind === "seconds") return `${+value.toFixed(1)} 秒`;
  return formatCount(value, compact);
}

export const ageDays = (post: Pick<Post, "postedAt">, at: string) => (Date.parse(at) - Date.parse(post.postedAt)) / 86400000;
/** "第 6.5 天", or "第 18 小时" within the first day. */
export const ageShort = (days: number) => (days < 1 ? `第 ${Math.max(0, Math.round(days * 24))} 小时` : `第 ${+days.toFixed(1)} 天`);
export const ageLabel = (days: number) => `发布后 ${ageShort(days).slice(2)}`;

/** "2026-10-08 20:00" in the viewer's time zone. */
export function formatDateTime(iso: string) {
  const date = new Date(iso);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** The value of an <input type="datetime-local"> for a moment, and back. */
export const toLocalInput = (iso: string) => formatDateTime(iso).replace(" ", "T");
export const fromLocalInput = (value: string) => new Date(value).toISOString();

/**
 * Series colors (validated categorical slots, see reviews.css). A post keeps its color
 * by its number (p1, p2…), so removing or filtering one never repaints the others.
 */
export const SERIES_COUNT = 4;
export const seriesColor = (slot: number) => `var(--series-${(slot % SERIES_COUNT) + 1})`;
export const postSlot = (post: Pick<Post, "id">) => Math.max(0, Number(/^p(\d+)$/.exec(post.id)?.[1] ?? 1) - 1);

/** The share still watching at second `t` (linear between points). */
export function retentionAt(points: [number, number][], t: number) {
  if (!points.length) return null;
  if (t <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index++)
    if (t <= points[index][0]) {
      const [t0, r0] = points[index - 1];
      const [t1, r1] = points[index];
      return t1 === t0 ? r1 : r0 + ((r1 - r0) * (t - t0)) / (t1 - t0);
    }
  return points[points.length - 1][1];
}

/** Retention typed or pasted as lines of "second percent" (also "0:03", "62%", commas or tabs). */
export function parseRetention(text: string): [number, number][] {
  const seconds = (value: string) => {
    const parts = value.split(":").map(Number);
    return parts.reduce((sum, part) => sum * 60 + part, 0);
  };
  const points: [number, number][] = [];
  for (const line of text.split(/\n/)) {
    const cells = line
      .trim()
      .split(/[\s,，\t]+/)
      .filter(Boolean);
    if (cells.length < 2) continue;
    const at = seconds(cells[0].replace(/秒|s$/i, ""));
    const share = Number(cells[1].replace(/%$/, "")) / 100;
    if (Number.isFinite(at) && Number.isFinite(share)) points.push([at, +share.toFixed(4)]);
  }
  return points.sort((a, b) => a[0] - b[0]);
}
export const retentionText = (points: [number, number][] | undefined) => (points ?? []).map(([at, share]) => `${at} ${+(share * 100).toFixed(2)}`).join("\n");
