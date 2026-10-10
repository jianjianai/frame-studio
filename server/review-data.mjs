import { z } from "zod";
import { problem } from "./util.mjs";

/**
 * The review data of a work (review.json in its folder on the frame/reviews branch): where
 * the video was posted, the platforms' numbers over time and the audience retention curve.
 * Numbers are totals up to the moment of a snapshot, so works are compared at the same age
 * (days since posting): comparing totals of today would always favour the older post.
 */

export const METRICS = [
  { key: "impressions", label: "曝光", kind: "count" },
  { key: "views", label: "播放", kind: "count" },
  { key: "likes", label: "点赞", kind: "count" },
  { key: "comments", label: "评论", kind: "count" },
  { key: "shares", label: "分享", kind: "count" },
  { key: "favorites", label: "收藏", kind: "count" },
  { key: "followers", label: "涨粉", kind: "count" },
  { key: "clickRate", label: "点击率", kind: "ratio" },
  { key: "completionRate", label: "完播率", kind: "ratio" },
  { key: "avgWatchTime", label: "平均播放时长", kind: "seconds" },
];
/** Computed from the stored numbers: rates per view, watch progress, retention points. */
export const DERIVED = [
  { key: "likeRate", label: "点赞率", kind: "ratio", of: ["likes"] },
  { key: "commentRate", label: "评论率", kind: "ratio", of: ["comments"] },
  { key: "shareRate", label: "分享率", kind: "ratio", of: ["shares"] },
  { key: "favoriteRate", label: "收藏率", kind: "ratio", of: ["favorites"] },
  { key: "followRate", label: "转粉率", kind: "ratio", of: ["followers"] },
  { key: "engagementRate", label: "互动率", kind: "ratio", of: ["likes", "comments", "shares", "favorites"] },
  { key: "watchRatio", label: "平均播放进度", kind: "ratio" },
  { key: "retention3s", label: "3 秒留存", kind: "ratio" },
  { key: "retentionHalf", label: "半程留存", kind: "ratio" },
];
const DEFINITIONS = new Map([...METRICS, ...DERIVED].map((item) => [item.key, item]));
export const PLATFORMS = ["抖音", "视频号", "快手", "小红书", "B站", "YouTube", "TikTok", "微博", "Instagram"];
/** Ages works are compared at; `latest` is each post's newest snapshot, whatever its age. */
export const CHECKPOINTS = { "1d": 1, "3d": 3, "7d": 7, "14d": 14, "30d": 30, latest: null };
/** The columns of a comparison unless others are asked for. */
export const DEFAULT_COLUMNS = ["views", "likeRate", "commentRate", "shareRate", "favoriteRate", "completionRate", "avgWatchTime", "retention3s", "followers"];

const DAY = 86400000;
const definition = (key) => DEFINITIONS.get(key) ?? { key, label: key, kind: /率|比例|占比/.test(key) ? "ratio" : "count" };
export const metricLabel = (key) => definition(key).label;

// ---- the file -----------------------------------------------------------------------

export const emptyReview = (work, title = "") => ({ work, title, posts: [], snapshots: [] });

const isTime = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * review.json as written by FRAME, edited by hand or merged from another device: entries
 * that do not make sense are left out rather than failing the whole file.
 */
export function parseReview(text, work) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return emptyReview(work);
  }
  const review = emptyReview(work, typeof value?.title === "string" ? value.title : "");
  for (const post of Array.isArray(value?.posts) ? value.posts : [])
    if (post && typeof post.id === "string" && typeof post.platform === "string" && isTime(post.postedAt) && !review.posts.some((item) => item.id === post.id))
      review.posts.push(cleanPost(post));
  for (const snapshot of Array.isArray(value?.snapshots) ? value.snapshots : [])
    if (snapshot && review.posts.some((post) => post.id === snapshot.post) && isTime(snapshot.at))
      review.snapshots.push({
        post: snapshot.post,
        at: snapshot.at,
        ...(typeof snapshot.source === "string" && snapshot.source ? { source: snapshot.source } : {}),
        metrics: Object.fromEntries(Object.entries(snapshot.metrics ?? {}).filter(([, number]) => finite(number))),
        ...(Array.isArray(snapshot.retention) && snapshot.retention.length
          ? { retention: snapshot.retention.filter((pair) => Array.isArray(pair) && finite(pair[0]) && finite(pair[1])).map(([t, r]) => [t, r]) }
          : {}),
      });
  return sorted(review);
}

const POST_FIELDS = ["id", "platform", "account", "url", "title", "postedAt", "duration", "export", "version", "notes"];
function cleanPost(post) {
  const clean = {};
  for (const key of POST_FIELDS) {
    const value = post[key];
    if (key === "duration" ? finite(value) && value > 0 : typeof value === "string" && value !== "") clean[key] = value;
  }
  return clean;
}

function sorted(review) {
  review.posts.sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt) || a.id.localeCompare(b.id));
  const order = new Map(review.posts.map((post, index) => [post.id, index]));
  review.snapshots.sort((a, b) => order.get(a.post) - order.get(b.post) || Date.parse(a.at) - Date.parse(b.at));
  return review;
}

/** Two spaces per level like the work's JSON files, a retention point per line. */
export function formatReview(review) {
  return JSON.stringify(sorted(review), null, 2).replace(/\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]/g, "[$1, $2]") + "\n";
}

// ---- changes ------------------------------------------------------------------------

const time = z
  .string()
  .max(40)
  .refine(isTime, "无法识别的时间：写 ISO 格式并带时区，例如 2026-10-08T20:00:00+08:00")
  .transform((value) => new Date(value).toISOString());
const postId = z.string().min(1).max(20);
const metricKey = z.string().trim().min(1).max(40);

export const postOperation = z.strictObject({
  op: z.literal("post"),
  id: postId.optional().describe("改这条发布记录；不写则新增一条"),
  platform: z.string().trim().min(1).max(40).optional().describe("平台，例如 抖音、视频号、B站、小红书、YouTube（新增时必填）"),
  account: z.string().max(100).optional().describe("发布用的账号"),
  url: z.string().max(1000).optional().describe("作品在平台上的链接"),
  title: z.string().max(300).optional().describe("发布时的标题或文案（不写时用作品标题）"),
  postedAt: time.optional().describe("发布时间（新增时必填），带时区"),
  duration: z.number().positive().max(36000).optional().describe("发布的视频时长（秒），不写时取所选导出文件或作品的时长"),
  export: z.string().max(300).optional().describe("发布的是哪个导出文件（work_context 的 exports 里的 name），会记下它的作品版本和时长"),
  version: z.string().max(64).optional(),
  notes: z.string().max(2000).optional().describe("备注：封面、话题、投流等"),
});
export const snapshotOperation = z.strictObject({
  op: z.literal("snapshot"),
  post: postId.describe("发布记录的 id"),
  at: time.describe("数据统计到的时间，带时区"),
  source: z.string().max(300).optional().describe("数据来自哪里：原始文件路径（raw/…）或「手动录入」"),
  metrics: z
    .record(metricKey, z.number().finite())
    .optional()
    .describe(
      `截至 at 的累计数值。标准指标：${METRICS.map((item) => `${item.key} ${item.label}`).join("、")}；比例写 0–1（31% 写 0.31），时长写秒。平台特有的指标用中文名作键，例如 "投币"、"2 秒跳出率"`,
    ),
  retention: z
    .array(z.tuple([z.number().nonnegative(), z.number().nonnegative().max(2)]))
    .max(2000)
    .optional()
    .describe("观众留存曲线：[[视频第几秒, 还在看的比例 0–1], …]，按秒递增。平台给的是视频进度百分比时先换算成秒"),
  replace: z.boolean().default(false).describe("同一条发布记录同一时间已有数据时整条替换（默认合并：新给的指标覆盖旧的）"),
});
export const removePostOperation = z.strictObject({ op: z.literal("remove_post"), id: postId });
export const removeSnapshotOperation = z.strictObject({ op: z.literal("remove_snapshot"), post: postId, at: time });
export const DATA_OPERATIONS = new Set(["post", "snapshot", "remove_post", "remove_snapshot"]);

/**
 * Apply data operations (post, snapshot, remove_post, remove_snapshot) in order. Like the
 * file operations: what can be done is done, each failure is explained. `defaults` gives a
 * new post its title, duration and version: { title, duration, version, exports: Map name → { duration, version } }.
 */
export function applyOperations(review, operations, defaults = {}) {
  const results = [];
  const changes = [];
  for (const [index, item] of operations.entries()) {
    try {
      changes.push(applyOne(review, item, defaults));
      results.push({ index, op: item.op, status: "ok" });
    } catch (error) {
      results.push({ index, op: item.op, status: "failed", message: error.message });
    }
  }
  sorted(review);
  return { results, changes };
}

function applyOne(review, item, defaults) {
  const postOf = (id) =>
    review.posts.find((post) => post.id === id) ??
    fail(`没有发布记录 ${id}（现有：${review.posts.map((post) => `${post.id} ${post.platform}`).join("、") || "无"}）`);
  if (item.op === "post") {
    const { op: _op, id, ...fields } = item;
    if (fields.export) {
      const exported = defaults.exports?.get(fields.export);
      if (!exported)
        fail(`没有导出文件「${fields.export}」${defaults.exports?.size ? `（现有：${[...defaults.exports.keys()].slice(0, 5).join("、")}）` : ""}`);
      fields.duration ??= exported.duration;
      fields.version ??= exported.version;
    }
    if (id) {
      const post = postOf(id);
      Object.assign(post, cleanPost({ ...post, ...fields }));
      for (const key of POST_FIELDS) if (fields[key] === "") delete post[key];
      return `修改发布记录 ${post.id}（${post.platform}）`;
    }
    if (!fields.platform) fail("新增发布记录要写 platform（平台）");
    if (!fields.postedAt) fail("新增发布记录要写 postedAt（发布时间，带时区）");
    const next = Math.max(0, ...review.posts.map((post) => Number(/^p(\d+)$/.exec(post.id)?.[1] ?? 0))) + 1;
    const post = cleanPost({ title: defaults.title, duration: defaults.duration, version: defaults.version, ...fields, id: `p${next}` });
    review.posts.push(post);
    return `新增发布记录 ${post.id}（${post.platform}）`;
  }
  if (item.op === "snapshot") {
    const post = postOf(item.post);
    if (!item.metrics && !item.retention) fail("snapshot 要有 metrics 或 retention");
    for (const [key, value] of Object.entries(item.metrics ?? {})) {
      if (definition(key).kind === "ratio" && DEFINITIONS.has(key) && value > 1) fail(`${metricLabel(key)}（${key}）是比例，写 0–1，例如 31% 写 0.31`);
      // Only the net follower change can go below zero.
      if (DEFINITIONS.has(key) && key !== "followers" && value < 0) fail(`${metricLabel(key)}（${key}）不能是负数`);
    }
    if (Date.parse(item.at) < Date.parse(post.postedAt) - 3600000) fail(`统计时间 ${item.at} 早于发布时间 ${post.postedAt}：检查两个时间的时区`);
    const retention = item.retention && [...item.retention].sort((a, b) => a[0] - b[0]);
    const existing = review.snapshots.find((snapshot) => snapshot.post === post.id && snapshot.at === item.at);
    if (existing && !item.replace) {
      Object.assign(existing.metrics, item.metrics ?? {});
      if (retention) existing.retention = retention;
      if (item.source && !(existing.source ?? "").split("、").includes(item.source))
        existing.source = [existing.source, item.source].filter(Boolean).join("、");
    } else {
      if (existing) review.snapshots.splice(review.snapshots.indexOf(existing), 1);
      review.snapshots.push({
        post: post.id,
        at: item.at,
        ...(item.source ? { source: item.source } : {}),
        metrics: { ...(item.metrics ?? {}) },
        ...(retention ? { retention } : {}),
      });
    }
    return `${post.platform} ${ageLabel(ageDays(post, item.at))}的数据`;
  }
  if (item.op === "remove_post") {
    const post = postOf(item.id);
    review.posts.splice(review.posts.indexOf(post), 1);
    review.snapshots = review.snapshots.filter((snapshot) => snapshot.post !== post.id);
    return `删除发布记录 ${post.id}（${post.platform}）`;
  }
  const post = postOf(item.post);
  const before = review.snapshots.length;
  review.snapshots = review.snapshots.filter((snapshot) => !(snapshot.post === post.id && snapshot.at === item.at));
  if (review.snapshots.length === before) fail(`发布记录 ${post.id} 没有 ${item.at} 的数据`);
  return `删除 ${post.platform} ${ageLabel(ageDays(post, item.at))}的数据`;
}

function fail(message) {
  throw problem(400, message);
}

// ---- reading the numbers --------------------------------------------------------------

export const ageDays = (post, at) => (Date.parse(at) - Date.parse(post.postedAt)) / DAY;
export const ageLabel = (days) => `发布后 ${ageShort(days).slice(2)}`;
/** "第 6.5 天", or "第 18 小时" within the first day. */
export const ageShort = (days) => (days < 1 ? `第 ${Math.max(0, Math.round(days * 24))} 小时` : `第 ${round(days, 1)} 天`);
const round = (value, digits) => Number(value.toFixed(digits));

export const snapshotsOf = (review, post) => review.snapshots.filter((snapshot) => snapshot.post === post.id);
/**
 * The newest numbers of a post with their rates: each metric from the newest snapshot that
 * has it, its rate computed within that same snapshot (comments of day 7 are not divided by
 * views of day 14). `from` tells each metric's snapshot time.
 */
export function latest(review, post, { duration } = {}) {
  const list = snapshotsOf(review, post);
  if (!list.length) return null;
  const metrics = {};
  const from = {};
  for (const snapshot of list)
    for (const [key, value] of Object.entries(derive(snapshot.metrics, { duration, retention: snapshot.retention }))) {
      metrics[key] = value;
      from[key] = snapshot.at;
    }
  const retention = list.findLast((snapshot) => snapshot.retention?.length)?.retention ?? null;
  return { at: list.at(-1).at, metrics, from, retention };
}

/**
 * The post's numbers (with their rates) at a checkpoint age: the snapshot closest to it
 * within ±max(half a day, 20 %) — day 7 takes 5.6–8.4 days — or null. A snapshot without
 * a retention curve takes the newest one.
 */
export function atCheckpoint(review, post, checkpoint, { duration } = {}) {
  const days = CHECKPOINTS[checkpoint];
  if (days === null) return latest(review, post, { duration });
  const slack = Math.max(0.5, days * 0.2);
  let best = null;
  for (const snapshot of snapshotsOf(review, post)) {
    const off = Math.abs(ageDays(post, snapshot.at) - days);
    if (off <= slack && (!best || off < best.off)) best = { snapshot, off };
  }
  if (!best) return null;
  const retention = best.snapshot.retention ?? latest(review, post)?.retention ?? null;
  return { at: best.snapshot.at, metrics: derive(best.snapshot.metrics, { duration, retention }), retention };
}

/** Stored numbers with the rates per view, watch progress and retention points. */
export function derive(metrics, { duration, retention } = {}) {
  const out = { ...metrics };
  const views = metrics.views;
  if (views > 0)
    for (const item of DERIVED.filter((entry) => entry.of)) {
      const parts = item.of.filter((key) => finite(metrics[key]));
      if (parts.length) out[item.key] = parts.reduce((sum, key) => sum + metrics[key], 0) / views;
    }
  if (finite(metrics.avgWatchTime) && duration > 0) out.watchRatio = metrics.avgWatchTime / duration;
  if (retention?.length) {
    out.retention3s = retentionAt(retention, Math.min(3, (duration || retention.at(-1)[0]) / 3));
    if (duration > 0) out.retentionHalf = retentionAt(retention, duration / 2);
  }
  return out;
}

// ---- retention ---------------------------------------------------------------------------

/** The share still watching at second `t` (linear between points, flat past the ends). */
export function retentionAt(points, t) {
  if (!points?.length) return null;
  if (t <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index++)
    if (t <= points[index][0]) {
      const [t0, r0] = points[index - 1];
      const [t1, r1] = points[index];
      return t1 === t0 ? r1 : r0 + ((r1 - r0) * (t - t0)) / (t1 - t0);
    }
  return points.at(-1)[1];
}

/** The curve at fractions of the video (0, 2 %, … 100 %), so videos of any length line up. */
export const normalizedCurve = (points, duration, steps = 50) =>
  Array.from({ length: steps + 1 }, (_, index) => [index / steps, round(retentionAt(points, (duration * index) / steps), 4)]);

const shotAt = (beats, t) => [...(beats ?? [])].sort((a, b) => a.at - b.at).findLast((beat) => beat.at <= t + 1e-6) ?? null;
const subtitleAt = (subtitles, t) => (subtitles ?? []).find((cue) => cue.start <= t && t < cue.end) ?? null;

/**
 * Where viewers leave: the opening (first 3 s, a third of very short videos), then the
 * steepest stretches after it (more than 1.5× the average loss and at least 2 points),
 * and stretches where the curve rises (viewers going back to watch again). Each comes with
 * the shot (project.ts beats) and subtitle of its middle, to look at with preview_frames.
 */
export function retentionStats(points, duration, { beats, subtitles } = {}) {
  if (!points?.length) return null;
  const end = duration > 0 ? duration : points.at(-1)[0];
  const r = (t) => retentionAt(points, t);
  const opening = Math.min(3, end / 3);
  const window = Math.max(1, Math.min(5, end / 15));
  const step = Math.max(0.1, end / 300);
  const samples = [];
  for (let t = opening; t + window <= end + 1e-9; t += step) samples.push({ t, change: r(t + window) - r(t) });
  const average = ((r(opening) - r(end)) * window) / Math.max(window, end - opening);
  const pick = (score, threshold, count) => {
    const picked = [];
    for (const sample of [...samples].sort((a, b) => score(b) - score(a))) {
      if (score(sample) < threshold || picked.length >= count) break;
      if (!picked.some((item) => Math.abs(item.t - sample.t) < window)) picked.push(sample);
    }
    return picked
      .sort((a, b) => a.t - b.t)
      .map(({ t }) => {
        const middle = t + window / 2;
        const shot = shotAt(beats, middle);
        const cue = subtitleAt(subtitles, middle);
        return {
          start: round(t, 2),
          end: round(t + window, 2),
          from: round(r(t), 4),
          to: round(r(t + window), 4),
          ...(shot ? { shot: { at: shot.at, title: shot.title } } : {}),
          ...(cue ? { subtitle: cue.text } : {}),
        };
      });
  };
  return {
    opening: { seconds: round(opening, 2), kept: round(r(opening), 4), lost: round(r(0) - r(opening), 4) },
    half: round(r(end / 2), 4),
    end: round(r(end), 4),
    drops: pick((sample) => -sample.change, Math.max(0.02, average * 1.5), 3),
    rises: pick((sample) => sample.change, 0.02, 2),
  };
}

// ---- text ----------------------------------------------------------------------------------

const plain = (number) => String(Number(number.toPrecision(12)));
/** 0.314 → 31.4%, 0.0034 → 0.34%. */
export function formatPercent(value) {
  if (!finite(value)) return "—";
  const percent = value * 100;
  return `${percent >= 10 ? round(percent, 1) : percent >= 1 ? round(percent, 2) : plain(Number(percent.toPrecision(2)))}%`;
}
/** A number as people read it: 12,034 · 6.9% · 9.4 秒. */
export function formatValue(key, value) {
  if (!finite(value)) return "—";
  const { kind } = definition(key);
  if (kind === "ratio") return formatPercent(value);
  if (kind === "seconds") return `${round(value, 1)} 秒`;
  return Number.isInteger(value) ? value.toLocaleString("en-US") : plain(value);
}
/** Which rate goes next to a count. */
const RATE_OF = {
  likes: "likeRate",
  comments: "commentRate",
  shares: "shareRate",
  favorites: "favoriteRate",
  followers: "followRate",
  avgWatchTime: "watchRatio",
};
const day = (iso) => new Date(iso).toISOString().slice(0, 10);

/** The overview review_read returns. */
export function reviewText({ review, title, duration, files, documents, analyses }) {
  const lines = [`复盘「${title}」（作品 ${review.work}${duration ? `，时长 ${round(duration, 2)} 秒` : ""}）`];
  if (!review.posts.length) lines.push("", "还没有发布记录。用 review_write 的 post 记下发到了哪个平台、什么时候发的，再用 snapshot 录入数据。");
  for (const post of review.posts) {
    const now = latest(review, post, { duration: post.duration ?? duration });
    const list = snapshotsOf(review, post);
    const analysis = analyses?.[post.id];
    lines.push(
      "",
      `${post.id} ${post.platform}${post.account ? `（${post.account}）` : ""}「${post.title ?? title}」${day(post.postedAt)} 发布，现在${ageLabel(ageDays(post, new Date().toISOString())).replace("发布后 ", "已发布 ")}${post.url ? `；${post.url}` : ""}`,
      ...(post.export || post.version || post.duration
        ? [
            `  ${[
              post.export ? `发布的是导出文件 ${post.export}` : "",
              post.version ? `${post.export ? "来自" : "发布时的"}作品版本 ${post.version.slice(0, 7)}` : "",
              post.duration ? `时长 ${post.duration} 秒` : "",
            ]
              .filter(Boolean)
              .join("，")}`,
          ]
        : []),
      ...(post.notes ? [`  备注：${post.notes}`] : []),
    );
    if (!now) {
      lines.push("  还没有数据。");
      continue;
    }
    const numbers = now.metrics;
    const shown = [...METRICS.map((item) => item.key), ...Object.keys(numbers).filter((key) => !DEFINITIONS.has(key))].filter((key) => key in numbers);
    // A metric the newest snapshot lacks comes from an earlier one: say which.
    const older = (key) => (now.from[key] !== now.at ? ageShort(ageDays(post, now.from[key])) : "");
    lines.push(
      `  最新数据（${ageLabel(ageDays(post, now.at))}${list.at(-1).source ? `，来自 ${list.at(-1).source}` : ""}）：${shown
        .map((key) => {
          const rate = RATE_OF[key] && RATE_OF[key] in numbers ? formatValue(RATE_OF[key], numbers[RATE_OF[key]]) : "";
          const note = [rate, older(key)].filter(Boolean).join("，");
          return `${metricLabel(key)} ${formatValue(key, numbers[key])}${note ? `（${note}）` : ""}`;
        })
        .join("｜")}`,
      `  数据记录：${list.map((snapshot) => ageLabel(ageDays(post, snapshot.at)).replace("发布后 ", "")).join("、")}（共 ${list.length} 次）`,
    );
    if (analysis) {
      lines.push(
        `  留存：开头 ${analysis.opening.seconds} 秒流失 ${formatPercent(analysis.opening.lost)}，半程 ${formatPercent(analysis.half)}，结尾 ${formatPercent(analysis.end)}`,
      );
      const stretch = (item, word) =>
        `${item.start}–${item.end} 秒 ${word} ${formatPercent(Math.abs(item.to - item.from))}${item.shot ? `（镜头「${item.shot.title}」）` : ""}${item.subtitle ? `（字幕“${item.subtitle}”）` : ""}`;
      if (analysis.drops.length) lines.push(`  流失明显的地方：${analysis.drops.map((item) => stretch(item, "流失")).join("；")}`);
      if (analysis.rises.length) lines.push(`  被回看的地方：${analysis.rises.map((item) => stretch(item, "回升")).join("；")}`);
    }
  }
  lines.push("", `复盘文档：${documents.length ? documents.map((doc) => `${doc.path}${doc.title ? `（${doc.title}）` : ""}`).join("、") : "（还没有）"}`);
  lines.push(
    `原始文件：${files.length ? files.map((file) => `${file.path}${file.used ? "（已录入）" : "（未录入）"}`).join("、") : "（还没有。用户可以在「复盘」视图上传平台后台导出的表格或截图）"}`,
  );
  return lines.join("\n");
}

// ---- comparing works -------------------------------------------------------------------

/**
 * One row per post: its numbers at the checkpoint (with the derived rates) and what the
 * work is like (length, shape, tags, linked experience libraries); with `curves` also its
 * retention curve over the video's progress and every snapshot (for charts). `entries`:
 * [{ repo, review, work: { title, duration, width, height, tags, experiences, missing } }].
 */
export function compareRows(entries, { checkpoint = "7d", platform, since, until, curves = false } = {}) {
  const rows = [];
  for (const { repo, review, work } of entries)
    for (const post of review.posts) {
      if (platform && post.platform !== platform) continue;
      if (since && Date.parse(post.postedAt) < Date.parse(since)) continue;
      if (until && Date.parse(post.postedAt) > Date.parse(until)) continue;
      const duration = post.duration ?? work.duration ?? 0;
      const found = atCheckpoint(review, post, checkpoint, { duration });
      rows.push({
        repo,
        work: review.work,
        title: work.title || review.title || review.work,
        ...(work.missing ? { missing: true } : {}),
        post: post.id,
        platform: post.platform,
        postTitle: post.title ?? "",
        url: post.url ?? "",
        postedAt: post.postedAt,
        duration,
        shape: shapeOf(work.width, work.height),
        tags: work.tags ?? [],
        experiences: work.experiences ?? [],
        age: found ? round(ageDays(post, found.at), 2) : null,
        metrics: found?.metrics ?? {},
        ...(curves && found?.retention?.length && duration > 0 ? { curve: normalizedCurve(found.retention, duration) } : {}),
        ...(curves
          ? {
              history: snapshotsOf(review, post).map((snapshot) => ({
                age: round(ageDays(post, snapshot.at), 2),
                metrics: derive(snapshot.metrics, { duration }),
              })),
            }
          : {}),
        snapshots: snapshotsOf(review, post).map((snapshot) => round(ageDays(post, snapshot.at), 1)),
      });
    }
  return rows;
}

const shapeOf = (width, height) => (!width || !height ? "" : height > width * 1.15 ? "竖屏" : width > height * 1.15 ? "横屏" : "方形");

export function median(values) {
  const list = values.filter(finite).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

/** The comparison as the AI reads it: a table, the medians, and how `current` stands. */
export function compareText(rows, { checkpoint, columns = DEFAULT_COLUMNS, current } = {}) {
  const days = CHECKPOINTS[checkpoint];
  const head =
    days === null
      ? "各发布记录的最新数据（发布天数不同，越早发的数字越大，只能粗看）"
      : `发布后第 ${days} 天的数据（取第 ${round(days - Math.max(0.5, days * 0.2), 1)}–${round(days + Math.max(0.5, days * 0.2), 1)} 天之间最接近的一次记录）`;
  const withData = rows.filter((row) => row.age !== null);
  const without = rows.filter((row) => row.age === null);
  if (!rows.length) return "没有符合条件的发布记录。";
  // The id lets the AI read that work's review next.
  const name = (row) => `${current && row.work === current ? "▶ " : ""}${row.title} ${row.work}${row.missing ? "（作品已删除）" : ""}`;
  const table = [
    `| 作品 | 平台 | 发布 | ${columns.map(metricLabel).join(" | ")} |`,
    `|${" --- |".repeat(columns.length + 3)}`,
    ...withData.map(
      (row) => `| ${name(row)} | ${row.platform} | ${day(row.postedAt)} | ${columns.map((key) => formatValue(key, row.metrics[key])).join(" | ")} |`,
    ),
  ];
  const medians = Object.fromEntries(columns.map((key) => [key, median(withData.map((row) => row.metrics[key]))]));
  const lines = [head, "", ...(withData.length ? table : ["（没有发布记录在这个时间点有数据）"])];
  if (withData.length > 1)
    lines.push(
      "",
      `中位数（${withData.length} 条）：${columns
        .filter((key) => medians[key] !== null)
        .map((key) => `${metricLabel(key)} ${formatValue(key, medians[key])}`)
        .join("｜")}`,
    );
  for (const row of withData.filter((item) => current && item.work === current)) {
    const notes = columns
      .filter((key) => finite(row.metrics[key]) && medians[key] > 0 && withData.length > 1)
      .map((key) => `${metricLabel(key)} ${formatValue(key, row.metrics[key])}，是中位数的 ${round(row.metrics[key] / medians[key], 2)} 倍`);
    if (notes.length) lines.push("", `本作品（${row.platform}）：${notes.join("；")}`);
  }
  if (without.length)
    lines.push(
      "",
      `这个时间点没有数据的：${without
        .map((row) => `${row.title}（${row.platform}，${row.snapshots.length ? `只有发布后 ${row.snapshots.join("、")} 天的` : "还没有数据"}）`)
        .join("；")}`,
    );
  return lines.join("\n");
}
