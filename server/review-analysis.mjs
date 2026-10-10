import {
  METRICS,
  DERIVED,
  CHECKPOINTS,
  DEFAULT_COLUMNS,
  definition,
  metricLabel,
  isBenchmarked,
  latest,
  derive,
  snapshotsOf,
  seriesOf,
  retentionAt,
  ageDays,
  ageLabel,
  ageShort,
  round,
  median,
  formatPercent,
  formatValue,
  formatCount,
  beijing,
  HOUR,
} from "./review-data.mjs";

/**
 * What the numbers say: where viewers leave compared with similar videos, how the views came
 * in over the hours, and the text review_read and reviews_compare give the AI.
 *
 * Leaving is measured the way the creator's reviews do it: of those still watching at a
 * second, the share gone a second later (the churn rate), divided by the same for the
 * platform's similar videos ("× 同类"). Below 1 the video holds people better than its peers.
 * A segment's multiplier compares the share lost from its start to its end; "按同类走" is how
 * many more would see the end had that segment lost people like similar videos do.
 */

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const times = (value) => `×${round(value, 2)}`;
const isDerived = (key) => DERIVED.some((item) => item.key === key) || key.startsWith("moment:");
/** Metrics where less is better, for goals. */
export const LOWER_IS_BETTER = new Set(["bounce2s", "dislikes", "dislikeRate", "unfollows", "unfollowRate"]);

/** Churn rate per second: [t, share of those watching at t gone by t+1]. */
function churn(points, end) {
  const out = [];
  for (let t = 0; t < end - 1e-9; t++) {
    const a = retentionAt(points, t);
    const b = retentionAt(points, Math.min(t + 1, end));
    out.push(a > 0 ? 1 - b / a : null);
  }
  return out;
}

/**
 * The retention curve against similar videos (when the platform gives their curve): churn
 * multipliers per second, the worst seconds with their neighbours (a drop is only put on a
 * picture when the seconds around it agree), each segment's multiplier and what it costs,
 * and the moments. Without a benchmark: the steepest stretches, as shares of all viewers.
 * `segments`: [{ kind, start, end, label, songTime? }].
 */
export function retentionAnalysis({ retention, benchmark, duration, segments = [], moments = [] }) {
  if (!retention?.length) return null;
  const end = duration > 0 ? duration : retention.at(-1)[0];
  const r = (t) => retentionAt(retention, t);
  const rb = benchmark?.length ? (t) => retentionAt(benchmark, t) : null;
  const opening = Math.min(3, end / 3);
  const result = {
    duration: round(end, 3),
    hasBenchmark: Boolean(rb),
    opening: {
      seconds: round(opening, 2),
      kept: round(r(opening), 4),
      lost: round(r(0) - r(opening), 4),
      ...(rb ? { keptBenchmark: round(rb(opening), 4) } : {}),
    },
    half: round(r(end / 2), 4),
    end: round(r(end), 4),
    moments: moments
      .filter((moment) => moment.at <= end)
      .map((moment) => ({ ...moment, kept: round(r(moment.at), 4), ...(rb ? { keptBenchmark: round(rb(moment.at), 4) } : {}) })),
  };
  const labelsAt = (t) => labelsAtTime(segments, t);
  if (rb) {
    const mine = churn(retention, end);
    const theirs = churn(benchmark, end);
    const multipliers = mine.map((value, t) => (finite(value) && theirs[t] > 0 ? value / theirs[t] : null));
    result.perSecond = mine.map((value, t) => ({
      t,
      kept: round(r(t), 4),
      keptBenchmark: round(rb(t), 4),
      ...(finite(value) ? { churn: round(value, 4) } : {}),
      ...(finite(multipliers[t]) ? { multiplier: round(multipliers[t], 2) } : {}),
    }));
    // The worst seconds, at least 2 s apart, each with the two seconds before and after.
    const picked = [];
    for (const t of multipliers.map((_, index) => index).sort((a, b) => (multipliers[b] ?? 0) - (multipliers[a] ?? 0))) {
      if (!(multipliers[t] >= 1.5) || picked.length >= 5) break;
      if (!picked.some((other) => Math.abs(other - t) < 2)) picked.push(t);
    }
    result.peaks = picked
      .sort((a, b) => a - b)
      .map((t) => ({
        t,
        multiplier: round(multipliers[t], 2),
        around: [-2, -1, 1, 2].map((offset) => (finite(multipliers[t + offset]) ? round(multipliers[t + offset], 2) : null)),
        labels: labelsAt(t + 0.5),
      }));
    result.keptVsBenchmark = round(r(end) / rb(end), 2);
  } else {
    Object.assign(result, absoluteDrops(r, end, labelsAt));
  }
  result.segments = {};
  for (const segment of segments) {
    const start = Math.max(0, segment.start);
    const stop = Math.min(end, segment.end);
    if (!(stop > start)) continue;
    const lost = 1 - r(stop) / r(start);
    const entry = {
      start: round(start, 2),
      end: round(stop, 2),
      label: segment.label,
      ...(finite(segment.songTime) ? { songTime: segment.songTime } : {}),
      lost: round(lost, 4),
    };
    if (rb) {
      const benchLost = 1 - rb(stop) / rb(start);
      if (benchLost > 0) entry.multiplier = round(lost / benchLost, 2);
      entry.benchmarkLost = round(benchLost, 4);
      // Had this stretch kept people like similar videos do, everyone after it would scale up.
      entry.gain = round((r(start) * (rb(stop) / rb(start))) / r(stop) - 1, 3);
      entry.keptVsBenchmark = round(r(stop) / rb(stop), 2);
    }
    (result.segments[segment.kind] ??= []).push(entry);
  }
  return result;
}

/** What each kind of segment shows at second `t`: { 图层: "第二幕", 歌词: "…" }. */
function labelsAtTime(segments, t) {
  const out = {};
  for (const segment of segments) if (segment.start <= t && t < segment.end && !out[segment.kind]) out[segment.kind] = segment.label;
  return out;
}

/** Without similar videos to compare with: the steepest stretches and where the curve rises (rewatching). */
function absoluteDrops(r, end, labelsAt) {
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
      .map(({ t }) => ({ start: round(t, 2), end: round(t + window, 2), from: round(r(t), 4), to: round(r(t + window), 4), labels: labelsAt(t + window / 2) }));
  };
  return { drops: pick((sample) => -sample.change, Math.max(0.02, average * 1.5), 3), rises: pick((sample) => sample.change, 0.02, 2) };
}

/**
 * The hourly views (and followers, channels) of a post: totals at 24/48/72 hours, per day
 * (Beijing time), the waves (runs of hours above 30 % of the busiest, runs at most two hours
 * apart joined) and each channel's share.
 */
export function flowAnalysis(review, post) {
  const views = seriesOf(review, post, "views");
  if (!views) return null;
  const start = Date.parse(views.start);
  const posted = Date.parse(post.postedAt);
  const total = views.values.reduce((sum, value) => sum + value, 0);
  const at = (index) => new Date(start + index * HOUR).toISOString();
  const firstHours = [24, 48, 72, 168]
    .filter((hours) => start + views.values.length * HOUR >= posted + hours * HOUR)
    .map((hours) => ({ hours, views: views.values.reduce((sum, value, index) => (start + index * HOUR < posted + hours * HOUR ? sum + value : sum), 0) }));
  const daily = [];
  views.values.forEach((value, index) => {
    const date = beijing(at(index), { time: false });
    if (daily.at(-1)?.date !== date) daily.push({ date, views: 0 });
    daily.at(-1).views += value;
  });
  // Waves: hours above 30 % of the busiest one; gaps of two hours or less join.
  const threshold = Math.max(...views.values) * 0.3;
  const runs = [];
  views.values.forEach((value, index) => {
    if (value < threshold) return;
    const last = runs.at(-1);
    if (last && index - last.to <= 3) last.to = index;
    else runs.push({ from: index, to: index });
  });
  const waves = runs.map(({ from, to }) => {
    const slice = views.values.slice(from, to + 1);
    const peak = slice.indexOf(Math.max(...slice));
    return { start: at(from), end: at(to + 1), views: slice.reduce((sum, value) => sum + value, 0), peak: { at: at(from + peak), views: slice[peak] } };
  });
  const channels = review.series
    .filter((series) => series.post === post.id && series.key.startsWith("views:"))
    .map((series) => {
      const sum = series.values.reduce((all, value) => all + value, 0);
      return { name: series.key.slice(6), views: sum, share: total ? sum / total : 0 };
    })
    // A channel that is nearly everything is the platform itself (抖音 = 播放量 − 抖音精选).
    .filter((channel) => channel.share < 0.95);
  const followers = seriesOf(review, post, "followers");
  return {
    start: views.start,
    hours: views.values.length,
    total,
    firstHours,
    daily,
    waves,
    channels,
    ...(followers ? { followersTotal: followers.values.reduce((sum, value) => sum + value, 0) } : {}),
  };
}

// ---- text ----------------------------------------------------------------------------------

/** Which rate goes next to a count. */
const RATE_OF = {
  likes: "likeRate",
  comments: "commentRate",
  shares: "shareRate",
  favorites: "favoriteRate",
  dislikes: "dislikeRate",
  followers: "followsPerThousand",
  unfollows: "unfollowRate",
  avgWatchTime: "watchRatio",
};
/** The numbers a post's history shows, export by export. */
const HISTORY_COLUMNS = [
  "views",
  "likeRate",
  "commentRate",
  "shareRate",
  "favoriteRate",
  "followers",
  "bounce2s",
  "retention5s",
  "retentionEnd",
  "completionRate",
];
const segmentLine = (item) =>
  `${round(item.start, 1)}–${round(item.end, 1)} 秒 ${item.label}${finite(item.multiplier) ? ` ${times(item.multiplier)}` : ` 流失 ${formatPercent(item.lost)}`}${finite(item.gain) && Math.abs(item.gain) >= 0.01 ? `（按同类走结尾${item.gain > 0 ? "多" : "少"} ${formatPercent(Math.abs(item.gain))}）` : ""}`;
const short = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const labelsText = (labels, max = 30) =>
  Object.entries(labels ?? {})
    .map(([kind, label]) => `${kind}「${short(label, max)}」`)
    .join(" ");
/** "raw/2026-10-10/a.xlsx、raw/2026-10-10/b.xlsx、…" → "raw/2026-10-10/ 的 6 个文件". */
const sourceText = (source) => {
  const files = String(source || "")
    .split("、")
    .filter(Boolean);
  const folders = new Set(files.map((file) => file.slice(0, file.lastIndexOf("/") + 1)));
  return files.length > 2 && folders.size === 1 && [...folders][0] ? `${[...folders][0]} 的 ${files.length} 个文件` : files.join("、");
};
/** A post's time as known: imported without one, it is the first hour of the hourly data. */
const postedText = (review, post) => {
  const views = seriesOf(review, post, "views");
  const estimated = views && Date.parse(views.start) === Date.parse(post.postedAt) && Date.parse(post.postedAt) % HOUR === 0;
  return estimated ? `${beijing(post.postedAt).slice(0, 13)} 点多（北京时间，按每小时数据估计）` : `${beijing(post.postedAt)}（北京时间）`;
};

/**
 * The overview review_read returns. `analyses[post]` = { retention, flow }; `segmentKinds` =
 * { 幕: 4, 歌词: 17 }; `changed[post]` = the work's version now, when the picture changed since that post.
 */
export function reviewText({ review, title, duration, files, documents, analyses, segmentKinds = {}, changed = {} }) {
  const lines = [`复盘「${title}」（作品 ${review.work}${duration ? `，时长 ${round(duration, 2)} 秒` : ""}）`];
  if (review.moments.length) lines.push(`关键时刻：${review.moments.map((moment) => `${moment.label} ${moment.at} 秒`).join("、")}`);
  const kinds = Object.entries(segmentKinds);
  if (kinds.length) lines.push(`分段：${kinds.map(([kind, count]) => `${kind} ${count} 段`).join("、")}（按幕、按歌词等统计流失）`);
  if (!review.posts.length)
    lines.push(
      "",
      "还没有发布记录。上传平台后台导出的数据用 review_import 导入（抖音创作者中心的导出能自动认出），或用 review_write 的 post 记下发到了哪个平台、什么时候发的，再用 snapshot 录入数据。",
    );
  for (const post of review.posts) {
    const length = post.duration ?? duration;
    const now = latest(review, post, { duration: length });
    const list = snapshotsOf(review, post);
    const { retention, flow } = analyses?.[post.id] ?? {};
    lines.push(
      "",
      `${post.id} ${post.platform}${post.account ? `（${post.account}）` : ""}「${post.title ?? title}」${postedText(review, post)}发布，现在${ageLabel(ageDays(post, new Date().toISOString())).replace("发布后 ", "已发布 ")}${post.url ? `；${post.url}` : ""}`,
      ...(post.pinnedComment ? [`  置顶评论：${post.pinnedComment}`] : []),
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
      ...(changed[post.id]
        ? [
            `  注意：作品在这次发布之后改过（现在的版本 ${changed[post.id]}），preview_frames 看到的和按图层、镜头的分段是现在的作品，不一定是观众看到的；改了什么用 version_diff 对照发布时的版本`,
          ]
        : []),
      ...(post.notes ? [`  备注：${post.notes}`] : []),
    );
    if (post.goals && now)
      lines.push(
        `  目标：${Object.entries(post.goals)
          .map(([key, goal]) => {
            const value = now.metrics[key];
            const reached = LOWER_IS_BETTER.has(key) ? value <= goal : value >= goal;
            const done = !finite(value)
              ? "还没有数据"
              : definition(key).kind === "count" && !LOWER_IS_BETTER.has(key)
                ? `完成 ${formatPercent(value / goal)}`
                : reached
                  ? `已达成，现在 ${formatValue(key, value)}`
                  : `未达成，现在 ${formatValue(key, value)}`;
            return `${metricLabel(key)} ${key === "views" ? formatCount(goal) : formatValue(key, goal)}（${done}）`;
          })
          .join("｜")}`,
      );
    if (!now) {
      lines.push("  还没有数据。");
      continue;
    }
    const numbers = now.metrics;
    // The standard metrics in their order, then the platform's own (投币…); rates go next to their counts.
    const custom = Object.keys(numbers).filter((key) => !METRICS.some((item) => item.key === key) && !isDerived(key));
    // The average watch ratio already stands next to the average watch time.
    const shown = [...METRICS.map((item) => item.key).filter((key) => key in numbers && !(key === "watchRatio" && "avgWatchTime" in numbers)), ...custom];
    // A metric the newest snapshot lacks comes from an earlier one: say which.
    const older = (key) => (now.from[key] !== now.at ? ageShort(ageDays(post, now.from[key])) : "");
    lines.push(
      `  最新数据（统计到 ${beijing(now.at)}，${ageLabel(ageDays(post, now.at))}${list.at(-1).source ? `，来自 ${sourceText(list.at(-1).source)}` : ""}）：${shown
        .map((key) => {
          const rate =
            RATE_OF[key] && RATE_OF[key] in numbers
              ? `${RATE_OF[key] === "followsPerThousand" ? "每千次播放 " : ""}${formatValue(RATE_OF[key], numbers[RATE_OF[key]])}`
              : "";
          const bench = isBenchmarked(key) && finite(now.benchmark[key]) ? `同类 ${formatValue(key, now.benchmark[key])}` : "";
          const note = [rate, bench, older(key)].filter(Boolean).join("，");
          return `${metricLabel(key)} ${key === "views" ? formatCount(numbers[key]) : formatValue(key, numbers[key])}${note ? `（${note}）` : ""}`;
        })
        .join("｜")}`,
    );
    // How the numbers moved between exports (for remove_snapshot or merging, the times are the snapshots' own).
    if (list.length > 1) {
      const rows = list.map((snapshot) => ({
        snapshot,
        metrics: derive(snapshot.metrics, { duration: length, retention: snapshot.retention, moments: review.moments }),
      }));
      const used = HISTORY_COLUMNS.filter((key) => rows.some((row) => finite(row.metrics[key])));
      lines.push(
        `  历次数据（共 ${list.length} 次）：`,
        `  | 统计到（北京时间） | 发布后 | ${used.map(metricLabel).join(" | ")} | 来自 |`,
        `  |${" --- |".repeat(used.length + 3)}`,
        ...rows.map(
          ({ snapshot, metrics }) =>
            `  | ${beijing(snapshot.at)} | ${ageShort(ageDays(post, snapshot.at)).slice(2)} | ${used.map((key) => formatValue(key, metrics[key])).join(" | ")} | ${sourceText(snapshot.source) || "—"} |`,
        ),
      );
    }
    if (flow) {
      const parts = [
        flow.firstHours.length
          ? flow.firstHours.map((item) => `${item.hours === 24 ? "首 24 小时" : `${item.hours} 小时`} ${formatCount(item.views)}`).join("｜")
          : "",
        `按天：${flow.daily.map((item) => `${item.date.slice(5)} ${formatCount(item.views)}`).join("、")}`,
        flow.waves.length
          ? `几波：${flow.waves.map((wave) => `${beijing(wave.start).slice(5)}–${beijing(wave.end, { date: false })} 共 ${formatCount(wave.views)}（最高 ${beijing(wave.peak.at, { date: false })} ${formatCount(wave.peak.views)}）`).join("；")}`
          : "",
        flow.channels.length
          ? flow.channels.map((channel) => `${channel.name} ${formatCount(channel.views)}（${formatPercent(channel.share)}）`).join("、")
          : "",
      ].filter(Boolean);
      lines.push(
        `  流量（每小时数据，北京时间，共 ${flow.hours} 小时；每小时加起来 ${formatCount(flow.total)}，和总数可能对不上，总数看指标数据）：${parts.join("；")}`,
      );
    }
    if (now.sources?.length)
      lines.push(
        `  流量来源（括号里是账号近 7 天平均）：${now.sources
          .map(
            (source) =>
              `${source.name} ${formatPercent(source.share)}${finite(source.vsAccount) ? `（${formatPercent(source.share - source.vsAccount)}）` : ""}`,
          )
          .join("｜")}`,
      );
    if (retention) {
      const pair = (mine, theirs) => `${formatPercent(mine)}${finite(theirs) ? `（同类 ${formatPercent(theirs)}）` : ""}`;
      lines.push(
        `  留存${retention.hasBenchmark ? "（和同类比）" : ""}：开头 ${retention.opening.seconds} 秒还在 ${pair(retention.opening.kept, retention.opening.keptBenchmark)}｜半程 ${formatPercent(retention.half)}｜结尾 ${pair(retention.end, now.benchmark.retentionEnd)}${finite(retention.keptVsBenchmark) ? `，还在看的人是同类的 ${retention.keptVsBenchmark} 倍` : ""}${retention.moments.length ? `；${retention.moments.map((moment) => `${moment.label}（${moment.at} 秒）还在 ${pair(moment.kept, moment.keptBenchmark)}`).join("；")}` : ""}`,
      );
      if (retention.peaks?.length)
        lines.push(
          `  流失率是同类几倍最高的几秒（括号里是前两秒、后两秒）：${retention.peaks
            .map(
              (peak) =>
                `${peak.t}–${peak.t + 1} 秒 ${times(peak.multiplier)}（${peak.around
                  .map((value) => (finite(value) ? round(value, 2) : "—"))
                  .map((value, index) => (index === 2 ? `| ${value}` : value))
                  .join(" ")}）${labelsText(peak.labels) ? ` ${labelsText(peak.labels)}` : ""}`,
            )
            .join("；")}`,
          `  看这几秒的画面：preview_frames 的 times 用 [${retention.peaks.map((peak) => peak.t + 0.5).join(", ")}]；一段时间逐秒的数字用 review_read 的 seconds`,
        );
      for (const [kind, items] of Object.entries(retention.segments))
        lines.push(`  按${kind}（${retention.hasBenchmark ? "流失率 ÷ 同类" : "这一段走掉的比例"}）：${items.map(segmentLine).join("；")}`);
      const stretch = (item, word) =>
        `${item.start}–${item.end} 秒 ${word} ${formatPercent(Math.abs(item.to - item.from))}${labelsText(item.labels) ? `（${labelsText(item.labels)}）` : ""}`;
      if (retention.drops?.length) lines.push(`  流失明显的地方：${retention.drops.map((item) => stretch(item, "流失")).join("；")}`);
      if (retention.rises?.length) lines.push(`  被回看的地方：${retention.rises.map((item) => stretch(item, "回升")).join("；")}`);
    }
    if (now.comments) {
      const { threads, replies, top } = now.comments;
      lines.push(
        `  评论导出：${[finite(threads) ? `一级评论 ${threads} 条` : "", finite(replies) ? `回复 ${replies} 条` : ""].filter(Boolean).join("、")}${
          top?.length
            ? `；赞最多：${top
                .slice(0, 5)
                .map((item) => `「${item.text.slice(0, 40)}」（${item.likes} 赞${item.replies ? `，${item.replies} 回复` : ""}）`)
                .join("、")}`
            : ""
        }`,
      );
    }
  }
  lines.push("", `复盘文档：${documents.length ? documents.map((doc) => `${doc.path}${doc.title ? `（${doc.title}）` : ""}`).join("、") : "（还没有）"}`);
  lines.push(
    `原始文件：${files.length ? files.map((file) => `${file.path}${file.used ? "（已录入）" : "（未录入）"}`).join("、") : "（还没有。用户可以在「复盘」视图上传平台后台导出的表格或截图）"}`,
  );
  return lines.join("\n");
}

/**
 * A stretch second by second: who is still watching, who leaves in each second (of those
 * still there) next to similar videos, the multiple, and what is on screen whenever it
 * changes; first the stretch as a whole, with what following similar videos there would
 * leave at the end. Null when the stretch is outside the video.
 */
export function secondsText({ retention, benchmark, duration, segments = [], moments = [], from, to }) {
  const end = duration > 0 ? duration : retention.at(-1)[0];
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(Math.ceil(to), end);
  if (!(b > a)) return null;
  const r = (t) => retentionAt(retention, Math.min(t, end));
  const rb = benchmark?.length ? (t) => retentionAt(benchmark, Math.min(t, end)) : null;
  const lost = 1 - r(b) / r(a);
  let head = `${a}–${round(b, 2)} 秒：开始时还在 ${formatPercent(r(a))}${rb ? `（同类 ${formatPercent(rb(a))}）` : ""}，这段走掉 ${formatPercent(lost)}`;
  if (rb) {
    const benchLost = 1 - rb(b) / rb(a);
    const gain = (r(a) * (rb(b) / rb(a))) / r(b) - 1;
    head += `（同类 ${formatPercent(benchLost)}）${benchLost > 0 ? `，是同类的 ${times(lost / benchLost)}` : ""}${finite(gain) ? `；这段按同类的流失率走，看到结尾的人${gain >= 0 ? "多" : "少"} ${formatPercent(Math.abs(gain))}` : ""}`;
  }
  const rows = [];
  let shown = {};
  for (let t = a; t < b - 1e-9; t++) {
    const next = Math.min(t + 1, b);
    const leaving = r(t) > 0 ? 1 - r(next) / r(t) : null;
    const leavingTheirs = rb && rb(t) > 0 ? 1 - rb(next) / rb(t) : null;
    const labels = labelsAtTime(segments, t + 0.5);
    const changes = Object.entries(labels).filter(([kind, label]) => shown[kind] !== label);
    shown = labels;
    const marks = moments.filter((moment) => moment.at >= t && moment.at < next).map((moment) => `◆${moment.label} ${moment.at} 秒`);
    const picture = [...marks, ...changes.map(([kind, label]) => `${kind}「${short(label, 40)}」`)].join(" ");
    rows.push(
      rb
        ? `| ${t} | ${formatPercent(r(t))} | ${formatPercent(rb(t))} | ${formatPercent(leaving)} | ${formatPercent(leavingTheirs)} | ${finite(leaving) && leavingTheirs > 0 ? times(leaving / leavingTheirs) : "—"} | ${picture} |`
        : `| ${t} | ${formatPercent(r(t))} | ${formatPercent(leaving)} | ${picture} |`,
    );
  }
  const header = rb
    ? ["| 秒 | 还在 | 同类还在 | 这一秒走掉 | 同类走掉 | 倍数 | 画面（变了才写） |", `|${" --- |".repeat(7)}`]
    : ["| 秒 | 还在 | 这一秒走掉 | 画面（变了才写） |", `|${" --- |".repeat(4)}`];
  return [head, "", ...header, ...rows].join("\n");
}

/** The comparison as the AI reads it: a table (similar videos' value next to each), the medians, how `current` stands. */
export function compareText(rows, { checkpoint, columns, current } = {}) {
  const days = CHECKPOINTS[checkpoint];
  const shown = columns ?? [...DEFAULT_COLUMNS, ...momentColumns(rows)];
  const exact = rows.some((row) => row.exact?.length);
  const head =
    days === null
      ? "各发布记录的最新数据（发布天数不同，越早发的数字越大，只能粗看）"
      : `发布后第 ${days} 天的数据（取第 ${round(days - Math.max(0.5, days * 0.2), 1)}–${round(days + Math.max(0.5, days * 0.2), 1)} 天之间最接近的一次记录${exact ? "；标 * 的播放、涨粉按每小时数据正好算到第 " + days + " 天" : ""}）`;
  const withData = rows.filter((row) => row.age !== null);
  const without = rows.filter((row) => row.age === null);
  if (!rows.length) return "没有符合条件的发布记录。";
  // The id lets the AI read that work's review next.
  const name = (row) => `${current && row.work === current ? "▶ " : ""}${row.title} ${row.work}${row.missing ? "（作品已删除）" : ""}`;
  const cell = (row, key) =>
    `${formatValue(key, row.metrics[key])}${row.exact?.includes(key) ? "*" : ""}${isBenchmarked(key) && finite(row.benchmark?.[key]) && finite(row.metrics[key]) ? `（同类 ${formatValue(key, row.benchmark[key])}）` : ""}`;
  const table = [
    `| 作品 | 平台 | 发布（北京时间） | ${shown.map(metricLabel).join(" | ")} |`,
    `|${" --- |".repeat(shown.length + 3)}`,
    ...withData.map((row) => `| ${name(row)} | ${row.platform} | ${beijing(row.postedAt)} | ${shown.map((key) => cell(row, key)).join(" | ")} |`),
  ];
  const medians = Object.fromEntries(shown.map((key) => [key, median(withData.map((row) => row.metrics[key]))]));
  const lines = [head, "", ...(withData.length ? table : ["（没有发布记录在这个时间点有数据）"])];
  if (withData.length > 1)
    lines.push(
      "",
      `中位数（${withData.length} 条）：${shown
        .filter((key) => medians[key] !== null)
        .map((key) => `${metricLabel(key)} ${formatValue(key, medians[key])}`)
        .join("｜")}`,
    );
  for (const row of withData.filter((item) => current && item.work === current)) {
    const notes = shown
      .filter((key) => finite(row.metrics[key]) && medians[key] > 0 && withData.length > 1)
      .map((key) => `${metricLabel(key)} ${formatValue(key, row.metrics[key])}，是中位数的 ${round(row.metrics[key] / medians[key], 2)} 倍`);
    if (notes.length) lines.push("", `本作品（${row.platform}）：${notes.join("；")}`);
  }
  // Hourly data gives views and followers at any age; the rest needs an export near it.
  const hourlyOnly = withData.filter(
    (row) => row.exact?.length && Object.keys(row.metrics).every((key) => row.exact.includes(key) || key === "followsPerThousand"),
  );
  if (hourlyOnly.length && days !== null)
    lines.push(
      "",
      `第 ${days} 天只有每小时数据算出的播放、涨粉的：${hourlyOnly
        .map((row) => `${row.title}（${row.snapshots.length ? `导出过的是发布后 ${row.snapshots.join("、")} 天` : "只有每小时数据"}）`)
        .join("；")}。比例和留存变化慢，可以用 checkpoint: "latest" 粗看`,
    );
  if (without.length)
    lines.push(
      "",
      `这个时间点没有数据的：${without
        .map((row) => `${row.title}（${row.platform}，${row.snapshots.length ? `只有发布后 ${row.snapshots.join("、")} 天的` : "还没有数据"}）`)
        .join("；")}`,
    );
  return lines.join("\n");
}

/** The works' moments as columns ("moment:反转"), most common first. */
export function momentColumns(rows) {
  const counts = new Map();
  for (const row of rows) for (const moment of row.moments ?? []) counts.set(moment.label, (counts.get(moment.label) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([label]) => `moment:${label}`);
}

/**
 * Works that use the same song, line by line: each lyric line (by its time in the song) with
 * every work's multiplier there, so what the song does and what the picture does come apart.
 * `rows[i].lyrics`: [{ songTime, label, multiplier }].
 */
export function lyricsText(rows) {
  const key = (line) => `${round(line.songTime, 1)}|${line.label}`;
  // Works sharing lyric lines use the same song: one table per song.
  const songs = [];
  for (const row of rows.filter((item) => item.lyrics?.some((line) => finite(line.songTime)))) {
    const keys = new Set(row.lyrics.filter((line) => finite(line.songTime)).map(key));
    const song = songs.find((item) => [...keys].some((line) => item.keys.has(line)));
    if (song) {
      song.rows.push(row);
      for (const line of keys) song.keys.add(line);
    } else songs.push({ rows: [row], keys });
  }
  const tables = [];
  for (const { rows: works } of songs.filter((song) => song.rows.length >= 2)) {
    const lines = new Map();
    for (const row of works)
      for (const line of row.lyrics.filter((item) => finite(item.songTime))) {
        const entry = lines.get(key(line)) ?? { songTime: line.songTime, label: line.label, values: new Map() };
        entry.values.set(`${row.work}/${row.post}`, line.multiplier);
        lines.set(key(line), entry);
      }
    const shared = [...lines.values()].filter((entry) => entry.values.size >= 2).sort((a, b) => a.songTime - b.songTime);
    if (!shared.length) continue;
    tables.push(
      [
        `| 歌曲时间 | 歌词 | ${works.map((row) => `${row.title}·${row.platform}`).join(" | ")} |`,
        `|${" --- |".repeat(works.length + 2)}`,
        ...shared.map(
          (entry) =>
            `| ${round(entry.songTime, 1)} | ${entry.label} | ${works.map((row) => (finite(entry.values.get(`${row.work}/${row.post}`)) ? times(entry.values.get(`${row.work}/${row.post}`)) : "—")).join(" | ")} |`,
        ),
      ].join("\n"),
    );
  }
  return tables.length ? `同一首歌按歌词对齐（流失率 ÷ 同类）：\n${tables.join("\n\n")}` : "";
}
