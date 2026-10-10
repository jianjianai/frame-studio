import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { git } from "../server/git.mjs";
import { readTable, tableText, parseDelimited, decodeText, excelDate } from "../server/sheets.mjs";
import {
  applyOperations,
  atCheckpoint,
  compareRows,
  defaultCheckpoint,
  derive,
  emptyReview,
  formatReview,
  parseReview,
  snapshotOperation,
  seriesOperation,
  postOperation,
} from "../server/review-data.mjs";
import { retentionAnalysis, flowAnalysis, compareText, lyricsText } from "../server/review-analysis.mjs";
import { readExports, parsePercent, parseSeconds, beijingTime } from "../server/review-import.mjs";
import { workSegments, parseLrc } from "../server/review-segments.mjs";

const xlsx = (sheets, { styles = "", shared = [] } = {}) =>
  zipSync({
    "xl/workbook.xml": strToU8(
      `<workbook xmlns:r="r"><sheets>${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships>${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`,
    ),
    "xl/sharedStrings.xml": strToU8(`<sst>${shared.map((text) => `<si><t>${text}</t></si>`).join("")}</sst>`),
    "xl/styles.xml": strToU8(styles),
    ...Object.fromEntries(
      sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, strToU8(`<worksheet><sheetData>${sheet.xml}</sheetData></worksheet>`)]),
    ),
  });
/** A sheet of text cells, the way the creator center writes them. */
const rowsXml = (rows) => rows.map((row) => `<row>${row.map((cell) => `<c t="inlineStr"><is><t>${cell}</t></is></c>`).join("")}</row>`).join("");
const workbook = (sheets) => xlsx(Object.entries(sheets).map(([name, rows]) => ({ name, xml: rowsXml(rows) })));

// A 15-second video posted 2026-10-07 23:00 Beijing time, exported 30 hours later.
const retention = [100, 86, 70, 62, 55, 50, 46, 30, 27, 25, 23, 22, 21, 20, 19, 18];
const similar = [100, 87, 71, 63, 57, 53, 50, 48, 46, 44, 42, 41, 40, 39, 38, 37];
const hourly = Array.from({ length: 30 }, (_, hour) => (hour < 17 ? 10 : hour < 24 ? 400 : 100));
const time = (hour) => {
  const at = new Date(Date.UTC(2026, 9, 7, 23 + hour));
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)}`;
};
const exports = {
  "内容吸引力数据.xlsx": workbook({
    指标数据: [
      ["完播率", "平均播放时长", "2s跳出率", "5s完播率", "平均播放占比"],
      ["16.93%", "4秒", "30.79%", "46.46%", "26.67%"],
    ],
    留存分析: [
      ["时间", "留存", "同类作品"],
      ...retention.map((value, second) => [`00:${String(second).padStart(2, "0")}`, `${value}%`, `${similar[second]}%`]),
    ],
  }),
  "流量数据.xlsx": workbook({
    指标数据: [
      ["播放量", "点赞量", "评论量", "分享量", "收藏量", "弹幕量", "完播率", "2s跳出率"],
      ["5000", "350", "20", "60", "40", "3", "16.93%", "30.79%"],
    ],
    "播放量-新增-每小时趋势数据": [["日期", "播放量", "抖音", "抖音精选"], ...hourly.map((value, hour) => [time(hour), `${value}`, `${value - 1}`, "1"])],
  }),
  "流量来源.xlsx": workbook({
    抖音: [
      ["来源", "来源占比", "对比7日"],
      ["推荐页", "89.8%", "-2.4%"],
      ["个人主页", "5.9%", "+1.5%"],
    ],
  }),
  "粉丝数据.xlsx": workbook({
    指标数据: [
      ["涨粉量", "脱粉量", "粉丝播放占比"],
      ["30", "2", "0.78%"],
    ],
    "涨粉量-新增-每小时趋势数据": [["日期", "涨粉量", "抖音", "抖音精选"], ...hourly.map((_, hour) => [time(hour), "1", "1", "0"])],
  }),
  "全部评论.xlsx": workbook({
    全部评论: [
      ["抖音作品全部评论"],
      ["17岁生日 #生日 #s0rrow"],
      ["导出时间：2026-10-09 05:41:34（北京时间）；2 条一级评论，1 条回复。"],
      ["序号", "评论层级", "所属一级评论序号", "评论者昵称", "评论内容", "点赞数", "已导出回复数"],
      ["1", "一级评论", "", "a", "生日快乐", "3", "1"],
      ["2", "二级评论", "1", "b", "谢谢", "0", "0"],
      ["3", "一级评论", "", "c", "开飞行模式干嘛", "9", "0"],
    ],
  }),
};

describe("spreadsheets from creator centers", () => {
  it("reads xlsx values, shared and inline strings, dates and percentages", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-sheets-"));
    const file = path.join(dir, "抖音.xlsx");
    fs.writeFileSync(
      file,
      xlsx(
        [
          {
            name: "数据 &amp; 趋势",
            xml: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row><row r="3"><c r="A3" s="1"><v>46303</v></c><c r="B3"><v>12034</v></c><c r="C3" t="inlineStr"><is><t>a,b</t></is></c><c r="D3" s="2"><v>0.3125</v></c></row><row r="4"><c r="A4" s="3"><v>46303.8333333333</v></c><c r="B4"><v>0.30000000000000004</v></c><c r="E4" t="b"><v>1</v></c></row>`,
          },
          { name: "B", xml: `<row r="1"><c r="A1" t="str"><v>x</v></c></row>` },
        ],
        {
          shared: ["日期", "播放量", "完播率"],
          styles: `<styleSheet><numFmts count="1"><numFmt numFmtId="176" formatCode="yyyy/m/d\\ h:mm"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="10"/><xf numFmtId="176"/></cellXfs></styleSheet>`,
        },
      ),
    );
    const table = readTable(file);
    expect(table.sheets.map((sheet) => sheet.name)).toEqual(["数据 & 趋势", "B"]);
    expect(table.sheets[0].rows).toEqual([
      ["日期", "播放量", "", "完播率"],
      [],
      ["2026-10-08", "12034", "a,b", "31.25%"],
      ["2026-10-08 20:00", "0.3", "", "", "TRUE"],
    ]);
    expect(tableText(table)).toContain('2026-10-08,12034,"a,b",31.25%');
    expect(excelDate(0.000104)).toBe("00:00:09");
  });

  it("reads csv in UTF-8, UTF-16 and GB18030 with quoted fields", () => {
    expect(parseDelimited('a,"b,1","c ""q"""\r\n1,2,3\n"x\ny",,\n')).toEqual([["a", "b,1", 'c "q"'], ["1", "2", "3"], ["x\ny"]]);
    expect(parseDelimited("日期\t播放\n10-08\t5")).toEqual([
      ["日期", "播放"],
      ["10-08", "5"],
    ]);
    expect(decodeText(Buffer.from("﻿播放", "utf8"))).toBe("播放");
    expect(decodeText(Buffer.from([0xff, 0xfe, ...Buffer.from("播放", "utf16le")]))).toBe("播放");
    expect(decodeText(Buffer.from([0xb2, 0xa5, 0xb7, 0xc5]))).toBe("播放");
  });

  it("recognizes the Douyin creator center's exports by their sheets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-douyin-"));
    const files = Object.entries(exports).map(([name, data]) => {
      fs.writeFileSync(path.join(dir, name), data);
      return { path: `raw/${name}`, file: path.join(dir, name) };
    });
    fs.writeFileSync(path.join(dir, "别的.xlsx"), workbook({ Sheet1: [["a", "b"]] }));
    const parsed = readExports([...files, { path: "raw/别的.xlsx", file: path.join(dir, "别的.xlsx") }]);
    expect(parsed.platform).toBe("抖音");
    expect(parsed.unrecognized).toEqual(["raw/别的.xlsx"]);
    expect(parsed.recognized.find((item) => item.path === "raw/内容吸引力数据.xlsx").parts).toEqual(["指标", "逐秒留存（含同类作品）"]);
    expect(parsed.metrics).toMatchObject({
      views: 5000,
      likes: 350,
      bounce2s: 0.3079,
      retention5s: 0.4646,
      avgWatchTime: 4,
      watchRatio: 0.2667,
      followers: 30,
      unfollows: 2,
      fanViewShare: 0.0078,
    });
    expect(parsed.retention[3]).toEqual([3, 0.62]);
    expect(parsed.retentionBenchmark[3]).toEqual([3, 0.63]);
    expect(parsed.series.map((series) => series.key)).toEqual(["views", "views:抖音", "views:抖音精选", "followers", "followers:抖音", "followers:抖音精选"]);
    expect(parsed.series[0]).toMatchObject({ start: "2026-10-07T15:00:00.000Z", step: 3600 });
    expect(parsed.firstHour).toBe("2026-10-07T15:00:00.000Z");
    expect(parsed.dataEnd).toBe("2026-10-08T20:00:00.000Z");
    expect(parsed.sources).toEqual([
      { name: "推荐页", share: 0.898, vsAccount: -0.024 },
      { name: "个人主页", share: 0.059, vsAccount: 0.015 },
    ]);
    expect(parsed.comments).toEqual({
      threads: 2,
      replies: 1,
      top: [
        { text: "开飞行模式干嘛", likes: 9, replies: 0 },
        { text: "生日快乐", likes: 3, replies: 1 },
      ],
    });
    expect(parsed.commentsAt).toBe("2026-10-08T21:41:34.000Z");
    expect(parsed.postTitle).toBe("17岁生日 #生日 #s0rrow");
    expect([parsePercent("+1.5%"), parseSeconds("1分2秒"), parseSeconds("01:02"), beijingTime("2026-10-07 23:00")]).toEqual([
      0.015,
      62,
      62,
      "2026-10-07T15:00:00.000Z",
    ]);
  });
});

describe("review data", () => {
  const posted = "2026-10-01T12:00:00.000Z";
  const day = (days) => new Date(Date.parse(posted) + days * 86400000).toISOString();
  const review = () => {
    const value = emptyReview("w1", "夏日");
    const ops = [
      postOperation.parse({ op: "post", platform: "抖音", postedAt: "2026-10-01T20:00:00+08:00" }),
      snapshotOperation.parse({ op: "snapshot", post: "p1", at: day(1), metrics: { views: 1000, likes: 50 } }),
      snapshotOperation.parse({ op: "snapshot", post: "p1", at: day(6.5), metrics: { views: 5000, likes: 300, completionRate: 0.3 } }),
    ];
    const { results } = applyOperations(value, ops, { title: "夏日", duration: 15 });
    expect(results.every((result) => result.status === "ok")).toBe(true);
    return value;
  };

  it("adds posts and snapshots, merges the same moment and explains refusals", () => {
    const value = review();
    expect(value.posts).toEqual([{ id: "p1", platform: "抖音", title: "夏日", postedAt: posted, duration: 15 }]);
    const { results } = applyOperations(value, [
      snapshotOperation.parse({ op: "snapshot", post: "p1", at: day(6.5), metrics: { comments: 12 }, source: "raw/a.xlsx" }),
      snapshotOperation.parse({ op: "snapshot", post: "p1", at: day(7), metrics: { completionRate: 31 } }),
      snapshotOperation.parse({ op: "snapshot", post: "p1", at: day(-1), metrics: { views: 1 } }),
      snapshotOperation.parse({ op: "snapshot", post: "p9", at: day(1), metrics: { views: 1 } }),
      postOperation.parse({ op: "post", id: "p1", url: "https://example.com/v/1", pinnedComment: "回看第 1 秒", goals: { views: 1000000 } }),
      { op: "moment", label: "反转", at: 7.5 },
      { op: "segments", kind: "镜头", items: [{ start: 0, end: 5, label: "开场" }] },
    ]);
    expect(results.map((result) => result.status)).toEqual(["ok", "failed", "failed", "failed", "ok", "ok", "ok"]);
    expect(results[1].message).toContain("写 0–1");
    expect(results[2].message).toContain("时区");
    expect(results[3].message).toContain("没有发布记录 p9");
    expect(value.snapshots[1]).toMatchObject({ metrics: { views: 5000, likes: 300, completionRate: 0.3, comments: 12 }, source: "raw/a.xlsx" });
    expect(value.posts[0]).toMatchObject({ url: "https://example.com/v/1", pinnedComment: "回看第 1 秒", goals: { views: 1000000 } });
    // Hourly series merge by time: the newer values win where they overlap.
    applyOperations(value, [
      seriesOperation.parse({ op: "series", post: "p1", key: "views", start: posted, values: [1, 2, 3] }),
      seriesOperation.parse({ op: "series", post: "p1", key: "views", start: day(2 / 24), values: [30, 40] }),
    ]);
    expect(value.series[0]).toMatchObject({ start: posted, step: 3600, values: [1, 2, 30, 40] });
    // The file keeps a curve point per line, a list of numbers on one line, and reads back the same.
    value.snapshots[1].retention = [
      [0, 1],
      [3, 0.6],
    ];
    const text = formatReview(value);
    expect(text).toContain("[0, 1],\n");
    expect(text).toContain('"values": [1, 2, 30, 40]');
    expect(parseReview(text, "w1")).toEqual(value);
    expect(parseReview("{broken", "w1")).toEqual(emptyReview("w1"));
  });

  it("compares at the same age, with rates per view and hourly views exact at the checkpoint", () => {
    const value = review();
    expect(atCheckpoint(value, value.posts[0], "7d").metrics.views).toBe(5000);
    expect(atCheckpoint(value, value.posts[0], "1d").metrics.views).toBe(1000);
    expect(atCheckpoint(value, value.posts[0], "3d")).toBeNull();
    expect(atCheckpoint(value, value.posts[0], "latest").metrics).toEqual({
      views: 5000,
      likes: 300,
      completionRate: 0.3,
      likeRate: 0.06,
      engagementRate: 0.06,
    });
    expect(derive({ views: 1000, likes: 50, comments: 10, followers: 3, avgWatchTime: 6 }, { duration: 12 })).toMatchObject({
      likeRate: 0.05,
      commentRate: 0.01,
      engagementRate: 0.06,
      watchRatio: 0.5,
      followsPerThousand: 3,
    });
    // The platform's own number stays as given.
    expect(derive({ views: 100, watchRatio: 0.4, avgWatchTime: 6 }, { duration: 12 }).watchRatio).toBe(0.4);
    // 72 hourly values: the first three days are exact, without a snapshot there.
    applyOperations(value, [seriesOperation.parse({ op: "series", post: "p1", key: "views", start: posted, values: Array(72).fill(10) })]);
    expect(atCheckpoint(value, value.posts[0], "3d")).toMatchObject({ metrics: { views: 720 }, exact: ["views"] });
    expect(atCheckpoint(value, value.posts[0], "1d")).toMatchObject({ metrics: { views: 240, likes: 50 }, exact: ["views"] });

    const other = emptyReview("w2", "秋天");
    applyOperations(other, [
      postOperation.parse({ op: "post", platform: "抖音", postedAt: posted }),
      snapshotOperation.parse({ op: "snapshot", post: "p1", at: day(7.2), metrics: { views: 2000, likes: 200 } }),
      { op: "moment", label: "反转", at: 5 },
    ]);
    value.moments.push({ at: 7.5, label: "反转" });
    const entries = [
      { repo: "local", review: value, work: { title: "夏日", duration: 15, width: 1080, height: 1920 } },
      { repo: "local", review: other, work: { title: "秋天", duration: 20, width: 1920, height: 1080 } },
    ];
    const rows = compareRows(entries, { checkpoint: "7d" });
    expect(rows.map((row) => [row.title, row.shape, row.metrics.views, row.metrics.likeRate])).toEqual([
      ["夏日", "竖屏", 5000, 0.06],
      ["秋天", "横屏", 2000, 0.1],
    ]);
    const text = compareText(rows, { checkpoint: "7d", columns: ["views", "likeRate"], current: "w1" });
    expect(text).toContain("| ▶ 夏日 w1 | 抖音 | 2026-10-01 20:00 | 5,000 | 6% |");
    expect(text).toContain("中位数（2 条）：播放 3,500｜点赞率 8%");
    expect(text).toContain("本作品（抖音）：播放 5,000，是中位数的 1.43 倍");
    // Both works mark the reversal: it becomes a column of its own.
    expect(compareText(rows, { checkpoint: "7d" })).toContain("反转时还在");
    // Day 3 has only the hourly views: say where the rest is.
    expect(compareText(compareRows(entries, { checkpoint: "3d" }), { checkpoint: "3d" })).toContain(
      "第 3 天只有每小时数据算出的播放、涨粉的：夏日（导出过的是发布后 1、6.5 天）",
    );

    // Without a day asked for: the latest one most posts have reached.
    expect(defaultCheckpoint(entries)).toBe("7d");
    const young = emptyReview("w3", "冬天");
    applyOperations(young, [
      postOperation.parse({ op: "post", platform: "抖音", postedAt: posted }),
      snapshotOperation.parse({ op: "snapshot", post: "p1", at: day(1.1), metrics: { views: 300 } }),
    ]);
    expect(defaultCheckpoint([entries[0], { repo: "local", review: young, work: {} }])).toBe("1d");
    expect(defaultCheckpoint([entries[1], { repo: "local", review: young, work: {} }])).toBe("latest");
  });

  it("measures leaving against similar videos, per second and per segment", () => {
    const mine = retention.map((value, second) => [second, value / 100]);
    const theirs = similar.map((value, second) => [second, value / 100]);
    const analysis = retentionAnalysis({
      retention: mine,
      benchmark: theirs,
      duration: 15,
      segments: [
        { kind: "镜头", start: 0, end: 6, label: "开场" },
        { kind: "镜头", start: 6, end: 8, label: "转折" },
        { kind: "镜头", start: 8, end: 15, label: "结尾" },
      ],
      moments: [{ label: "反转", at: 7 }],
    });
    // 6→7 s: 46 % → 30 % is a churn of 34.8 %, similar videos lose 4 %: × 8.7.
    expect(analysis.peaks[0]).toMatchObject({ t: 6, multiplier: 8.7, labels: { 镜头: "转折" } });
    expect(analysis.peaks[0].around).toEqual([1.3, 1.41, 2.4, 1.7]);
    const turn = analysis.segments["镜头"][1];
    // 46 % → 27 % loses 41.3 %, similar videos 50 % → 46 % lose 8 %.
    expect(turn).toMatchObject({ label: "转折", multiplier: 5.16 });
    // Had it lost people like similar videos, everyone after it would be that many more.
    expect(turn.gain).toBeCloseTo((0.46 * (0.46 / 0.5)) / 0.27 - 1, 3);
    expect(analysis.moments[0]).toMatchObject({ label: "反转", kept: 0.3, keptBenchmark: 0.48 });
    expect(analysis.keptVsBenchmark).toBe(0.49);
  });

  it("reads hourly views into totals by age, by day and in waves", () => {
    const value = emptyReview("w");
    applyOperations(value, [
      postOperation.parse({ op: "post", platform: "抖音", postedAt: "2026-10-07T15:00:00Z" }),
      seriesOperation.parse({ op: "series", post: "p1", key: "views", start: "2026-10-07T15:00:00Z", values: hourly }),
      seriesOperation.parse({ op: "series", post: "p1", key: "views:抖音精选", start: "2026-10-07T15:00:00Z", values: hourly.map(() => 1) }),
    ]);
    const flow = flowAnalysis(value, value.posts[0]);
    expect(flow.firstHours).toEqual([{ hours: 24, views: 17 * 10 + 7 * 400 }]);
    expect(flow.daily.map((item) => item.date)).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(flow.waves).toHaveLength(1);
    expect(flow.waves[0]).toMatchObject({ views: 7 * 400, peak: { views: 400 } });
    expect(flow.channels).toEqual([{ name: "抖音精选", views: 30, share: 30 / flow.total }]);
  });

  it("takes segments from the work: layers, shots and lyrics of a cut song", async () => {
    expect(parseLrc("[ar:x]\n[00:01.00]one\n[00:03.50][00:09.00]two\n[00:05]")).toEqual([
      { time: 1, text: "one" },
      { time: 3.5, text: "two" },
      { time: 9, text: "two" },
    ]);
    const files = {
      "visual.json": JSON.stringify({
        clips: [
          { id: "a", name: "第一幕", start: 0, duration: 6 },
          { id: "lyrics", start: 0, duration: 15 },
        ],
      }),
      "audio.json": JSON.stringify({
        sources: [{ id: "song", kind: "file", src: "films/work-x/music/song.flac" }],
        // The song from 0 s, then cut to its 8th second at 5 s; a muffled copy on another track.
        clips: [
          { id: "c1", track: "music", source: "song", start: 0, duration: 5, offset: 0 },
          { id: "c2", track: "music", source: "song", start: 5, duration: 10, offset: 8 },
          { id: "c3", track: "muffled", source: "song", start: 4, duration: 1, offset: 4 },
        ],
      }),
      "public/music/song.lrc": "[00:01.00]one\n[00:03.50]two\n[00:07.00]three\n[00:09.00]four",
    };
    const segments = await workSegments({
      meta: {
        duration: 15,
        beats: [
          { at: 0, title: "开场" },
          { at: 6, title: "转折" },
        ],
      },
      read: async (file) => files[file] ?? null,
    });
    expect(segments.filter((item) => item.kind === "图层")).toEqual([{ kind: "图层", start: 0, end: 6, label: "第一幕" }]);
    expect(segments.filter((item) => item.kind === "镜头").map((item) => [item.start, item.end, item.label])).toEqual([
      [0, 6, "开场"],
      [6, 15, "转折"],
    ]);
    expect(segments.filter((item) => item.kind === "歌词").map((item) => [item.start, item.end, item.label, item.songTime])).toEqual([
      [1, 3.5, "one", 1],
      [3.5, 5, "two", 3.5],
      [5, 6, "three", 7],
      [6, 11, "four", 9],
    ]);
    // Two works with the same song, line by line.
    const row = (work, multipliers) => ({
      work,
      post: "p1",
      title: work,
      platform: "抖音",
      lyrics: multipliers.map(([songTime, label, multiplier]) => ({ songTime, label, multiplier })),
    });
    const table = lyricsText([
      row("原版", [
        [1, "one", 1.2],
        [9, "four", 3.3],
      ]),
      row("另一首歌", [[2, "other", 2.1]]),
      row("重置版", [[9, "four", 3.47]]),
    ]);
    expect(table).toContain("| 歌曲时间 | 歌词 | 原版·抖音 | 重置版·抖音 |");
    expect(table).toContain("| 9 | four | ×3.3 | ×3.47 |");
    expect(table).not.toContain("| one |");
    expect(table).not.toContain("另一首歌");
  });
});

describe("one export at a time", () => {
  it("reads a file uploaded twice once and tells two exports apart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-douyin-"));
    const put = (name, data) => {
      fs.writeFileSync(path.join(dir, name), data);
      return { path: `raw/2026-10-09/${name}`, file: path.join(dir, name) };
    };
    const one = Object.entries(exports).map(([name, data]) => put(name, data));
    const again = readExports([...one, put("流量数据-2.xlsx", exports["流量数据.xlsx"])]);
    expect(again.conflicts).toEqual([]);
    expect(again.duplicates).toEqual([{ path: "raw/2026-10-09/流量数据-2.xlsx", of: "raw/2026-10-09/流量数据.xlsx" }]);
    expect(again.recognized.find((item) => item.path === "raw/2026-10-09/流量数据.xlsx").until).toBe("2026-10-08T20:00:00.000Z");
    // The next day's export in the same folder: other numbers, the same parts.
    const later = put(
      "流量数据-3.xlsx",
      workbook({
        指标数据: [
          ["播放量", "点赞量"],
          ["9000", "600"],
        ],
        "播放量-新增-每小时趋势数据": [
          ["日期", "播放量"],
          [time(40), "50"],
        ],
      }),
    );
    expect(readExports([...one, later]).conflicts).toEqual([
      "views 在 raw/2026-10-09/流量数据.xlsx 是 5000，在 raw/2026-10-09/流量数据-3.xlsx 是 9000",
      "likes 在 raw/2026-10-09/流量数据.xlsx 是 350，在 raw/2026-10-09/流量数据-3.xlsx 是 600",
      "raw/2026-10-09/流量数据.xlsx 和 raw/2026-10-09/流量数据-3.xlsx 都有每小时 views",
    ]);
  });
});

describe("reviews in the studio and for the AI", () => {
  let app, base;
  const call = async (route, { method = "GET", body, raw } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: body ? { "Content-Type": "application/json" } : raw ? { "Content-Type": "application/octet-stream" } : {},
      body: body ? JSON.stringify(body) : raw,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const tool = (name, args) => call(`/api/tools/${name}`, { method: "POST", body: args });
  const branches = async () => (await git(app.services.repos.dir("local"), ["branch", "--list", "frame/reviews"])).trim();

  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-reviews-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
  });
  afterAll(() => app.close());

  it("records posts, numbers and documents for a published work, each change a version", async () => {
    const work = (await call("/api/works", { method: "POST", body: { title: "夏日海报", duration: 15 } })).body;
    await call(`/api/works/local/${work.id}`, {
      method: "PATCH",
      body: {
        beats: [
          { at: 0, title: "开场", detail: "" },
          { at: 6, title: "产品特写", detail: "" },
        ],
        tags: ["促销"],
      },
    });
    expect((await call(`/api/works/local/${work.id}/publish`, { method: "POST" })).status).toBe(200);
    // Reading, also the versions, creates nothing: there is no reviews branch yet.
    expect((await tool("review_read", { work: work.id })).body.text).toContain("还没有发布记录");
    expect((await call("/api/repos/local/reviews/history")).body).toEqual([]);
    expect((await call("/api/repos/local/reviews/status")).body.files).toEqual([]);
    expect((await call("/api/repos/local/reviews/remote")).body).toEqual({ state: "unknown" });
    expect(await branches()).toBe("");

    const csv = Buffer.from("﻿日期,播放量,点赞\n2026-10-15,12034,830\n");
    const uploaded = await call(`/api/repos/local/reviews/works/${work.id}/upload?name=${encodeURIComponent("抖音 近7天.csv")}`, { method: "POST", raw: csv });
    expect(uploaded.body).toEqual({ path: "raw/抖音 近7天.csv", size: csv.length, sha256: createHash("sha256").update(csv).digest("hex") });
    expect((await tool("review_read", { work: work.id, file: "raw/抖音 近7天.csv" })).body.text).toContain("2026-10-15,12034,830");

    const written = await tool("review_write", {
      work: work.id,
      operations: [
        { op: "post", platform: "抖音", postedAt: "2026-10-08T20:00:00+08:00", url: "https://v.douyin.com/x" },
        {
          op: "snapshot",
          post: "p1",
          at: "2026-10-15T20:00:00+08:00",
          source: "raw/抖音 近7天.csv",
          metrics: { views: 12034, likes: 830, completionRate: 0.31 },
          retention: [
            [0, 1],
            [3, 0.62],
            [6, 0.55],
            [7, 0.38],
            [15, 0.3],
          ],
        },
        { op: "write", path: "复盘.md", content: "# 夏日海报复盘\n\n开场太慢。\n" },
        { op: "write", path: "raw/改.md", content: "x" },
      ],
    });
    expect(written.status).toBe(200);
    expect(written.body.data.results.map((result) => result.status)).toEqual(["ok", "ok", "ok", "failed"]);
    expect(written.body.text).toContain("原始文件保持原样");

    const read = await tool("review_read", { work: work.id });
    expect(read.body.text).toContain("p1 抖音「夏日海报」2026-10-08 20:00（北京时间）发布");
    expect(read.body.text).toContain("播放 1.2 万｜点赞 830（6.9%）");
    expect(read.body.text).toContain("开头 3 秒还在 62%");
    expect(read.body.text).toContain("（镜头「产品特写」）");
    expect(read.body.text).toContain("raw/抖音 近7天.csv（已录入）");
    expect(read.body.text).toContain("复盘.md（夏日海报复盘）");

    // Autosaved: one version per change, on the reviews branch, not the work's.
    const history = (await call("/api/repos/local/reviews/history")).body.map((version) => version.message);
    expect(history).toEqual([
      "复盘「夏日海报」：新增发布记录 p1（抖音）；抖音 发布后 7 天的数据；复盘文档 复盘.md",
      "复盘「夏日海报」：上传原始文件 抖音 近7天.csv",
      "创建复盘分支",
    ]);
    expect((await call("/api/repos/local/reviews/status")).body.files).toEqual([]);

    // The editor saves documents the same way.
    const doc = await call(`/api/repos/local/reviews/file?path=${encodeURIComponent(`${work.id}/复盘.md`)}`);
    expect(
      (
        await call("/api/repos/local/reviews/file", {
          method: "PUT",
          body: { path: `${work.id}/复盘.md`, content: doc.body.content + "\n结尾留存不错。\n", expectedHash: doc.body.hash },
        })
      ).status,
    ).toBe(200);
    expect((await call("/api/repos/local/reviews/history")).body[0].message).toBe("复盘「夏日海报」：编辑 复盘.md");
    expect((await call("/api/repos/local/reviews/file", { method: "PUT", body: { path: `${work.id}/review.json`, content: "{}" } })).status).toBe(400);

    // The studio's view of it, and the AI's other places.
    const detail = (await call(`/api/repos/local/reviews/works/${work.id}`)).body;
    expect(detail.summary.p1.metrics).toMatchObject({ views: 12034, likeRate: 830 / 12034 });
    expect(detail.analyses.p1.retention.opening.lost).toBe(0.38);
    expect(detail.segments.map((segment) => segment.label)).toEqual(["开场", "产品特写"]);
    expect((await tool("work_context", { work: work.id })).body.data.reviews.posts[0]).toMatchObject({ id: "p1", platform: "抖音" });
    const opened = await app.services.openWork(work.id, "local");
    expect(fs.readFileSync(path.join(opened.root, "AGENTS.md"), "utf8")).toContain("这个作品已经发布到抖音，记录了 1 次数据");
    expect((await tool("search", { work: work.id, pattern: "开场太慢", scope: ["reviews"] })).body.text).toContain(`复盘 ${work.id}/复盘.md`);

    // Compared with another work of the same kind at the same age.
    const other = (await call("/api/works", { method: "POST", body: { title: "秋日海报", duration: 20 } })).body;
    await call(`/api/works/local/${other.id}`, { method: "PATCH", body: { tags: ["促销"] } });
    await tool("review_write", {
      work: other.id,
      operations: [
        { op: "post", platform: "抖音", postedAt: "2026-09-01T20:00:00+08:00" },
        { op: "snapshot", post: "p1", at: "2026-09-08T12:00:00+08:00", metrics: { views: 6000, likes: 300 } },
        { op: "snapshot", post: "p1", at: "2026-10-01T12:00:00+08:00", metrics: { views: 9000, likes: 420 } },
      ],
    });
    const compared = await tool("reviews_compare", { work: work.id, tags: ["促销"], columns: ["views", "likeRate"] });
    expect(compared.body.text).toContain(`| ▶ 夏日海报 ${work.id} | 抖音 | 2026-10-08 20:00 | 12,034 | 6.9% |`);
    expect(compared.body.text).toContain(`| 秋日海报 ${other.id} | 抖音 | 2026-09-01 20:00 | 6,000 | 5% |`);
    expect(compared.body.text).toContain("本作品（抖音）：播放 12,034，是中位数的 1.33 倍");
    expect((await tool("reviews_compare", { work: work.id, tags: ["别的"] })).body.text).toContain("没有符合条件的发布记录");
    const latestRows = (await call("/api/reviews/compare?checkpoint=latest&curves=1")).body.rows;
    expect(latestRows.find((row) => row.work === other.id).metrics.views).toBe(9000);
    expect(latestRows.find((row) => row.work === work.id).curve).toHaveLength(51);
  });

  it("imports a Douyin export: retention against similar videos, hourly views, sources, comments", async () => {
    const work = (await call("/api/works", { method: "POST", body: { title: "生日", duration: 15 } })).body;
    await call(`/api/works/local/${work.id}`, {
      method: "PATCH",
      body: {
        beats: [
          { at: 0, title: "开场", detail: "" },
          { at: 6, title: "转折", detail: "" },
          { at: 8, title: "结尾", detail: "" },
        ],
      },
    });
    for (const [name, data] of Object.entries(exports))
      expect(
        (
          await call(`/api/repos/local/reviews/works/${work.id}/upload?name=${encodeURIComponent(name)}&folder=2026-10-09`, {
            method: "POST",
            raw: Buffer.from(data),
          })
        ).body.path,
      ).toBe(`raw/2026-10-09/${name}`);
    const preview = await tool("review_import", { work: work.id, folder: "raw/2026-10-09", dryRun: true });
    expect(preview.body.text).toContain("会导入抖音的数据到 新的发布记录（发布时间 2026-10-07 23:00，统计到 2026-10-09 04:00，北京时间）");
    expect(preview.body.text).toContain("- raw/2026-10-09/全部评论.xlsx：全部评论");
    expect(await tool("review_import", { work: work.id, folder: "raw/2026-10-09" })).toMatchObject({ status: 200 });
    await tool("review_write", {
      work: work.id,
      operations: [
        { op: "moment", label: "反转", at: 7 },
        { op: "post", id: "p1", goals: { views: 10000 } },
      ],
    });

    const text = (await tool("review_read", { work: work.id })).body.text;
    expect(text).toContain("p1 抖音「17岁生日 #生日 #s0rrow」2026-10-07 23 点多（北京时间，按每小时数据估计）发布");
    expect(text).toContain("最新数据（统计到 2026-10-09 04:00，发布后 29 小时，来自 raw/2026-10-09/ 的 5 个文件）");
    expect(text).toContain("6–7 秒 ×8.7（1.3 1.41 | 2.4 1.7） 镜头「转折」");
    expect(text).toContain("看这几秒的画面：preview_frames 的 times 用 [6.5, 8.5, 10.5, 12.5, 14.5]");
    expect(text).not.toContain("注意：作品在这次发布之后改过");
    expect(text).toContain("2 秒跳出 30.79%（同类 29%）");
    expect(text).toContain("5 秒留存 46.46%（同类 53%）");
    expect(text).toContain("目标：播放 1 万（完成 50%）");
    expect(text).toContain("首 24 小时 2,970");
    expect(text).toContain("几波：10-08 16:00–23:00 共 2,800（最高 16:00 400）");
    expect(text).toContain("抖音精选 30");
    expect(text).toContain("推荐页 89.8%（92.2%）｜个人主页 5.9%（4.4%）");
    expect(text).toContain("反转（7 秒）还在 30%（同类 48%）");
    expect(text).toContain("6–7 秒 ×8.7");
    expect(text).toContain("按镜头（流失率 ÷ 同类）：0–6 秒 开场");
    expect(text).toContain("6–8 秒 转折 ×5.16（按同类走结尾多 56.7%）");
    expect(text).toContain("评论导出：一级评论 2 条、回复 1 条；赞最多：「开飞行模式干嘛」（9 赞）");
    expect(text).toContain("raw/2026-10-09/流量数据.xlsx（已录入）");

    // The same files again: nothing changes, and the folder can be named without raw/.
    expect((await tool("review_import", { work: work.id, folder: "2026-10-09" })).body.text).toContain(
      "这些文件之前已经导入过（p1 统计到 2026-10-09 04:00 的数据），这次没有变化。",
    );
    // A file uploaded again is the one already there; importing it alone keeps the rest of its export.
    const twice = await call(`/api/repos/local/reviews/works/${work.id}/upload?name=${encodeURIComponent("流量数据.xlsx")}&folder=2026-10-09`, {
      method: "POST",
      raw: Buffer.from(exports["流量数据.xlsx"]),
    });
    expect(twice.body).toMatchObject({ path: "raw/2026-10-09/流量数据.xlsx", duplicate: true });
    expect((await tool("review_import", { work: work.id, files: ["2026-10-09/流量数据.xlsx"] })).body.text).toContain("这次没有变化");
    expect((await tool("review_read", { work: work.id })).body.text).toContain("反转（7 秒）还在 30%（同类 48%）");
    // The next export dropped into the same folder is not mixed in.
    await call(`/api/repos/local/reviews/works/${work.id}/upload?name=${encodeURIComponent("流量数据.xlsx")}&folder=2026-10-09`, {
      method: "POST",
      raw: Buffer.from(
        workbook({
          指标数据: [
            ["播放量", "点赞量"],
            ["9000", "600"],
          ],
        }),
      ),
    });
    const mixed = await tool("review_import", { work: work.id, folder: "raw/2026-10-09" });
    expect(mixed.status).toBe(409);
    expect(mixed.body.error.message).toContain(
      "这些文件不是同一次导出的（views 在 raw/2026-10-09/流量数据-2.xlsx 是 9000，在 raw/2026-10-09/流量数据.xlsx 是 5000",
    );
    expect(mixed.body.error.message).toContain("- raw/2026-10-09/流量数据.xlsx：指标、每小时播放（分渠道），每小时数据到 2026-10-09 04:00");

    // Numbers by the names people use; times only with their zone.
    const named = await tool("review_write", {
      work: work.id,
      operations: [{ op: "snapshot", post: "p1", at: "2026-10-10T12:00:00+08:00", metrics: { 播放量: 9000, 点赞: 600, "2s跳出率": 0.3 } }],
    });
    expect(named.body.text).toContain("✓ 1. snapshot（播放量 记为 views、点赞 记为 likes、2s跳出率 记为 bounce2s）");
    const zoneless = await tool("review_write", {
      work: work.id,
      operations: [{ op: "snapshot", post: "p1", at: "2026-10-10 13:00", metrics: { views: 9100 } }],
    });
    expect(zoneless.body.error.message).toContain("时间要写到分钟并带时区，例如 2026-10-08T20:00:00+08:00（北京时间）");
    const history = (await tool("review_read", { work: work.id })).body.text;
    expect(history).toContain("历次数据（共 2 次）：");
    expect(history).toContain("| 2026-10-10 12:00 | 2.5 天 | 9,000 | 6.67% |");

    // A stretch second by second, with what is on screen when it changes.
    const seconds = (await tool("review_read", { work: work.id, seconds: [5, 9] })).body.text;
    expect(seconds).toContain("5–9 秒：开始时还在 50%（同类 53%），这段走掉 50%（同类 16.98%），是同类的 ×2.94；这段按同类的流失率走，看到结尾的人多 66.04%");
    expect(seconds).toContain("| 5 | 50% | 53% | 8% | 5.66% | ×1.41 | 镜头「开场」 |");
    expect(seconds).toContain("| 6 | 46% | 50% | 34.78% | 4% | ×8.7 | 镜头「转折」 |");
    expect(seconds).toContain("| 7 | 30% | 48% | 10% | 4.17% | ×2.4 | ◆反转 7 秒 |");
    expect((await tool("review_read", { work: work.id, seconds: [20, 30] })).body.error.message).toContain("视频只有 15 秒");

    // A version saved after posting that changes the picture: frames are not what viewers saw.
    await call(`/api/works/local/${work.id}`, { method: "PATCH", body: { beats: [{ at: 0, title: "新开场", detail: "" }] } });
    await tool("version_save", { work: work.id, message: "改开场" });
    expect((await tool("review_read", { work: work.id })).body.text).toContain("注意：作品在这次发布之后改过");

    // At day 1 the hourly data gives exact views, though the only snapshot is at 29 hours.
    const day1 = await tool("reviews_compare", { work: work.id, checkpoint: "1d", works: [work.id] });
    expect(day1.body.text).toContain("| 2,970* |");
    const day2 = (await call("/api/reviews/compare?checkpoint=2d")).body;
    expect(day2.columns).toContain("moment:反转");
  });

  it("takes original files from an outside AI's computer and forgets a deleted work", async () => {
    const work = (await call("/api/works", { method: "POST", body: { title: "临时作品" } })).body;
    const link = await tool("upload_link", {
      work: work.id,
      files: [{ from: "/Users/me/Downloads/后台截图.png", review: true, path: "raw/2026-10-10/后台截图.png" }],
    });
    expect(link.body.text).toContain("复盘资料的 raw/2026-10-10/后台截图.png");
    expect(link.body.text).toContain("用 review_import 的 folder 导入：raw/2026-10-10");
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const later = await tool("upload_link", {
      work: work.id,
      files: [
        { from: "/Users/me/Downloads/流量数据.xlsx", review: true },
        { from: "/Users/me/Downloads/粉丝数据.xlsx", review: true, path: "2026-10-12/粉丝数据.xlsx" },
      ],
    });
    expect(later.body.text).toContain(`复盘资料的 raw/${today}/流量数据.xlsx`);
    expect(later.body.text).toContain("复盘资料的 raw/2026-10-12/粉丝数据.xlsx");
    const png = await (
      await import("sharp")
    )
      .default({ create: { width: 40, height: 30, channels: 3, background: "#336699" } })
      .png()
      .toBuffer();
    const put = await fetch(link.body.data.uploads[0].url, { method: "PUT", body: png });
    expect(await put.json()).toMatchObject({ ok: true, path: "raw/2026-10-10/后台截图.png", sha256: createHash("sha256").update(png).digest("hex") });
    const image = await tool("review_read", { work: work.id, file: "raw/2026-10-10/后台截图.png" });
    expect(image.body.images[0].mimeType).toBe("image/jpeg");

    const dir = path.join(app.services.config.dirs.reviews, "local", work.id);
    expect(fs.existsSync(dir)).toBe(true);
    await call(`/api/works/local/${work.id}`, { method: "DELETE" });
    expect((await call(`/api/trash/local/${work.id}`, { method: "DELETE" })).status).toBe(200);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await call("/api/repos/local/reviews/history")).body[0].message).toBe("删除复盘：临时作品（作品已永久删除）");
  });
});
