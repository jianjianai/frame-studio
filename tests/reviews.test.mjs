import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  compareText,
  derive,
  emptyReview,
  formatReview,
  parseReview,
  retentionStats,
  snapshotOperation,
  postOperation,
} from "../server/review-data.mjs";

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
      postOperation.parse({ op: "post", id: "p1", url: "https://example.com/v/1" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["ok", "failed", "failed", "failed", "ok"]);
    expect(results[1].message).toContain("写 0–1");
    expect(results[2].message).toContain("时区");
    expect(results[3].message).toContain("没有发布记录 p9");
    expect(value.snapshots[1]).toMatchObject({ metrics: { views: 5000, likes: 300, completionRate: 0.3, comments: 12 }, source: "raw/a.xlsx" });
    expect(value.posts[0].url).toBe("https://example.com/v/1");
    // The file keeps a retention point per line and reads back the same.
    value.snapshots[1].retention = [
      [0, 1],
      [3, 0.6],
    ];
    const text = formatReview(value);
    expect(text).toContain("[0, 1],\n");
    expect(parseReview(text, "w1")).toEqual(value);
    expect(parseReview("{broken", "w1")).toEqual(emptyReview("w1"));
  });

  it("compares at the same age, with rates per view", () => {
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
    // A metric only an earlier snapshot has keeps that snapshot's rate and time.
    applyOperations(value, [snapshotOperation.parse({ op: "snapshot", post: "p1", at: day(8), metrics: { views: 6000 } })]);
    const newest = atCheckpoint(value, value.posts[0], "latest");
    expect(newest.metrics).toMatchObject({ views: 6000, likes: 300, likeRate: 0.06 });
    expect(newest.from).toMatchObject({ views: day(8), likes: day(6.5) });
    expect(derive({ views: 1000, likes: 50, comments: 10, avgWatchTime: 6 }, { duration: 12 })).toMatchObject({
      likeRate: 0.05,
      commentRate: 0.01,
      engagementRate: 0.06,
      watchRatio: 0.5,
    });

    const other = emptyReview("w2", "秋天");
    applyOperations(other, [
      postOperation.parse({ op: "post", platform: "抖音", postedAt: posted }),
      snapshotOperation.parse({ op: "snapshot", post: "p1", at: day(7.2), metrics: { views: 2000, likes: 200 } }),
    ]);
    const rows = compareRows(
      [
        { repo: "local", review: value, work: { title: "夏日", duration: 15, width: 1080, height: 1920 } },
        { repo: "local", review: other, work: { title: "秋天", duration: 20, width: 1920, height: 1080 } },
      ],
      { checkpoint: "7d" },
    );
    expect(rows.map((row) => [row.title, row.shape, row.metrics.views, row.metrics.likeRate])).toEqual([
      ["夏日", "竖屏", 5000, 0.06],
      ["秋天", "横屏", 2000, 0.1],
    ]);
    const text = compareText(rows, { checkpoint: "7d", columns: ["views", "likeRate"], current: "w1" });
    expect(text).toContain("| ▶ 夏日 w1 | 抖音 | 2026-10-01 | 5,000 | 6% |");
    expect(text).toContain("中位数（2 条）：播放 3,500｜点赞率 8%");
    expect(text).toContain("本作品（抖音）：播放 5,000，是中位数的 1.43 倍");
  });

  it("finds where viewers leave and names the shot and subtitle there", () => {
    const curve = [
      [0, 1],
      [3, 0.7],
      [6, 0.65],
      [7, 0.45],
      [12, 0.4],
      [13, 0.48],
      [20, 0.3],
    ];
    const stats = retentionStats(curve, 20, {
      beats: [
        { at: 0, title: "开场" },
        { at: 6, title: "产品特写" },
      ],
      subtitles: [{ start: 5.5, end: 8, text: "看这里" }],
    });
    expect(stats.opening).toEqual({ seconds: 3, kept: 0.7, lost: 0.3 });
    expect(stats.drops[0]).toMatchObject({ shot: { at: 6, title: "产品特写" }, subtitle: "看这里" });
    expect(stats.drops[0].start).toBeGreaterThanOrEqual(5.4);
    expect(stats.drops[0].start).toBeLessThanOrEqual(6.1);
    expect(stats.rises[0].start).toBeGreaterThan(11);
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
    // Reading creates nothing: there is no reviews branch yet.
    expect((await tool("review_read", { work: work.id })).body.text).toContain("还没有发布记录");
    expect((await git(app.services.repos.dir("local"), ["branch", "--list", "frame/reviews"])).trim()).toBe("");

    const uploaded = await call(`/api/repos/local/reviews/works/${work.id}/upload?name=${encodeURIComponent("抖音 近7天.csv")}`, {
      method: "POST",
      raw: Buffer.from("﻿日期,播放量,点赞\n2026-10-15,12034,830\n"),
    });
    expect(uploaded.body).toEqual({ path: "raw/抖音 近7天.csv", size: expect.any(Number) });
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
    expect(read.body.text).toContain("p1 抖音「夏日海报」2026-10-08 发布");
    expect(read.body.text).toContain("播放 12,034｜点赞 830（6.9%）");
    expect(read.body.text).toContain("开头 3 秒流失 38%");
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
    expect(detail.analyses.p1.opening.lost).toBe(0.38);
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
    expect(compared.body.text).toContain(`| ▶ 夏日海报 ${work.id} | 抖音 | 2026-10-08 | 12,034 | 6.9% |`);
    expect(compared.body.text).toContain(`| 秋日海报 ${other.id} | 抖音 | 2026-09-01 | 6,000 | 5% |`);
    expect(compared.body.text).toContain("本作品（抖音）：播放 12,034，是中位数的 1.33 倍");
    expect((await tool("reviews_compare", { work: work.id, tags: ["别的"] })).body.text).toContain("没有符合条件的发布记录");
    const latestRows = (await call("/api/reviews/compare?checkpoint=latest&curves=1")).body.rows;
    expect(latestRows.find((row) => row.work === other.id).metrics.views).toBe(9000);
    expect(latestRows.find((row) => row.work === work.id).curve).toHaveLength(51);
  });

  it("takes original files from an outside AI's computer and forgets a deleted work", async () => {
    const work = (await call("/api/works", { method: "POST", body: { title: "临时作品" } })).body;
    const link = await tool("upload_link", { work: work.id, files: [{ from: "/Users/me/Downloads/后台截图.png", review: true }] });
    expect(link.body.text).toContain("复盘资料的 raw/后台截图.png");
    const png = await (
      await import("sharp")
    )
      .default({ create: { width: 40, height: 30, channels: 3, background: "#336699" } })
      .png()
      .toBuffer();
    const put = await fetch(link.body.data.uploads[0].url, { method: "PUT", body: png });
    expect(await put.json()).toMatchObject({ ok: true, path: "raw/后台截图.png" });
    const image = await tool("review_read", { work: work.id, file: "raw/后台截图.png" });
    expect(image.body.images[0].mimeType).toBe("image/jpeg");

    const dir = path.join(app.services.config.dirs.reviews, "local", work.id);
    expect(fs.existsSync(dir)).toBe(true);
    await call(`/api/works/local/${work.id}`, { method: "DELETE" });
    expect((await call(`/api/trash/local/${work.id}`, { method: "DELETE" })).status).toBe(200);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await call("/api/repos/local/reviews/history")).body[0].message).toBe("删除复盘：临时作品（作品已永久删除）");
  });
});
