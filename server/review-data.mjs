import { z } from "zod";
import { problem } from "./util.mjs";

/**
 * The review data of a work (review.json in its folder on the frame/reviews branch): where
 * the video was posted, the platforms' numbers over time, the audience retention curve next
 * to the platform's curve for similar videos ("同类作品"), hourly series, traffic sources and
 * the moments and segments the analysis looks at. Numbers are totals up to the moment of a
 * snapshot, so works are compared at the same age (days since posting): comparing totals of
 * today would always favour the older post.
 */

export const METRICS = [
  { key: "impressions", label: "曝光", kind: "count" },
  { key: "views", label: "播放", kind: "count" },
  { key: "likes", label: "点赞", kind: "count" },
  { key: "comments", label: "评论", kind: "count" },
  { key: "shares", label: "分享", kind: "count" },
  { key: "favorites", label: "收藏", kind: "count" },
  { key: "danmaku", label: "弹幕", kind: "count" },
  { key: "dislikes", label: "不感兴趣", kind: "count" },
  { key: "followers", label: "涨粉", kind: "count" },
  { key: "unfollows", label: "脱粉", kind: "count" },
  { key: "clickRate", label: "点击率", kind: "ratio" },
  { key: "bounce2s", label: "2 秒跳出", kind: "ratio" },
  { key: "retention5s", label: "5 秒留存", kind: "ratio" },
  { key: "completionRate", label: "完播率（平台）", kind: "ratio" },
  { key: "avgWatchTime", label: "平均播放时长", kind: "seconds" },
  { key: "watchRatio", label: "平均播放占比", kind: "ratio" },
  { key: "fanViewShare", label: "粉丝播放占比", kind: "ratio" },
];
/**
 * Computed from the stored numbers: rates per view (within one snapshot), and points of the
 * retention curve. A stored number of the same key (the platform's own) wins.
 */
export const DERIVED = [
  { key: "likeRate", label: "点赞率", kind: "ratio", of: ["likes"] },
  { key: "commentRate", label: "评论率", kind: "ratio", of: ["comments"] },
  { key: "shareRate", label: "分享率", kind: "ratio", of: ["shares"] },
  { key: "favoriteRate", label: "收藏率", kind: "ratio", of: ["favorites"] },
  { key: "dislikeRate", label: "不感兴趣率", kind: "ratio", of: ["dislikes"] },
  { key: "followRate", label: "涨粉率", kind: "ratio", of: ["followers"] },
  { key: "unfollowRate", label: "脱粉率", kind: "ratio", of: ["unfollows"] },
  { key: "engagementRate", label: "互动率", kind: "ratio", of: ["likes", "comments", "shares", "favorites"] },
  { key: "followsPerThousand", label: "每千次播放涨粉", kind: "number" },
  { key: "retention3s", label: "3 秒留存", kind: "ratio" },
  { key: "retentionHalf", label: "半程留存", kind: "ratio" },
  { key: "retentionEnd", label: "结尾留存", kind: "ratio" },
];
const DEFINITIONS = new Map([...METRICS, ...DERIVED].map((item) => [item.key, item]));
export const PLATFORMS = ["抖音", "视频号", "快手", "小红书", "B站", "YouTube", "TikTok", "微博", "Instagram"];
/** Ages works are compared at; `latest` is each post's newest snapshot, whatever its age. */
export const CHECKPOINTS = { "1d": 1, "2d": 2, "3d": 3, "7d": 7, "14d": 14, "30d": 30, latest: null };
/** The columns of a comparison unless others are asked for (the work's moments are added). */
export const DEFAULT_COLUMNS = [
  "views",
  "bounce2s",
  "retention5s",
  "avgWatchTime",
  "completionRate",
  "retentionEnd",
  "likeRate",
  "commentRate",
  "shareRate",
  "favoriteRate",
  "dislikeRate",
  "followsPerThousand",
];
/** Values the platform also gives for similar videos (or that come from their curve). */
export const BENCHMARKED = new Set(["bounce2s", "retention5s", "retention3s", "retentionHalf", "retentionEnd"]);

const DAY = 86400000;
export const HOUR = 3600000;
/** A metric's label and kind; `moment:反转` reads "反转时还在". */
export function definition(key) {
  if (DEFINITIONS.has(key)) return DEFINITIONS.get(key);
  if (key.startsWith("moment:")) return { key, label: `${key.slice(7)}时还在`, kind: "ratio" };
  return { key, label: key, kind: /率|比例|占比/.test(key) ? "ratio" : "count" };
}
export const metricLabel = (key) => definition(key).label;

/**
 * What people and the platforms call the standard metrics (播放量、2s跳出率、人均观看时长…):
 * a number entered under such a name is stored under the standard key, so it is compared.
 */
const plainName = (name) =>
  String(name)
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
const ALIASES = new Map();
for (const item of [...METRICS, ...DERIVED]) {
  const label = plainName(item.label);
  for (const name of [item.key.toLowerCase(), label, `${label}量`, `${label}数`]) if (!ALIASES.has(name)) ALIASES.set(name, item.key);
}
for (const [names, key] of [
  [["播放次数", "观看", "观看量", "观看次数", "观看数"], "views"],
  [["展现", "展现量", "曝光次数"], "impressions"],
  [["封面点击率"], "clickRate"],
  [["转发", "转发量", "转发数"], "shares"],
  [["新增粉丝", "净增粉丝", "粉丝增长"], "followers"],
  [["取关", "掉粉"], "unfollows"],
  [["2s跳出率", "2秒跳出率", "2s跳出"], "bounce2s"],
  [["5s完播率", "5秒完播率", "5秒留存率", "5s留存"], "retention5s"],
  [["3s留存", "3秒留存率"], "retention3s"],
  [["完播"], "completionRate"],
  [["平均观看时长", "人均观看时长", "人均播放时长"], "avgWatchTime"],
  [["平均观看占比", "平均播放进度"], "watchRatio"],
])
  for (const name of names) ALIASES.set(plainName(name), key);
/** The standard key for a metric's name (unknown names, the platform's own like 投币, stay). */
export const metricKeyOf = (name) => ALIASES.get(plainName(name)) ?? String(name).trim();
export const isBenchmarked = (key) => BENCHMARKED.has(key) || key.startsWith("moment:");

// ---- the file -----------------------------------------------------------------------

export const emptyReview = (work, title = "") => ({ work, title, posts: [], snapshots: [], series: [], moments: [], segments: [] });

const isTime = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const numbers = (value) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter(([, number]) => finite(number)));
const curve = (value) =>
  Array.isArray(value) ? value.filter((pair) => Array.isArray(pair) && finite(pair[0]) && finite(pair[1])).map(([t, r]) => [t, r]) : [];
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

/**
 * review.json as written by FRAME, edited by hand or merged from another device: entries
 * that do not make sense are left out rather than failing the whole file.
 */
export function parseReview(source, work) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return emptyReview(work);
  }
  const review = emptyReview(work, text(value?.title, 300));
  for (const post of Array.isArray(value?.posts) ? value.posts : [])
    if (post && typeof post.id === "string" && typeof post.platform === "string" && isTime(post.postedAt) && !review.posts.some((item) => item.id === post.id))
      review.posts.push(cleanPost(post));
  const known = (id) => review.posts.some((post) => post.id === id);
  for (const snapshot of Array.isArray(value?.snapshots) ? value.snapshots : [])
    if (snapshot && known(snapshot.post) && isTime(snapshot.at)) review.snapshots.push(cleanSnapshot(snapshot));
  for (const series of Array.isArray(value?.series) ? value.series : [])
    if (
      series &&
      known(series.post) &&
      typeof series.key === "string" &&
      isTime(series.start) &&
      finite(series.step) &&
      series.step > 0 &&
      Array.isArray(series.values)
    )
      review.series.push({
        post: series.post,
        key: series.key,
        start: series.start,
        step: series.step,
        values: series.values.map((item) => (finite(item) ? item : 0)),
      });
  for (const moment of Array.isArray(value?.moments) ? value.moments : [])
    if (moment && finite(moment.at) && moment.at >= 0 && typeof moment.label === "string" && moment.label)
      review.moments.push({ at: moment.at, label: moment.label });
  for (const segment of Array.isArray(value?.segments) ? value.segments : [])
    if (segment && typeof segment.kind === "string" && finite(segment.start) && finite(segment.end) && segment.end > segment.start)
      review.segments.push({ kind: segment.kind, start: segment.start, end: segment.end, label: text(segment.label, 200) });
  return sorted(review);
}

const POST_FIELDS = ["id", "platform", "account", "url", "title", "pinnedComment", "postedAt", "duration", "export", "version", "notes", "goals"];
function cleanPost(post) {
  const clean = {};
  for (const key of POST_FIELDS) {
    const value = post[key];
    if (key === "duration") {
      if (finite(value) && value > 0) clean.duration = value;
    } else if (key === "goals") {
      const goals = numbers(value);
      if (Object.keys(goals).length) clean.goals = goals;
    } else if (typeof value === "string" && value !== "") clean[key] = value;
  }
  return clean;
}

function cleanSnapshot(snapshot) {
  const sources = Array.isArray(snapshot.sources)
    ? snapshot.sources
        .filter((item) => item && typeof item.name === "string" && finite(item.share))
        .map((item) => ({ name: item.name, share: item.share, ...(finite(item.vsAccount) ? { vsAccount: item.vsAccount } : {}) }))
    : [];
  const comments = snapshot.comments && typeof snapshot.comments === "object" ? snapshot.comments : null;
  return {
    post: snapshot.post,
    at: snapshot.at,
    ...(typeof snapshot.source === "string" && snapshot.source ? { source: snapshot.source } : {}),
    metrics: numbers(snapshot.metrics),
    ...(Object.keys(numbers(snapshot.benchmark)).length ? { benchmark: numbers(snapshot.benchmark) } : {}),
    ...(curve(snapshot.retention).length ? { retention: curve(snapshot.retention) } : {}),
    ...(curve(snapshot.retentionBenchmark).length ? { retentionBenchmark: curve(snapshot.retentionBenchmark) } : {}),
    ...(sources.length ? { sources } : {}),
    ...(comments
      ? {
          comments: {
            ...numbers({ threads: comments.threads, replies: comments.replies }),
            top: (Array.isArray(comments.top) ? comments.top : [])
              .filter((item) => item && typeof item.text === "string")
              .slice(0, 20)
              .map((item) => ({ text: item.text.slice(0, 500), likes: finite(item.likes) ? item.likes : 0, replies: finite(item.replies) ? item.replies : 0 })),
          },
        }
      : {}),
  };
}

function sorted(review) {
  review.posts.sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt) || a.id.localeCompare(b.id));
  const order = new Map(review.posts.map((post, index) => [post.id, index]));
  review.snapshots.sort((a, b) => order.get(a.post) - order.get(b.post) || Date.parse(a.at) - Date.parse(b.at));
  review.series.sort((a, b) => order.get(a.post) - order.get(b.post) || a.key.localeCompare(b.key));
  review.moments.sort((a, b) => a.at - b.at);
  review.segments.sort((a, b) => a.kind.localeCompare(b.kind) || a.start - b.start);
  return review;
}

/** Two spaces per level like the work's JSON files; a curve point per line, a list of numbers on one line. */
export function formatReview(review) {
  return (
    JSON.stringify(sorted(review), null, 2).replace(/\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+)*)\s+\]/g, (_, items) => `[${items.split(/,\s+/).join(", ")}]`) + "\n"
  );
}

// ---- changes ------------------------------------------------------------------------

/** A time with its zone: without one, "2026-10-08 20:00" would be read in the server's zone (UTC in the container), not Beijing time. */
const ZONED = /^\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})$/i;
export const isZonedTime = (value) => typeof value === "string" && ZONED.test(value.trim()) && isTime(value);
export const ZONED_HINT = "时间要写到分钟并带时区，例如 2026-10-08T20:00:00+08:00（北京时间）";
const time = z
  .string()
  .max(40)
  .refine(isZonedTime, ZONED_HINT)
  .transform((value) => new Date(value).toISOString());
const postId = z.string().min(1).max(20);
const metricKey = z.string().trim().min(1).max(60);
const share = z.number().finite().min(0).max(1);
const curveSchema = z.array(z.tuple([z.number().nonnegative(), z.number().nonnegative().max(2)])).max(5000);

export const postOperation = z.strictObject({
  op: z.literal("post"),
  id: postId.optional().describe("改这条发布记录；不写则新增一条"),
  platform: z.string().trim().min(1).max(40).optional().describe("平台，例如 抖音、视频号、B站、小红书、YouTube（新增时必填）"),
  account: z.string().max(100).optional().describe("发布用的账号"),
  url: z.string().max(1000).optional().describe("作品在平台上的链接"),
  title: z.string().max(500).optional().describe("发布时的标题或文案，连同话题（不写时用作品标题）"),
  pinnedComment: z.string().max(2000).optional().describe("置顶评论"),
  postedAt: time.optional().describe("发布时间（新增时必填），带时区"),
  duration: z.number().positive().max(36000).optional().describe("发布的视频时长（秒），不写时取所选导出文件或作品的时长"),
  export: z.string().max(300).optional().describe("发布的是哪个导出文件（work_context 的 exports 里的 name），会记下它的作品版本和时长"),
  version: z.string().max(64).optional().describe("发布时的作品版本（commit）；写了 export 时取那个导出文件的"),
  goals: z.record(metricKey, z.number().finite()).optional().describe('目标，例如 { "views": 1000000, "likeRate": 0.05 }（比例写 0–1）'),
  notes: z.string().max(2000).optional().describe("备注：封面、投流等"),
});
export const snapshotOperation = z.strictObject({
  op: z.literal("snapshot"),
  post: postId.describe("发布记录的 id"),
  at: time.describe("数据统计到的时间，带时区"),
  source: z.string().max(1000).optional().describe("数据来自哪里：原始文件路径（raw/…）或「手动录入」"),
  metrics: z
    .record(metricKey, z.number().finite())
    .optional()
    .describe(
      `截至 at 的累计数值。标准指标：${METRICS.map((item) => `${item.key} ${item.label}`).join("、")}；比例写 0–1（31% 写 0.31），时长写秒。平台上的常见叫法（播放量、2s跳出率、人均观看时长…）会记到对应的标准指标；平台特有的指标用中文名作键，例如 "投币"`,
    ),
  benchmark: z.record(metricKey, z.number().finite()).optional().describe("平台给的同类作品的值，键同 metrics（例如 bounce2s、retention5s）"),
  retention: curveSchema.optional().describe("观众留存曲线：[[视频第几秒, 还在看的比例 0–1], …]，按秒递增。平台给的是视频进度百分比时先换算成秒"),
  retentionBenchmark: curveSchema.optional().describe("平台给的同类作品留存曲线，格式同 retention"),
  sources: z
    .array(z.strictObject({ name: z.string().min(1).max(40), share, vsAccount: z.number().finite().min(-1).max(1).optional() }))
    .max(30)
    .optional()
    .describe("流量来源：name、share（占比 0–1）、vsAccount（和账号近 7 天平均相比，抖音的「对比7日」，-0.024 表示低 2.4 个百分点）"),
  comments: z
    .strictObject({
      threads: z.number().int().nonnegative().optional(),
      replies: z.number().int().nonnegative().optional(),
      top: z
        .array(
          z.strictObject({ text: z.string().max(500), likes: z.number().int().nonnegative().default(0), replies: z.number().int().nonnegative().default(0) }),
        )
        .max(20)
        .optional(),
    })
    .optional()
    .describe("评论概况：一级评论数、回复数、赞最多的评论"),
  replace: z.boolean().default(false).describe("同一条发布记录同一时间已有数据时整条替换（默认合并：新给的覆盖旧的）"),
});
export const seriesOperation = z.strictObject({
  op: z.literal("series"),
  post: postId,
  key: metricKey.describe('指标，例如 views（每小时新增播放）、followers；分渠道写 "views:抖音精选"'),
  start: time.describe("第一个值所在时段的开始时间，带时区"),
  step: z
    .number()
    .int()
    .positive()
    .max(86400 * 31)
    .default(3600)
    .describe("每个值的时长（秒），默认一小时"),
  values: z
    .array(z.number().finite())
    .min(1)
    .max(24 * 400)
    .describe("每个时段新增的数（不是累计）"),
});
export const momentOperation = z.strictObject({
  op: z.literal("moment"),
  label: z.string().trim().min(1).max(20).describe("关键时刻的名字，例如 反转、兑现；同名的会被替换"),
  at: z.number().nonnegative().max(36000).describe("作品里的秒数"),
});
export const segmentsOperation = z.strictObject({
  op: z.literal("segments"),
  kind: z.string().trim().min(1).max(20).describe("分段的种类，例如 镜头、歌词、段落；同种类的整体替换，items 为空则删除"),
  items: z.array(z.strictObject({ start: z.number().nonnegative(), end: z.number().positive(), label: z.string().max(200) })).max(300),
});
export const removePostOperation = z.strictObject({ op: z.literal("remove_post"), id: postId });
export const removeSnapshotOperation = z.strictObject({ op: z.literal("remove_snapshot"), post: postId, at: time });
export const removeMomentOperation = z.strictObject({ op: z.literal("remove_moment"), label: z.string().min(1).max(20) });
export const DATA_OPERATIONS = new Set(["post", "snapshot", "series", "moment", "segments", "remove_post", "remove_snapshot", "remove_moment"]);

/**
 * Apply data operations in order. Like the file operations: what can be done is done, each
 * failure is explained. `defaults` gives a new post its title, duration and version:
 * { title, duration, version, exports: Map name → { duration, version } }.
 */
export function applyOperations(review, operations, defaults = {}) {
  const results = [];
  const changes = [];
  for (const [index, item] of operations.entries()) {
    const notes = [];
    try {
      changes.push(applyOne(review, item, defaults, notes));
      results.push({ index, op: item.op, status: "ok", ...(notes.length ? { note: notes.join("、") } : {}) });
    } catch (error) {
      results.push({ index, op: item.op, status: "failed", message: error.message });
    }
  }
  sorted(review);
  return { results, changes };
}

function checkValues(values, what) {
  for (const [key, value] of Object.entries(values ?? {})) {
    if (definition(key).kind === "ratio" && (DEFINITIONS.has(key) || key.startsWith("moment:")) && value > 1)
      fail(`${what}${metricLabel(key)}（${key}）是比例，写 0–1，例如 31% 写 0.31`);
    // Only the net follower change can go below zero.
    if (DEFINITIONS.has(key) && key !== "followers" && value < 0) fail(`${what}${metricLabel(key)}（${key}）不能是负数`);
  }
}

/** Metrics under their standard keys; each renaming noted for whoever wrote them. */
function standardKeys(values, notes) {
  if (!values) return values;
  const out = {};
  for (const [name, value] of Object.entries(values)) {
    const key = metricKeyOf(name);
    if (key !== name) notes.push(`${name} 记为 ${key}`);
    out[key] = value;
  }
  return out;
}

function applyOne(review, item, defaults, notes = []) {
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
    if (fields.goals) {
      fields.goals = standardKeys(fields.goals, notes);
      checkValues(fields.goals, "目标里的");
    }
    if (id) {
      const post = postOf(id);
      Object.assign(post, cleanPost({ ...post, ...fields }));
      for (const key of POST_FIELDS) if (fields[key] === "") delete post[key];
      if (fields.goals && !Object.keys(fields.goals).length) delete post.goals;
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
    const content = ["metrics", "benchmark", "retention", "retentionBenchmark", "sources", "comments"].filter((key) => item[key]);
    if (!content.length) fail("snapshot 要有 metrics、retention、sources 等数据");
    item = { ...item, metrics: standardKeys(item.metrics, notes), benchmark: standardKeys(item.benchmark, notes) };
    checkValues(item.metrics, "");
    checkValues(item.benchmark, "同类的");
    if (Date.parse(item.at) < Date.parse(post.postedAt) - 3600000) fail(`统计时间 ${item.at} 早于发布时间 ${post.postedAt}：检查两个时间的时区`);
    const ascending = (points) => points && [...points].sort((a, b) => a[0] - b[0]);
    const given = {
      ...(item.metrics ? { metrics: item.metrics } : {}),
      ...(item.benchmark ? { benchmark: item.benchmark } : {}),
      ...(item.retention ? { retention: ascending(item.retention) } : {}),
      ...(item.retentionBenchmark ? { retentionBenchmark: ascending(item.retentionBenchmark) } : {}),
      ...(item.sources ? { sources: item.sources } : {}),
      ...(item.comments ? { comments: { ...item.comments, top: item.comments.top ?? [] } } : {}),
    };
    const existing = review.snapshots.find((snapshot) => snapshot.post === post.id && snapshot.at === item.at);
    if (existing && !item.replace) {
      for (const [key, value] of Object.entries(given))
        existing[key] = key === "metrics" || key === "benchmark" ? { ...(existing[key] ?? {}), ...value } : value;
      // Sources are lists of files: add the ones not named yet.
      const known = (existing.source ?? "").split("、").filter(Boolean);
      const added = (item.source ?? "").split("、").filter((entry) => entry && !known.includes(entry));
      if (added.length) existing.source = [...known, ...added].join("、");
    } else {
      if (existing) review.snapshots.splice(review.snapshots.indexOf(existing), 1);
      review.snapshots.push(cleanSnapshot({ post: post.id, at: item.at, source: item.source, metrics: {}, ...given }));
    }
    return `${post.platform} ${ageLabel(ageDays(post, item.at))}的数据`;
  }
  if (item.op === "series") {
    const post = postOf(item.post);
    const existing = review.series.find((series) => series.post === post.id && series.key === item.key && series.step === item.step);
    const merged = mergeSeries(existing, item);
    if (existing) Object.assign(existing, merged);
    else review.series.push({ post: post.id, key: item.key, ...merged });
    return `${post.platform} ${metricLabel(item.key.split(":")[0])}${item.key.includes(":") ? `（${item.key.split(":")[1]}）` : ""}的${item.step === 3600 ? "每小时" : "分段"}数据`;
  }
  if (item.op === "moment") {
    review.moments = review.moments.filter((moment) => moment.label !== item.label);
    review.moments.push({ at: item.at, label: item.label });
    return `关键时刻「${item.label}」${item.at} 秒`;
  }
  if (item.op === "remove_moment") {
    const before = review.moments.length;
    review.moments = review.moments.filter((moment) => moment.label !== item.label);
    if (review.moments.length === before) fail(`没有关键时刻「${item.label}」`);
    return `删除关键时刻「${item.label}」`;
  }
  if (item.op === "segments") {
    for (const segment of item.items) if (!(segment.end > segment.start)) fail(`分段 ${segment.label || ""} 的 end 要大于 start`);
    review.segments = [...review.segments.filter((segment) => segment.kind !== item.kind), ...item.items.map((segment) => ({ kind: item.kind, ...segment }))];
    return item.items.length ? `分段「${item.kind}」${item.items.length} 段` : `删除分段「${item.kind}」`;
  }
  if (item.op === "remove_post") {
    const post = postOf(item.id);
    review.posts.splice(review.posts.indexOf(post), 1);
    review.snapshots = review.snapshots.filter((snapshot) => snapshot.post !== post.id);
    review.series = review.series.filter((series) => series.post !== post.id);
    return `删除发布记录 ${post.id}（${post.platform}）`;
  }
  const post = postOf(item.post);
  const before = review.snapshots.length;
  review.snapshots = review.snapshots.filter((snapshot) => !(snapshot.post === post.id && snapshot.at === item.at));
  if (review.snapshots.length === before) fail(`发布记录 ${post.id} 没有 ${item.at} 的数据`);
  return `删除 ${post.platform} ${ageLabel(ageDays(post, item.at))}的数据`;
}

/** Two series of the same step, by time: the newer one's values win where they overlap; hours in neither are 0. */
function mergeSeries(existing, next) {
  const step = next.step * 1000;
  const slots = new Map();
  const add = (series) => series.values.forEach((value, index) => slots.set(Date.parse(series.start) + index * step, value));
  if (existing) add(existing);
  add(next);
  const times = [...slots.keys()].sort((a, b) => a - b);
  const first = times[0];
  const count = Math.round((times.at(-1) - first) / step) + 1;
  return { start: new Date(first).toISOString(), step: next.step, values: Array.from({ length: count }, (_, index) => slots.get(first + index * step) ?? 0) };
}

function fail(message) {
  throw problem(400, message);
}

// ---- reading the numbers --------------------------------------------------------------

export const ageDays = (post, at) => (Date.parse(at) - Date.parse(post.postedAt)) / DAY;
export const ageLabel = (days) => `发布后 ${ageShort(days).slice(2)}`;
/** "第 6.5 天", or "第 18 小时" within the first two days (the platforms' first waves are counted in hours). */
export const ageShort = (days) => (days < 2 ? `第 ${Math.max(0, Math.round(days * 24))} 小时` : `第 ${round(days, 1)} 天`);
export const round = (value, digits) => Number(value.toFixed(digits));

export const snapshotsOf = (review, post) => review.snapshots.filter((snapshot) => snapshot.post === post.id);
export const seriesOf = (review, post, key) => review.series.find((series) => series.post === post.id && series.key === key && series.step === 3600) ?? null;

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

/** Points of a retention curve as metrics: 2 s, 3 s, 5 s, half, end, and the work's moments ("moment:反转"). */
function curvePoints(points, { duration, moments }) {
  if (!points?.length) return {};
  const end = duration > 0 ? duration : points.at(-1)[0];
  const out = {
    bounce2s: 1 - retentionAt(points, Math.min(2, end / 4)),
    retention3s: retentionAt(points, Math.min(3, end / 3)),
    retention5s: retentionAt(points, Math.min(5, end / 2)),
    retentionHalf: retentionAt(points, end / 2),
    retentionEnd: retentionAt(points, end),
  };
  for (const moment of moments ?? []) if (moment.at <= end) out[`moment:${moment.label}`] = retentionAt(points, moment.at);
  return out;
}

/**
 * Stored numbers with the rates per view and the points of the retention curve. A number the
 * platform gives itself (its own 2 s bounce, watch share…) is kept as given.
 */
export function derive(metrics, { duration, retention, moments } = {}) {
  const out = { ...metrics };
  const set = (key, value) => {
    if (!(key in metrics) && finite(value)) out[key] = value;
  };
  const views = metrics.views;
  if (views > 0) {
    for (const item of DERIVED.filter((entry) => entry.of)) {
      const parts = item.of.filter((key) => finite(metrics[key]));
      if (parts.length) set(item.key, parts.reduce((sum, key) => sum + metrics[key], 0) / views);
    }
    if (finite(metrics.followers)) set("followsPerThousand", (metrics.followers / views) * 1000);
  }
  if (finite(metrics.avgWatchTime) && duration > 0) set("watchRatio", metrics.avgWatchTime / duration);
  for (const [key, value] of Object.entries(curvePoints(retention, { duration, moments }))) set(key, value);
  return out;
}

/** The same points for similar videos: what the platform gave, and what their curve says. */
export function benchmarkOf(snapshot, { duration, moments, retentionBenchmark } = {}) {
  const out = { ...(snapshot?.benchmark ?? {}) };
  for (const [key, value] of Object.entries(curvePoints(snapshot?.retentionBenchmark ?? retentionBenchmark, { duration, moments })))
    if (!(key in out) && finite(value)) out[key] = value;
  return out;
}

/**
 * The newest numbers of a post with their rates: each metric from the newest snapshot that
 * has it, its rate computed within that same snapshot (comments of day 7 are not divided by
 * views of day 14). `from` tells each metric's snapshot time. Curves, sources and comments
 * come from the newest snapshot that has them.
 */
export function latest(review, post, { duration } = {}) {
  const list = snapshotsOf(review, post);
  if (!list.length) return null;
  const newest = (key) => list.findLast((snapshot) => snapshot[key]?.length ?? (snapshot[key] && Object.keys(snapshot[key]).length))?.[key] ?? null;
  const retention = newest("retention");
  const retentionBenchmark = newest("retentionBenchmark");
  const metrics = {};
  const benchmark = {};
  const from = {};
  for (const snapshot of list) {
    for (const [key, value] of Object.entries(derive(snapshot.metrics, { duration, retention: snapshot.retention, moments: review.moments }))) {
      metrics[key] = value;
      from[key] = snapshot.at;
    }
    Object.assign(benchmark, benchmarkOf(snapshot, { duration, moments: review.moments }));
  }
  return { at: list.at(-1).at, metrics, benchmark, from, retention, retentionBenchmark, sources: newest("sources"), comments: newest("comments") };
}

/**
 * The post's numbers (with their rates) at a checkpoint age: the snapshot closest to it within
 * ±max(half a day, 20 %) — day 7 takes 5.6–8.4 days. Hourly series make views and followers
 * exact at the checkpoint (listed in `exact`), also when no snapshot is near it. Null when
 * there is neither.
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
  const newest = latest(review, post, { duration });
  const result = best
    ? {
        at: best.snapshot.at,
        metrics: derive(best.snapshot.metrics, { duration, retention: best.snapshot.retention ?? newest?.retention, moments: review.moments }),
        benchmark: benchmarkOf(best.snapshot, { duration, moments: review.moments, retentionBenchmark: newest?.retentionBenchmark }),
        retention: best.snapshot.retention ?? newest?.retention ?? null,
        retentionBenchmark: best.snapshot.retentionBenchmark ?? newest?.retentionBenchmark ?? null,
        exact: [],
      }
    : null;
  const flows = {};
  for (const key of ["views", "followers"]) {
    const total = cumulativeAt(seriesOf(review, post, key), Date.parse(post.postedAt) + days * DAY);
    if (total !== null) flows[key] = total;
  }
  if (!Object.keys(flows).length) return result;
  const out = result ?? {
    at: new Date(Date.parse(post.postedAt) + days * DAY).toISOString(),
    metrics: {},
    benchmark: {},
    retention: null,
    retentionBenchmark: null,
    exact: [],
  };
  Object.assign(out.metrics, flows);
  if (!result && flows.views > 0 && finite(flows.followers)) out.metrics.followsPerThousand = (flows.followers / flows.views) * 1000;
  out.exact = Object.keys(flows);
  return out;
}

/** The sum of a series up to `ms` (slots that start before it), or null when the series does not reach that far. */
export function cumulativeAt(series, ms) {
  if (!series) return null;
  const start = Date.parse(series.start);
  const step = series.step * 1000;
  if (start > ms || start + series.values.length * step < ms) return null;
  let total = 0;
  for (let index = 0; index < series.values.length && start + index * step < ms; index++) total += series.values[index];
  return total;
}

// ---- comparing works -------------------------------------------------------------------

/** The curve at fractions of the video (0, 2 %, … 100 %), so videos of any length line up. */
export const normalizedCurve = (points, duration, steps = 50) =>
  Array.from({ length: steps + 1 }, (_, index) => [index / steps, round(retentionAt(points, (duration * index) / steps), 4)]);

/**
 * One row per post: its numbers at the checkpoint (with the derived rates), the same points
 * for similar videos (`benchmark`), and what the work is like (length, shape, tags, linked
 * experience libraries). With `curves` also the retention curves over the video's progress,
 * every snapshot and the hourly views (charts). `entries`:
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
      const views = seriesOf(review, post, "views");
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
        moments: review.moments,
        age: found ? round(ageDays(post, found.at), 2) : null,
        exact: found?.exact ?? [],
        metrics: found?.metrics ?? {},
        benchmark: found?.benchmark ?? {},
        ...(curves && found?.retention?.length && duration > 0 ? { curve: normalizedCurve(found.retention, duration) } : {}),
        ...(curves && found?.retentionBenchmark?.length && duration > 0 ? { curveBenchmark: normalizedCurve(found.retentionBenchmark, duration) } : {}),
        ...(curves
          ? {
              history: snapshotsOf(review, post).map((snapshot) => ({
                age: round(ageDays(post, snapshot.at), 2),
                metrics: derive(snapshot.metrics, { duration }),
              })),
              ...(views ? { hourly: { start: views.start, values: views.values } } : {}),
            }
          : {}),
        snapshots: snapshotsOf(review, post).map((snapshot) => round(ageDays(post, snapshot.at), 1)),
      });
    }
  return rows;
}

/**
 * The age to compare at when none is asked for: the latest checkpoint that most of the posts
 * with data have reached (half of them, and at least two when there are two), else each
 * one's latest. Young posts would otherwise all show "no data" at day 7.
 */
export function defaultCheckpoint(entries, options = {}) {
  const reached = (checkpoint) => compareRows(entries, { ...options, checkpoint, curves: false }).filter((row) => row.age !== null).length;
  const posts = reached("latest");
  if (!posts) return "latest";
  const needed = Math.max(Math.min(2, posts), Math.ceil(posts / 2));
  const days = Object.keys(CHECKPOINTS)
    .filter((key) => CHECKPOINTS[key] !== null)
    .sort((a, b) => CHECKPOINTS[b] - CHECKPOINTS[a]);
  return days.find((key) => reached(key) >= needed) ?? "latest";
}

const shapeOf = (width, height) => (!width || !height ? "" : height > width * 1.15 ? "竖屏" : width > height * 1.15 ? "横屏" : "方形");

export function median(values) {
  const list = values.filter(finite).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

// ---- formatting ------------------------------------------------------------------------

const plain = (number) => String(Number(number.toPrecision(12)));
/** 0.3079 → 30.79% (two decimals, as the creator centers show them), 0.0034 → 0.34%. */
export function formatPercent(value) {
  if (!finite(value)) return "—";
  const percent = value * 100;
  return `${Math.abs(percent) >= 1 ? round(percent, 2) : plain(Number(percent.toPrecision(2)))}%`;
}
/** A number as people read it: 12,034 · 6.9% · 9.4 秒 · 1.55. */
export function formatValue(key, value) {
  if (!finite(value)) return "—";
  const { kind } = definition(key);
  if (kind === "ratio") return formatPercent(value);
  if (kind === "seconds") return `${round(value, 1)} 秒`;
  if (kind === "number") return plain(round(value, 2));
  return Number.isInteger(value) ? value.toLocaleString("en-US") : plain(value);
}
/** Large counts the way Chinese creators say them: 24.08 万. */
export function formatCount(value) {
  if (!finite(value)) return "—";
  return Math.abs(value) >= 1e4 ? `${plain(round(value / 1e4, 2))} 万` : value.toLocaleString("en-US");
}
/** "2026-10-07 23:00" in Beijing time: the platforms these reviews come from count days there. */
export function beijing(iso, { date = true, time = true } = {}) {
  const shifted = new Date(Date.parse(iso) + 8 * 3600000).toISOString();
  return [date ? shifted.slice(0, 10) : "", time ? shifted.slice(11, 16) : ""].filter(Boolean).join(" ");
}
