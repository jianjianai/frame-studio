import { readTable } from "./sheets.mjs";

/**
 * Exports from a platform's creator center, read into review data without the AI. Today
 * that is the Douyin creator center's work data — 指标数据, 留存分析 (the video and 同类作品,
 * per second), the hourly 播放量 / 涨粉量 by channel, 流量来源 with 对比7日 — and a comments
 * export (全部评论). Files are recognized by their sheets and headers, not their names
 * (people rename them). Times in the sheets are Beijing time.
 */

const PLATFORM = "抖音";
/** Header → metric. Rates the counts give anyway are kept only when the count is missing. */
const HEADERS = {
  播放量: "views",
  点赞量: "likes",
  评论量: "comments",
  分享量: "shares",
  收藏量: "favorites",
  弹幕量: "danmaku",
  完播率: "completionRate",
  "2s跳出率": "bounce2s",
  "5s完播率": "retention5s",
  平均播放时长: "avgWatchTime",
  平均播放占比: "watchRatio",
  不感兴趣量: "dislikes",
  涨粉量: "followers",
  脱粉量: "unfollows",
  粉丝播放占比: "fanViewShare",
  点赞率: "likeRate",
  评论率: "commentRate",
  分享率: "shareRate",
  收藏率: "favoriteRate",
  不感兴趣率: "dislikeRate",
  涨粉率: "followRate",
  脱粉率: "unfollowRate",
};
const RATE_OF_COUNT = {
  likeRate: "likes",
  commentRate: "comments",
  shareRate: "shares",
  favoriteRate: "favorites",
  dislikeRate: "dislikes",
  followRate: "followers",
  unfollowRate: "unfollows",
};
const SECONDS = new Set(["avgWatchTime"]);
const RATIOS = new Set(["completionRate", "bounce2s", "retention5s", "watchRatio", "fanViewShare", ...Object.keys(RATE_OF_COUNT)]);

const clean = (cell) => String(cell ?? "").replace(/\s+/g, "");
/** "16.93%" → 0.1693, "-2.4%" → -0.024. */
export function parsePercent(cell) {
  const match = /^([+-]?\d+(?:\.\d+)?)%$/.exec(clean(cell));
  return match ? Number((Number(match[1]) / 100).toPrecision(12)) : null;
}
/** "13秒", "1分2秒", "01:02", "1:02:03" → seconds. */
export function parseSeconds(cell) {
  const text = clean(cell);
  const units = /^(?:(\d+)(?:小时|时))?(?:(\d+)分(?:钟)?)?(?:(\d+(?:\.\d+)?)秒)?$/.exec(text);
  if (units && (units[1] || units[2] || units[3])) return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  if (/^\d+(?::\d+){1,2}(?:\.\d+)?$/.test(text)) return text.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
  return /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
}
/** "240802", "1,234", "1.2万" → a number. */
export function parseCount(cell) {
  const match = /^([+-]?\d+(?:\.\d+)?)(万|亿)?$/.exec(clean(cell).replace(/,/g, ""));
  return match ? Number(match[1]) * (match[2] === "亿" ? 1e8 : match[2] === "万" ? 1e4 : 1) : null;
}
/** "2026-10-07 23:00" in Beijing time → ISO. */
export function beijingTime(cell) {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(cell ?? "").trim());
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = match;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +s)).toISOString();
}
const valueOf = (key, cell) => (SECONDS.has(key) ? parseSeconds(cell) : RATIOS.has(key) ? parsePercent(cell) : parseCount(cell));

/**
 * Read a set of files (one export from the creator center): { platform, recognized: [{ path,
 * parts }], unrecognized, metrics, retention, retentionBenchmark, series, sources, comments,
 * dataEnd (start of the last hour in the hourly data: the numbers run up to the export),
 * firstHour (the hour of posting), commentsAt, postTitle }. `files`: [{ path, file }].
 */
export function readExports(files) {
  const out = { platform: null, recognized: [], unrecognized: [], metrics: {}, series: [], sources: [], retention: [], retentionBenchmark: [] };
  for (const { path, file } of files) {
    let table;
    try {
      table = readTable(file);
    } catch {
      out.unrecognized.push(path);
      continue;
    }
    const parts = [];
    for (const sheet of table.sheets) {
      const part = readSheet(sheet, out);
      if (part) parts.push(part);
    }
    if (parts.length) out.recognized.push({ path, parts });
    else out.unrecognized.push(path);
  }
  if (out.recognized.length) out.platform = PLATFORM;
  // The platform's rates are rounded: the counts give them exactly.
  for (const [rate, count] of Object.entries(RATE_OF_COUNT)) if (rate in out.metrics && count in out.metrics) delete out.metrics[rate];
  const hourly = out.series.filter((series) => series.step === 3600);
  if (hourly.length) {
    out.dataEnd = new Date(Math.max(...hourly.map((series) => Date.parse(series.start) + (series.values.length - 1) * 3600000))).toISOString();
    out.firstHour = new Date(Math.min(...hourly.map((series) => Date.parse(series.start)))).toISOString();
  }
  if (!out.retention.length) delete out.retention;
  if (!out.retentionBenchmark.length) delete out.retentionBenchmark;
  if (!out.sources.length) delete out.sources;
  return out;
}

function readSheet(sheet, out) {
  const rows = sheet.rows.filter((row) => row.some((cell) => cell !== ""));
  if (!rows.length) return null;
  const header = rows[0].map(clean);
  // 指标数据: one header row and one row of values.
  const known = header.filter((name) => HEADERS[name]);
  if (known.length && known.length >= header.filter(Boolean).length / 2 && rows.length >= 2 && !header.includes("日期")) {
    header.forEach((name, index) => {
      const key = HEADERS[name];
      const value = key ? valueOf(key, rows[1][index]) : null;
      if (key && value !== null) out.metrics[key] = value;
    });
    return "指标";
  }
  // 留存分析: 时间 | 留存 | 同类作品, a row per second.
  if (header[0] === "时间" && header.includes("留存")) {
    const mine = header.indexOf("留存");
    const theirs = header.findIndex((name) => name.includes("同类"));
    out.retention = [];
    out.retentionBenchmark = [];
    for (const row of rows.slice(1)) {
      const t = parseSeconds(row[0]);
      if (t === null) continue;
      const value = parsePercent(row[mine]);
      if (value !== null) out.retention.push([t, value]);
      const bench = theirs >= 0 ? parsePercent(row[theirs]) : null;
      if (bench !== null) out.retentionBenchmark.push([t, bench]);
    }
    return theirs >= 0 ? "逐秒留存（含同类作品）" : "逐秒留存";
  }
  // 播放量-新增-每小时趋势数据: 日期 | 播放量 | 抖音 | 抖音精选 (channels add up to the total).
  const hourly = /^(.+?)-新增-每小时趋势/.exec(sheet.name);
  if (hourly && header[0] === "日期") {
    const key = HEADERS[clean(hourly[1])];
    if (!key) return null;
    const times = rows.slice(1).map((row) => beijingTime(row[0]));
    if (times.some((time) => !time) || !times.length) return null;
    header.slice(1).forEach((name, offset) => {
      const values = new Map(rows.slice(1).map((row, index) => [Date.parse(times[index]), parseCount(row[offset + 1]) ?? 0]));
      const first = Math.min(...values.keys());
      const last = Math.max(...values.keys());
      const id = offset === 0 ? key : `${key}:${name}`;
      // The same file twice (a re-upload): one series.
      out.series = out.series.filter((series) => series.key !== id);
      out.series.push({
        key: id,
        start: new Date(first).toISOString(),
        step: 3600,
        values: Array.from({ length: Math.round((last - first) / 3600000) + 1 }, (_, index) => values.get(first + index * 3600000) ?? 0),
      });
    });
    return key === "views" ? "每小时播放（分渠道）" : key === "followers" ? "每小时涨粉" : `每小时${clean(hourly[1])}`;
  }
  // 涨粉量-累计-每天趋势数据: the hourly data says it all.
  if (/每天趋势/.test(sheet.name) && header[0] === "日期") return "每天趋势（用每小时数据）";
  // 流量来源: 来源 | 来源占比 | 对比7日.
  if (header.includes("来源") && header.includes("来源占比")) {
    const name = header.indexOf("来源");
    const share = header.indexOf("来源占比");
    const versus = header.findIndex((item) => item.startsWith("对比"));
    out.sources = rows
      .slice(1)
      .map((row) => ({ name: String(row[name]).trim(), share: parsePercent(row[share]), vsAccount: versus >= 0 ? parsePercent(row[versus]) : null }))
      .filter((item) => item.name && item.share !== null)
      .map((item) => ({ name: item.name, share: item.share, ...(item.vsAccount !== null ? { vsAccount: item.vsAccount } : {}) }));
    return "流量来源";
  }
  // 弹幕: 时间段 | 当前作品 | 同类作品 — kept in the raw file only.
  if (header[0] === "时间" && header.includes("当前作品")) return "弹幕分布（留在原始文件里）";
  // A comments export: a few lines about it, then 序号 | 评论层级 | … | 评论内容 | 点赞数 | … | 已导出回复数.
  const headerAt = rows.findIndex((row) => row.map(clean).includes("评论内容"));
  if (headerAt >= 0) {
    const columns = rows[headerAt].map(clean);
    const column = (name) => columns.indexOf(name);
    const items = rows.slice(headerAt + 1).filter((row) => row[column("评论内容")] !== undefined);
    const level = column("评论层级");
    const threads = items.filter((row) => level < 0 || String(row[level]).includes("一级"));
    const exported = rows
      .slice(0, headerAt)
      .map((row) => /导出时间[:：]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)/.exec(row.join(" "))?.[1])
      .find(Boolean);
    // The line under the export's own title is the video's title as posted (with its hashtags).
    const titleAt = rows.findIndex((row) => clean(row[0]).includes("全部评论"));
    const posted = titleAt >= 0 && titleAt + 1 < headerAt ? String(rows[titleAt + 1][0] ?? "").trim() : "";
    if (posted && !/^(导出时间|来源)/.test(posted)) out.postTitle = posted;
    out.comments = {
      threads: threads.length,
      replies: items.length - threads.length,
      top: threads
        .map((row) => ({
          text: String(row[column("评论内容")] ?? "").slice(0, 500),
          likes: parseCount(row[column("点赞数")]) ?? 0,
          replies: parseCount(row[column("已导出回复数")]) ?? 0,
        }))
        .filter((item) => item.text)
        .sort((a, b) => b.likes - a.likes || b.replies - a.replies)
        .slice(0, 10),
    };
    if (exported) out.commentsAt = beijingTime(exported);
    return "全部评论";
  }
  return null;
}
