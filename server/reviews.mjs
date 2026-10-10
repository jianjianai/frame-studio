import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import sharp from "sharp";
import { git } from "./git.mjs";
import { tree, readText, writeText, writeStream, removePath, uniquePath } from "./files.mjs";
import { readJson, sendFile } from "./http.mjs";
import { problem, notFound, confined, writeFileAtomic, mediaKind } from "./util.mjs";
import { GIT_ATTRIBUTES } from "./templates.mjs";
import { workArg, describeIssues } from "./tools/registry.mjs";
import { editList, runFileOperations } from "./tools/file-ops.mjs";
import { readTable, tableText, TABLE_FILE } from "./sheets.mjs";
import {
  METRICS,
  DERIVED,
  PLATFORMS,
  CHECKPOINTS,
  DEFAULT_COLUMNS,
  DATA_OPERATIONS,
  emptyReview,
  parseReview,
  formatReview,
  applyOperations,
  postOperation,
  snapshotOperation,
  removePostOperation,
  removeSnapshotOperation,
  latest,
  snapshotsOf,
  derive,
  retentionStats,
  reviewText,
  compareRows,
  compareText,
  formatPercent,
  ageLabel,
  ageDays,
} from "./review-data.mjs";

/**
 * Reviews of posted videos: for each work, where it was posted, the platforms' numbers over
 * time, the original files they came from (spreadsheets and screenshots from the creator
 * centers) and review documents. They live on the repository's `frame/reviews` branch
 * (checked out at <home>/reviews/<repo>/), one folder per work id, outside the work's own
 * branch: a published work stays view-only while its numbers keep coming in, and all works
 * of a repository are compared from one folder. Every change is saved as a version at once.
 */
export const REVIEWS_BRANCH = "frame/reviews";
const DATA_FILE = "review.json";
const RAW = "raw";
const RAW_LIMIT = 512 * 1024 * 1024;
const ROOT_README = `# FRAME 复盘

每个文件夹是一个作品（文件夹名是作品 id）发布后的复盘资料，在 FRAME Studio 的「复盘」中查看和对比：

- \`review.json\`：发到了哪些平台、各次统计的数据和观众留存曲线
- \`raw/\`：平台后台导出的表格、截图等原始文件，原样保存
- 其他 \`.md\`：复盘文档
`;
const validWorkId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
const isDocument = (file) => /\.(md|txt)$/i.test(file) && !file.startsWith(`${RAW}/`);
const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
/** A file name people chose, safe as one path segment. */
const cleanName = (name) =>
  String(name || "")
    .replace(/[\\/\x00-\x1f?#%*:|"<>]+/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(-120) || "file";
const docTitle = (folder, file) => {
  try {
    return /^#\s+(.+)$/m.exec(fs.readFileSync(path.join(folder, file), "utf8"))?.[1].trim() ?? "";
  } catch {
    return "";
  }
};

export class Reviews {
  constructor(services) {
    this.services = services;
  }

  /** The reviews worktree of a repository, created (or checked out from GitHub) on first use. */
  dir(repo) {
    return this.services.repos.branchWorktree(repo, {
      branch: REVIEWS_BRANCH,
      dir: path.join(this.services.config.dirs.reviews, repo),
      files: { "README.md": ROOT_README, ".gitattributes": GIT_ATTRIBUTES },
      message: "创建复盘分支",
    });
  }
  /** The worktree when the repository has reviews, without starting the branch (reading creates nothing). */
  async existing(repo) {
    this.services.repos.get(repo); // a known repository, not a path
    const dir = this.existingSync(repo);
    if (dir) return dir;
    return (await this.services.repos.hasBranch(repo, REVIEWS_BRANCH)) ? this.dir(repo) : null;
  }
  existingSync(repo) {
    const dir = path.join(this.services.config.dirs.reviews, repo);
    return fs.existsSync(path.join(dir, ".git")) ? dir : null;
  }
  /** A work-like handle, so the works' version functions (history, push, pull…) apply. */
  async scope(repo) {
    const root = await this.dir(repo);
    return { id: `reviews-${repo}`, repo, root, dir: root, branch: REVIEWS_BRANCH };
  }

  /** A work's review folder as it is: the data, the documents and the original files. */
  readFrom(dir, id) {
    const folder = path.join(dir, id);
    const file = path.join(folder, DATA_FILE);
    const review = fs.existsSync(file) ? parseReview(fs.readFileSync(file, "utf8"), id) : emptyReview(id);
    const entries = fs.existsSync(folder) ? tree(folder).filter((entry) => entry.type === "file") : [];
    const sources = review.snapshots.map((snapshot) => snapshot.source ?? "").join("\n");
    return {
      review,
      files: entries
        .filter((entry) => entry.path.startsWith(`${RAW}/`))
        .map((entry) => ({
          path: entry.path,
          size: entry.size,
          kind: TABLE_FILE.test(entry.path) ? "table" : mediaKind(entry.path),
          used: sources.includes(entry.path),
        })),
      documents: entries.filter((entry) => isDocument(entry.path)).map((entry) => ({ path: entry.path, title: docTitle(folder, entry.path) })),
    };
  }
  async read(work) {
    const dir = await this.existing(work.repo);
    return dir ? this.readFrom(dir, work.id) : { review: emptyReview(work.id), files: [], documents: [] };
  }

  /**
   * Everything the studio shows of a work's review: also per post the newest numbers, every
   * snapshot with the derived rates (charts) and the retention analysis.
   */
  async detail(work) {
    const { review, files, documents } = await this.read(work);
    const meta = this.services.works.meta(work).meta ?? {};
    const summary = {};
    const history = {};
    const analyses = {};
    for (const post of review.posts) {
      const duration = post.duration ?? meta.duration;
      const now = latest(review, post, { duration });
      if (!now) continue;
      const ages = Object.fromEntries(Object.entries(now.from).map(([key, at]) => [key, ageDays(post, at)]));
      summary[post.id] = { at: now.at, age: ageDays(post, now.at), metrics: now.metrics, ages };
      history[post.id] = snapshotsOf(review, post).map((snapshot) => ({
        at: snapshot.at,
        age: ageDays(post, snapshot.at),
        metrics: derive(snapshot.metrics, { duration, retention: snapshot.retention }),
      }));
      if (now.retention?.length) analyses[post.id] = retentionStats(now.retention, duration, { beats: meta.beats, subtitles: meta.subtitles });
    }
    return { review: { ...review, title: meta.title ?? review.title }, files, documents, summary, history, analyses, definitions: DEFINITIONS };
  }

  /**
   * Change a work's review folder and save it as a version at once. `change({ folder, title })`
   * returns { message, result }; no message, no version. Serialized with the branch's other
   * version operations (pull, revert, merges).
   */
  async save(work, change) {
    const { works, events } = this.services;
    const dir = await this.dir(work.repo);
    const folder = path.join(dir, work.id);
    const title = works.meta(work).meta?.title || work.id;
    const scope = await this.scope(work.repo);
    return works.locks.run(`${scope.repo}/${scope.id}`, async () => {
      const { message, result } = await change({ folder, title });
      // The folder names its work (by id); review.json keeps the title for people browsing the branch and after the work is gone.
      const file = path.join(folder, DATA_FILE);
      if (message && fs.existsSync(folder)) {
        const review = fs.existsSync(file) ? parseReview(fs.readFileSync(file, "utf8"), work.id) : emptyReview(work.id);
        if (review.title !== title || !fs.existsSync(file)) writeFileAtomic(file, formatReview({ ...review, title }));
      }
      const tracked = (await git(dir, ["ls-files", "--", work.id])).trim();
      let saved = false;
      if (message && (fs.existsSync(folder) || tracked)) {
        await git(dir, ["add", "-A", "--", work.id]);
        if ((await git(dir, ["diff", "--cached", "--name-only"])).trim()) {
          await git(dir, ["commit", "-q", "-m", `复盘「${title}」：${message}`.slice(0, 300)]);
          saved = true;
        }
      }
      events.emit({ type: "reviews", repo: work.repo, work: work.id });
      if (saved) works.saved(scope);
      return result;
    });
  }

  /** What a new post records unless told otherwise: the work's title, length and current version, and its exports. */
  async defaults(work) {
    const { works, exports } = this.services;
    const meta = works.meta(work).meta ?? {};
    const status = await works.status(work).catch(() => null);
    const exported = (exports?.list(work) ?? []).map((item) => [item.name, { duration: item.duration, version: item.version }]);
    return { title: meta.title ?? "", duration: meta.duration, version: status?.head?.commit, exports: new Map(exported) };
  }

  /**
   * Data operations (post, snapshot, remove_post, remove_snapshot) and document operations
   * (write, edit, delete, move of .md/.txt in the folder), in one version.
   */
  async apply(work, operations, { message } = {}) {
    const defaults = await this.defaults(work);
    return this.save(work, async ({ folder, title }) => {
      const file = path.join(folder, DATA_FILE);
      const review = fs.existsSync(file) ? parseReview(fs.readFileSync(file, "utf8"), work.id) : emptyReview(work.id);
      const indexed = operations.map((item, index) => ({ item, index }));
      const dataOps = indexed.filter(({ item }) => DATA_OPERATIONS.has(item.op));
      const docOps = indexed.filter(({ item }) => !DATA_OPERATIONS.has(item.op));
      const applied = applyOperations(
        review,
        dataOps.map(({ item }) => item),
        { ...defaults, title: defaults.title || title },
      );
      const results = applied.results.map((result, at) => ({ ...result, index: dataOps[at].index }));
      const changes = [...applied.changes];
      if (applied.changes.length) {
        review.title = title;
        writeFileAtomic(file, formatReview(review));
      }
      if (docOps.length) {
        const outcome = runFileOperations(
          folder,
          docOps.map(({ item }) => item),
          {
            reader: "review_read",
            allow: (_item, paths) => {
              if (paths.some((item) => !isDocument(item)))
                throw problem(400, `复盘文档只能是 .md 或 .txt，并且不在 ${RAW}/ 里（原始文件保持原样）：${paths.join(" → ")}`);
            },
          },
        );
        for (const result of outcome.results) results.push({ ...result, index: docOps[result.index].index });
        const changed = [...new Set(outcome.changed)];
        if (changed.length) changes.push(`复盘文档 ${changed.join("、")}`);
      }
      results.sort((a, b) => a.index - b.index);
      return { message: changes.length ? message || changes.join("；") : null, result: { results, changes, review } };
    });
  }

  /** An original file (spreadsheet, screenshot…) into raw/, kept as it is. */
  async putRaw(work, name, stream, { replace = false } = {}) {
    return this.save(work, async ({ folder }) => {
      const wanted = `${RAW}/${cleanName(name)}`;
      confined(folder, wanted);
      const target = replace ? wanted : uniquePath(folder, wanted);
      const saved = await writeStream(folder, target, stream, { overwrite: replace, limit: RAW_LIMIT });
      return { message: `上传原始文件 ${target.slice(RAW.length + 1)}`, result: { path: target, size: saved.size } };
    });
  }

  async removeFile(work, file) {
    if (file === DATA_FILE) throw problem(400, `${DATA_FILE} 用发布记录和数据的操作修改`);
    return this.save(work, async ({ folder }) => {
      removePath(folder, file);
      return { message: `删除 ${file}` };
    });
  }

  /** A document of a work's folder as the editor writes it (path `<work id>/<document>`). */
  async writeDocument(repo, file, content, expectedHash) {
    const [id, ...rest] = String(file || "").split("/");
    const relative = rest.join("/");
    if (!validWorkId(id) || !isDocument(relative)) throw problem(400, "只能在复盘文件夹里编辑 .md 或 .txt 文档");
    const work = await this.services.openWork(id, repo);
    return this.save(work, async ({ folder }) => ({ message: `编辑 ${relative}`, result: writeText(folder, relative, content, { expectedHash }) }));
  }

  /** A permanently deleted work takes its review folder along. */
  async forget(repo, id) {
    const dir = this.existingSync(repo);
    if (!dir || !validWorkId(id) || !fs.existsSync(path.join(dir, id))) return;
    const { review } = this.readFrom(dir, id);
    const scope = await this.scope(repo);
    const saved = await this.services.works.locks.run(`${scope.repo}/${scope.id}`, async () => {
      const tracked = (await git(dir, ["ls-files", "--", id])).trim();
      fs.rmSync(path.join(dir, id), { recursive: true, force: true });
      if (!tracked) return false;
      await git(dir, ["add", "-A", "--", id]);
      await git(dir, ["commit", "-q", "-m", `删除复盘：${review.title || id}（作品已永久删除）`]);
      return true;
    });
    this.services.events.emit({ type: "reviews", repo, work: id });
    if (saved) this.services.works.saved(scope);
  }

  // ---- comparing --------------------------------------------------------------------------

  /**
   * One row per post of the works in `repos` that have review data (see compareRows), filtered
   * by what the works are like: `tags` (any of them), a linked experience library, given ids.
   */
  async compare({ repos, works: ids, tags, experience, ...options }) {
    const entries = [];
    for (const repo of repos) {
      const dir = await this.existing(repo);
      if (!dir) continue;
      const catalog = await this.services.works.catalog(repo);
      // Library names as linked, renames followed.
      const experienceDir = path.join(this.services.config.dirs.experience, repo);
      const library = (name) => this.services.experience?.resolve(experienceDir, name) ?? name;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !validWorkId(entry.name) || (ids?.length && !ids.includes(entry.name))) continue;
        if (!fs.existsSync(path.join(dir, entry.name, DATA_FILE))) continue;
        const review = parseReview(fs.readFileSync(path.join(dir, entry.name, DATA_FILE), "utf8"), entry.name);
        const work = catalog.get(entry.name);
        if (tags?.length && !work?.tags?.some((tag) => tags.includes(tag))) continue;
        if (experience && !work?.experiences?.some((name) => library(name) === library(experience))) continue;
        entries.push({
          repo,
          review,
          work: work ? { ...work, ...(work.trashed ? { missing: true } : {}) } : { title: review.title, missing: true },
        });
      }
    }
    return compareRows(entries, options);
  }

  // ---- for the AI's context -------------------------------------------------------------

  /** The session brief says that the work has review data (the numbers are read on demand). */
  brief(work) {
    const dir = this.existingSync(work.repo);
    if (!dir || !fs.existsSync(path.join(dir, work.id, DATA_FILE))) return null;
    const { review, documents } = this.readFrom(dir, work.id);
    if (!review.posts.length) return null;
    const platforms = [...new Set(review.posts.map((post) => post.platform))].join("、");
    return {
      text: `## 复盘\n\n这个作品已经发布到${platforms}，记录了 ${review.snapshots.length} 次数据${documents.length ? `，复盘文档：${documents.map((doc) => doc.path).join("、")}` : ""}。用户问起作品的表现、要复盘或和其他作品比较时，用 review_read 看数据和留存，reviews_compare 对比；复盘得出的可复用结论，征得用户同意后整理进经验库。`,
      state: {},
    };
  }

  /** For work_context: what review data there is (null when none). */
  async summary(work) {
    const dir = await this.existing(work.repo);
    if (!dir) return null;
    const { review, files, documents } = this.readFrom(dir, work.id);
    if (!review.posts.length && !files.length && !documents.length) return null;
    return {
      posts: review.posts.map((post) => {
        const now = latest(review, post);
        return {
          id: post.id,
          platform: post.platform,
          postedAt: post.postedAt,
          ...(now
            ? { latest: { age: ageLabel(ageDays(post, now.at)), views: now.metrics.views ?? null, completionRate: now.metrics.completionRate ?? null } }
            : {}),
        };
      }),
      documents: documents.map((doc) => doc.path),
      files: files.length,
      hint: "详情用 review_read，对比其他作品用 reviews_compare",
    };
  }
}

const DEFINITIONS = { metrics: METRICS, derived: DERIVED, platforms: PLATFORMS, checkpoints: Object.keys(CHECKPOINTS), columns: DEFAULT_COLUMNS };

// ---- routes and tools ----------------------------------------------------------------------

export function reviewsPlugin(services) {
  const { router, tools, works } = services;
  const reviews = (services.reviews = new Reviews(services));
  works.briefProviders.push((work) => reviews.brief(work));
  const base = "/api/repos/:repo/reviews";
  const scope = (params) => reviews.scope(params.repo);
  const workOf = (params) => services.openWork(params.work, params.repo);
  const folderFile = async (params, file) => {
    const work = await workOf(params);
    const dir = await reviews.existing(work.repo);
    if (!dir) throw notFound("这个作品还没有复盘资料");
    const full = confined(path.join(dir, work.id), String(file || ""));
    if (!fs.statSync(full, { throwIfNoEntry: false })?.isFile()) throw notFound(`文件不存在：${file}`);
    return full;
  };

  /** What review_write and the studio change: the data, and the documents in the folder. */
  const docPath = z.string().min(1).max(300);
  const operation = z.discriminatedUnion("op", [
    postOperation,
    snapshotOperation,
    removePostOperation,
    removeSnapshotOperation,
    z.strictObject({ op: z.literal("write"), path: docPath, content: z.string().max(512 * 1024), expectedSha256: z.string().optional() }),
    z.strictObject({ op: z.literal("edit"), path: docPath, edits: editList }),
    z.strictObject({ op: z.literal("delete"), path: docPath }),
    z.strictObject({ op: z.literal("move"), from: docPath, to: docPath }),
  ]);

  // ---- a work's review ------------------------------------------------------------------
  router.get(`${base}/works/:work`, async ({ params }) => reviews.detail(await workOf(params)));
  router.post(`${base}/works/:work`, async ({ params, req }) => {
    const body = await readJson(req);
    const parsed = z.array(operation).min(1).max(50).safeParse(body.operations);
    if (!parsed.success) throw problem(400, "操作无效：" + describeIssues(parsed.error.issues));
    const work = await workOf(params);
    const { results } = await reviews.apply(work, parsed.data, { message: body.message });
    const failed = results.filter((result) => result.status !== "ok");
    if (failed.length === results.length) throw problem(400, failed.map((result) => result.message).join("；"));
    return { ...(await reviews.detail(work)), results };
  });
  router.post(`${base}/works/:work/upload`, async ({ params, req, query }) => reviews.putRaw(await workOf(params), query.name, req), { raw: true });
  /** An original file: as it is, or (table=1) a spreadsheet read as rows. */
  router.get(`${base}/works/:work/raw`, async ({ params, query, req, res }) => {
    const file = await folderFile(params, query.path);
    if (query.table !== "1") return sendFile(req, res, file);
    if (!TABLE_FILE.test(file)) throw problem(400, "只有 xlsx、csv、tsv 能读成表格");
    return readTable(file, { maxRows: 1000 });
  });
  router.delete(`${base}/works/:work/file`, async ({ params, query }) => reviews.removeFile(await workOf(params), String(query.path || "")));

  // ---- documents as editor tabs (paths `<work id>/<document>`, like the experience files) --
  router.get(`${base}/file`, async ({ params, query }) => {
    const dir = await reviews.existing(params.repo);
    if (!dir) throw notFound("还没有复盘资料");
    return readText(dir, query.path);
  });
  router.put(`${base}/file`, async ({ params, req }) => {
    const body = await readJson(req);
    return reviews.writeDocument(params.repo, body.path, body.content, body.expectedHash);
  });

  // ---- versions: every change is one already; history and sync like a work's --------------
  router.get(`${base}/status`, async ({ params }) => works.status(await scope(params)));
  router.get(`${base}/history`, async ({ params, query }) =>
    works.history(await scope(params), { limit: Number(query.limit || 50), skip: Number(query.skip || 0) }),
  );
  router.get(`${base}/changes`, async ({ params, query }) => works.changes(await scope(params), query.commit));
  router.get(`${base}/diff`, async ({ params, query }) => ({ diff: await works.diff(await scope(params), { commit: query.commit, file: query.file }) }));
  const changedAll = (params) => services.events.emit({ type: "reviews", repo: params.repo });
  router.post(`${base}/revert`, async ({ params, req }) => {
    const result = { commit: await works.revert(await scope(params), (await readJson(req)).commit) };
    changedAll(params);
    return result;
  });
  router.post(`${base}/commit`, () => ({ commit: null }));
  router.post(`${base}/discard`, () => null);
  router.post(`${base}/sync`, async ({ params }) => works.sync(await scope(params)));
  router.post(`${base}/push`, async ({ params }) => works.push(await scope(params)));
  router.post(`${base}/pull`, async ({ params }) => {
    const result = await works.pull(await scope(params));
    changedAll(params);
    return result;
  });
  router.post(`${base}/resolve`, async ({ params, req }) => {
    const result = await works.resolve(await scope(params), (await readJson(req)).strategy);
    changedAll(params);
    return result;
  });

  /** All works' posts side by side (the home page's comparison). */
  router.get("/api/reviews/compare", async ({ query }) => {
    const ready = services.repos
      .list()
      .filter((repo) => repo.ready)
      .map((repo) => repo.id);
    if (query.repo && !ready.includes(query.repo)) throw notFound(`作品库不存在：${query.repo}`);
    const repos = query.repo ? [query.repo] : ready;
    const checkpoint = query.checkpoint in CHECKPOINTS ? query.checkpoint : "7d";
    const rows = await reviews.compare({ repos, checkpoint, platform: query.platform || undefined, curves: query.curves === "1" });
    return { rows, checkpoint, definitions: DEFINITIONS };
  });

  // ---- AI tools ---------------------------------------------------------------------------
  tools.add({
    name: "review_read",
    title: "读取复盘",
    description:
      "作品发布后的复盘资料：发到了哪些平台（发布记录）、各次统计的数据（按发布后的天数）、观众留存和流失明显的地方（对应的镜头和字幕，可以用 preview_frames 看那几秒的画面）、复盘文档和原始文件。传 file 读其中一个文件：平台导出的表格（xlsx、csv）读成文字表格，截图返回图片给你看，复盘文档返回全文。录入数据、写复盘用 review_write；和其他作品比较用 reviews_compare。",
    readOnly: true,
    input: {
      work: workArg,
      file: z.string().min(1).max(300).optional().describe("复盘文件夹里的文件，例如 raw/抖音-近7天.xlsx、raw/后台截图.png、复盘.md"),
    },
    async run({ file }, ctx) {
      const work = await ctx.work();
      if (file) return readFile(work, file, ctx);
      const detail = await reviews.detail(work);
      const meta = works.meta(work).meta ?? {};
      return {
        data: { review: detail.review, summary: detail.summary, analyses: detail.analyses, documents: detail.documents, files: detail.files },
        text: reviewText({
          review: detail.review,
          title: detail.review.title || work.id,
          duration: meta.duration,
          files: detail.files,
          documents: detail.documents,
          analyses: detail.analyses,
        }),
      };
    },
  });

  /** One file of the folder, in the form the AI can use. */
  async function readFile(work, file, ctx) {
    const dir = await reviews.existing(work.repo);
    const folder = dir ? path.join(dir, work.id) : null;
    const full = folder ? confined(folder, file) : null;
    if (!full || !fs.statSync(full, { throwIfNoEntry: false })?.isFile()) {
      const listed = folder ? reviews.readFrom(dir, work.id) : null;
      const names = listed ? [...listed.documents, ...listed.files].map((item) => item.path) : [];
      throw problem(404, `没有这个文件：${file}${names.length ? `（现有：${names.join("、")}）` : "（这个作品还没有复盘文件）"}`, "NOT_FOUND");
    }
    if (TABLE_FILE.test(full)) {
      const table = readTable(full);
      return { data: { file, sheets: table.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.total })) }, text: `${file}\n\n${tableText(table)}` };
    }
    if (IMAGE.test(full)) {
      const image = await sharp(full, { animated: false })
        .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 90 })
        .toBuffer();
      return { data: { file }, text: `${file}（图片，见下图）`, images: [{ data: image, mimeType: "image/jpeg" }] };
    }
    if (/\.(md|txt|json|csv|srt|vtt)$/i.test(full)) {
      const result = readText(folder, file);
      return { data: { file, sha256: result.hash }, meta: { file, sha256: result.hash }, text: result.content };
    }
    // PDF, Word, old .xls…: hand over the file itself.
    const link = services.downloads?.link(full);
    const local = services.auth.required && !ctx.scope.session ? "" : `本机路径：${full}。`;
    return {
      data: { file, ...(link ? { download: link.url } : {}) },
      text: `${file} 不能直接读成文字。${local}${link ? `下载地址（${link.expiresInMinutes} 分钟内有效）：${link.url}。` : ""}能读这种文件就直接读；不能的话请用户另存为 xlsx / csv，或截图上传到「复盘」。`,
    };
  }

  tools.add({
    name: "review_write",
    published: true, // the reviews branch, not the work: allowed on a published work
    title: "记录复盘",
    destructive: true,
    description:
      "记录作品发布后的复盘资料，每次调用自动保存为一个版本。operations 按顺序执行：post 新增或修改发布记录（平台、发布时间、链接、发布的是哪个导出文件）；snapshot 录入一条发布记录截至某个时间的累计数据和留存曲线（同一时间已有的合并，source 写数据来自哪个原始文件）；remove_post、remove_snapshot 删除；write / edit / delete / move 修改复盘文档（.md，路径相对作品的复盘文件夹，例如 复盘.md）。raw/ 里的原始文件保持原样，不能改。失败的逐项说明原因，只需重试失败的。格式和复盘方法见 frame_guide reviews。",
    input: {
      work: workArg,
      operations: z.array(operation).min(1).max(50),
      message: z.string().max(200).optional().describe("这次修改的说明（版本记录里显示），不写时自动生成"),
    },
    async run({ operations, message }, ctx) {
      const work = await ctx.work();
      const { results, changes, review } = await reviews.apply(work, operations, { message });
      const failed = results.filter((result) => result.status !== "ok");
      const icon = { ok: "✓", failed: "✗", skipped: "–" };
      const lines = results.map(
        (result) =>
          `${icon[result.status]} ${result.index + 1}. ${result.op}${result.path ? ` ${result.path}` : ""}${result.status === "ok" ? "" : `：${result.message}`}`,
      );
      const head = !changes.length ? "没有改动" : `已保存（${changes.join("；")}）`;
      const ids = review.posts.map((post) => `${post.id} ${post.platform} ${post.postedAt.slice(0, 10)}`).join("、");
      return {
        data: { results, posts: review.posts.map(({ id, platform, postedAt }) => ({ id, platform, postedAt })) },
        text: `${head}${failed.length ? `，${failed.length} 项没有完成（只需重试这些）` : ""}：\n${lines.join("\n")}${ids ? `\n发布记录：${ids}` : ""}`,
      };
    },
  });

  const metricKeys = [...METRICS, ...DERIVED].map((item) => item.key);
  tools.add({
    name: "reviews_compare",
    title: "对比作品数据",
    description: `把作品发布后的数据放在一起比较：每条发布记录一行，都取发布后同一天数的数据（checkpoint，默认第 7 天；总数会一直涨，不同天数的不能直接比），算出点赞率、评论率、分享率、完播率、3 秒留存等比例和中位数，标出本作品（▶）比中位数高还是低。可以按平台、作品标签、关联的经验库、发布时间筛选。用户想知道作品表现如何、和其他作品比、哪类做法效果更好时用。指标：${metricKeys.join("、")}，以及平台特有指标的中文名。`,
    readOnly: true,
    input: {
      work: workArg,
      checkpoint: z.enum(Object.keys(CHECKPOINTS)).default("7d").describe("发布后第几天：1d、3d、7d、14d、30d，或 latest（各自最新的数据，天数不同只能粗看）"),
      platform: z.string().max(40).optional().describe("只看这个平台"),
      tags: z.array(z.string().max(60)).max(10).optional().describe("只看带这些标签之一的作品（project.ts 的 tags）"),
      experience: z.string().max(60).optional().describe("只看关联了这个经验库的作品（同类作品）"),
      works: z.array(z.string().max(64)).max(50).optional().describe("只看这些作品（id）"),
      since: z.string().max(40).optional().describe("发布时间不早于（ISO 日期）"),
      until: z.string().max(40).optional().describe("发布时间不晚于（ISO 日期）"),
      columns: z
        .array(z.string().max(40))
        .min(1)
        .max(16)
        .optional()
        .describe(`表格里的指标，默认 ${DEFAULT_COLUMNS.join("、")}`),
      sort: z.string().max(40).default("views").describe("按这个指标从高到低排"),
      curves: z.boolean().default(false).describe("同时给出各条发布记录的留存曲线（按视频进度 0–100% 对齐，长短不同的视频也能比）"),
      repo: z.string().max(80).optional().describe("作品库；默认是当前作品所在的库，没有当前作品时是全部"),
    },
    async run(args, ctx) {
      const named = ctx.scope.work || args.work;
      const work = named ? await ctx.work() : null;
      if (ctx.scope.work && args.repo && args.repo !== work.repo) throw problem(403, "这个会话只能对比当前作品库里的作品", "FORBIDDEN");
      const repos = args.repo
        ? [args.repo]
        : work
          ? [work.repo]
          : services.repos
              .list()
              .filter((repo) => repo.ready)
              .map((repo) => repo.id);
      for (const since of [args.since, args.until]) if (since && Number.isNaN(Date.parse(since))) throw problem(400, `无法识别的日期：${since}`);
      const rows = await reviews.compare({ repos, ...args });
      const value = (row) => row.metrics[args.sort];
      rows.sort((a, b) => (Number.isFinite(value(b)) ? value(b) : -Infinity) - (Number.isFinite(value(a)) ? value(a) : -Infinity));
      let text = compareText(rows, { checkpoint: args.checkpoint, columns: args.columns ?? DEFAULT_COLUMNS, current: work?.id });
      const curved = rows.filter((row) => row.curve);
      if (args.curves)
        text += curved.length
          ? `\n\n留存曲线（视频进度 → 还在看的比例）：\n${curved
              .map(
                (row) =>
                  `${row.title}·${row.platform}：${row.curve
                    .filter((_, index) => index % 5 === 0)
                    .map(([at, kept]) => `${Math.round(at * 100)}% ${formatPercent(kept)}`)
                    .join("，")}`,
              )
              .join("\n")}`
          : "\n\n这些发布记录都没有留存曲线。";
      if (!rows.length) text = `没有符合条件的发布记录${work ? "（只看了当前作品所在的作品库）" : ""}。先用 review_write 记下发布记录和数据。`;
      return { data: { checkpoint: args.checkpoint, rows }, text };
    },
  });
}
