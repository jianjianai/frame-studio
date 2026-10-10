import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import sharp from "sharp";
import { git, gitOk } from "./git.mjs";
import { tree, readText, writeText, writeStream, removePath, uniquePath } from "./files.mjs";
import { readJson, sendFile } from "./http.mjs";
import { problem, notFound, confined, writeFileAtomic, mediaKind } from "./util.mjs";
import { GIT_ATTRIBUTES } from "./templates.mjs";
import { readProjectSource, validSlug } from "./project-meta.mjs";
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
  seriesOperation,
  momentOperation,
  segmentsOperation,
  removePostOperation,
  removeSnapshotOperation,
  removeMomentOperation,
  latest,
  snapshotsOf,
  derive,
  compareRows,
  defaultCheckpoint,
  isZonedTime,
  ZONED_HINT,
  formatPercent,
  ageLabel,
  ageDays,
  beijing,
} from "./review-data.mjs";
import { retentionAnalysis, flowAnalysis, reviewText, secondsText, compareText, lyricsText, momentColumns } from "./review-analysis.mjs";
import { readExports } from "./review-import.mjs";
import { workSegments } from "./review-segments.mjs";

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

- \`review.json\`：发到了哪些平台、各次统计的数据、观众留存（和同类作品的）、每小时数据、流量来源、关键时刻
- \`raw/\`：平台后台导出的表格、截图等原始文件，原样保存
- 其他 \`.md\`：复盘文档
`;
const validWorkId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
const isDocument = (file) => /\.(md|txt)$/i.test(file) && !file.startsWith(`${RAW}/`);
/** An original file or folder as people write it ("2026-10-10/流量数据.xlsx", "./raw/2026-10-10/") → "raw/…". */
const rawPath = (value) => {
  const clean = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/|\/)+/, "")
    .replace(/\/+$/, "");
  return clean === RAW || clean.startsWith(`${RAW}/`) ? clean : `${RAW}/${clean}`;
};
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
const sha256Of = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
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
    return this.handle(repo, await this.dir(repo));
  }
  /** The same, or null while the repository has no reviews (looking at versions starts nothing). */
  async scopeIfAny(repo) {
    const dir = await this.existing(repo);
    return dir ? this.handle(repo, dir) : null;
  }
  handle(repo, root) {
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
   * The text of a work's files (under projects/<slug>/): from its checkout, or from its branch
   * when it is not checked out (comparing many works opens none of them). Null when unknown.
   */
  async workFiles(repo, id) {
    const { works, repos } = this.services;
    if (fs.existsSync(path.join(works.root(repo, id), ".git")))
      try {
        const work = works.describe(repo, id);
        const read = async (relative) => {
          const file = confined(work.dir, relative);
          return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
        };
        return { meta: works.meta(work).meta ?? {}, read };
      } catch {}
    const { dir } = repos.get(repo);
    const ref = (await gitOk(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/works/${id}`]))
      ? `refs/heads/works/${id}`
      : `refs/remotes/origin/works/${id}`;
    const slug = (await git(dir, ["ls-tree", "--name-only", ref, "projects/"]).catch(() => ""))
      .split("\n")
      .map((name) => name.slice(9))
      .find((name) => validSlug(name));
    if (!slug) return null;
    const read = (relative) => git(dir, ["show", `${ref}:projects/${slug}/${relative}`]).catch(() => null);
    try {
      return { meta: readProjectSource(await read("project.ts")).meta, read };
    } catch {
      return null;
    }
  }

  /** The stretches retention is measured over: the work's own (layers, shots, subtitles, lyrics) and the review's, which replace the same kind. */
  async segments(files, review) {
    const auto = files ? await workSegments(files) : [];
    const custom = new Set(review.segments.map((segment) => segment.kind));
    return [...auto.filter((segment) => !custom.has(segment.kind)), ...review.segments];
  }

  /**
   * Everything the studio shows of a work's review: per post the newest numbers (and the same
   * for similar videos), every snapshot with the derived rates (charts), the retention and
   * hourly analyses; the segments.
   */
  async detail(work) {
    const { review, files, documents } = await this.read(work);
    const meta = this.services.works.meta(work).meta ?? {};
    const segments = await this.segments(await this.workFiles(work.repo, work.id), review);
    const summary = {};
    const history = {};
    const analyses = {};
    for (const post of review.posts) {
      const duration = post.duration ?? meta.duration;
      const now = latest(review, post, { duration });
      const flow = flowAnalysis(review, post);
      if (flow) analyses[post.id] = { flow };
      if (!now) continue;
      const ages = Object.fromEntries(Object.entries(now.from).map(([key, at]) => [key, ageDays(post, at)]));
      summary[post.id] = {
        at: now.at,
        age: ageDays(post, now.at),
        metrics: now.metrics,
        benchmark: now.benchmark,
        ages,
        sources: now.sources,
        comments: now.comments,
      };
      history[post.id] = snapshotsOf(review, post).map((snapshot) => ({
        at: snapshot.at,
        age: ageDays(post, snapshot.at),
        metrics: derive(snapshot.metrics, { duration, retention: snapshot.retention, moments: review.moments }),
      }));
      const retention = retentionAnalysis({ retention: now.retention, benchmark: now.retentionBenchmark, duration, segments, moments: review.moments });
      if (retention) analyses[post.id] = { ...analyses[post.id], retention };
    }
    return {
      review: { ...review, title: meta.title ?? review.title },
      files,
      documents,
      summary,
      history,
      analyses,
      segments,
      definitions: DEFINITIONS,
    };
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
    const scope = this.handle(work.repo, dir);
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

  /**
   * The work's version now when what viewers see changed since `version` (the version a post
   * published), else null: notes, production files and the publish mark do not count.
   */
  async changedSince(work, version) {
    if (!version) return null;
    try {
      const head = (await git(work.root, ["rev-parse", "HEAD"])).trim();
      if (head.startsWith(version)) return null;
      const folder = path.relative(work.root, work.dir) || ".";
      const names = (await git(work.root, ["diff", "--name-only", version, "HEAD", "--", folder]))
        .split("\n")
        .filter((name) => name && !/\.md$/i.test(name) && !/(^|\/)(production|public\/uploads)\//.test(name));
      if (!names.length) return null;
      if (names.length === 1 && names[0].endsWith("project.ts")) {
        const diff = await git(work.root, ["diff", "-U0", version, "HEAD", "--", names[0]]);
        const lines = diff.split("\n").filter((line) => /^[-+]/.test(line) && !/^(---|\+\+\+) /.test(line));
        if (lines.every((line) => /^[-+]\s*(publishedAt|tags|notes|title)\s*:/.test(line))) return null;
      }
      return head.slice(0, 7);
    } catch {
      // A version this checkout does not have: nothing to compare.
      return null;
    }
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
   * Data operations (post, snapshot, series, moment, segments, remove_*) and document
   * operations (write, edit, delete, move of .md/.txt in the folder), in one version.
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

  /**
   * Read a platform's exports among the work's original files (paths under raw/, or a folder
   * of them; "2026-10-10" means raw/2026-10-10) and enter them as one snapshot of a post with
   * its hourly series: the post of that platform (`post` when there are several; a new one
   * when there is none, posted at `postedAt` or the first hour of the data), counted up to
   * `at` (default: the last hour of the data). Files of two exports are not mixed into one
   * snapshot. `dryRun` only says what it would do; the preview tells when nothing would change
   * (the files were imported before).
   */
  async importExports(work, { files = [], folder, post: postId, at, postedAt, dryRun = false } = {}) {
    const dir = await this.existing(work.repo);
    const root = dir ? path.join(dir, work.id) : null;
    const folders = () => (root && fs.existsSync(path.join(root, RAW)) ? tree(path.join(root, RAW)).filter((entry) => entry.type === "dir") : []);
    if (!root || !fs.existsSync(path.join(root, RAW)))
      throw notFound("这个作品的复盘资料里还没有原始文件：先在「复盘」上传平台后台导出的文件（外部 AI 用 upload_link 的 review: true 上传）");
    const wanted = files.map(rawPath);
    if (folder) {
      const named = rawPath(folder);
      if (!fs.statSync(confined(root, named), { throwIfNoEntry: false })?.isDirectory())
        throw notFound(`没有文件夹 ${named}（现有：${[RAW, ...folders().map((entry) => `${RAW}/${entry.path}`)].join("、")}）`);
      for (const entry of tree(confined(root, named))) if (entry.type === "file" && TABLE_FILE.test(entry.path)) wanted.push(`${named}/${entry.path}`);
    }
    if (!wanted.length) throw problem(400, "要导入哪些文件：files 写原始文件的路径（raw/…），或用 folder 指定一个文件夹（例如 raw/2026-10-10）");
    const list = [...new Set(wanted)].map((file) => {
      if (file.split("/").includes("..")) throw problem(400, `只能导入 ${RAW}/ 里的原始文件：${file}`);
      const full = confined(root, file);
      if (!fs.statSync(full, { throwIfNoEntry: false })?.isFile()) throw notFound(`没有这个原始文件：${file}`);
      return { path: file, file: full };
    });
    const parsed = readExports(list);
    if (!parsed.platform)
      throw problem(
        400,
        `没有认出平台后台导出的数据（目前认得抖音创作者中心的作品数据和评论导出）：${parsed.unrecognized.join("、")}。可以用 review_read 读出来，再用 review_write 录入。`,
      );
    if (parsed.conflicts.length)
      throw problem(
        409,
        `这些文件不是同一次导出的（${parsed.conflicts.slice(0, 3).join("；")}），不能合成一次数据。用 files 只列同一次导出的文件，分几次导入：\n${parsed.recognized
          .map((item) => `- ${item.path}：${item.parts.join("、")}${item.until ? `，每小时数据到 ${beijing(item.until)}` : ""}`)
          .join("\n")}`,
        "MIXED_EXPORTS",
      );
    const { review } = this.readFrom(dir, work.id);
    const candidates = review.posts.filter((item) => item.platform === parsed.platform);
    const post = postId
      ? (review.posts.find((item) => item.id === postId) ?? fail404(`没有发布记录 ${postId}`))
      : candidates.length === 1
        ? candidates[0]
        : null;
    if (!post && candidates.length > 1)
      throw problem(
        409,
        `作品在${parsed.platform}有 ${candidates.length} 条发布记录（${candidates.map((item) => `${item.id} ${beijing(item.postedAt)}`).join("、")}），用 post 指定导入到哪一条`,
        "POST_REQUIRED",
      );
    // A comments export made in the hourly data's last (unfinished) hour says to the minute when the numbers were counted.
    const lead = parsed.commentsAt && parsed.dataEnd ? Date.parse(parsed.commentsAt) - Date.parse(parsed.dataEnd) : -1;
    const when = at ?? (lead >= 0 && lead < 3600000 ? parsed.commentsAt : (parsed.dataEnd ?? parsed.commentsAt));
    if (!when) throw problem(400, "认不出这些数据统计到什么时候：用 at 写导出时间（带时区）");
    const posted = post?.postedAt ?? postedAt ?? parsed.firstHour;
    if (!posted) throw problem(400, `还没有${parsed.platform}的发布记录，数据里也看不出发布时间：用 postedAt 写发布时间（带时区）`);
    const id = post?.id ?? `p${Math.max(0, ...review.posts.map((item) => Number(/^p(\d+)$/.exec(item.id)?.[1] ?? 0))) + 1}`;
    const operations = [
      ...(post
        ? []
        : [
            postOperation.parse({
              op: "post",
              platform: parsed.platform,
              postedAt: new Date(posted).toISOString(),
              ...(parsed.postTitle ? { title: parsed.postTitle } : {}),
            }),
          ]),
      snapshotOperation.parse({
        op: "snapshot",
        post: id,
        at: new Date(when).toISOString(),
        // Copies of a file count as entered too; files nobody recognized stay waiting.
        source: [...parsed.recognized, ...parsed.duplicates].map((item) => item.path).join("、"),
        metrics: parsed.metrics,
        ...(parsed.retention ? { retention: parsed.retention } : {}),
        ...(parsed.retentionBenchmark ? { retentionBenchmark: parsed.retentionBenchmark } : {}),
        ...(parsed.sources ? { sources: parsed.sources } : {}),
        ...(parsed.comments ? { comments: parsed.comments } : {}),
        replace: true,
      }),
      ...parsed.series.map((series) => seriesOperation.parse({ op: "series", post: id, ...series })),
    ];
    // The same files again change nothing: say so rather than "imported".
    const trial = parseReview(formatReview(review), work.id);
    applyOperations(trial, operations, { title: review.title });
    const preview = {
      platform: parsed.platform,
      post: post?.id ?? null,
      postedAt: new Date(posted).toISOString(),
      at: new Date(when).toISOString(),
      recognized: parsed.recognized,
      unrecognized: parsed.unrecognized,
      duplicates: parsed.duplicates,
      metrics: Object.keys(parsed.metrics),
      retention: Boolean(parsed.retention),
      benchmark: Boolean(parsed.retentionBenchmark),
      series: parsed.series.map((series) => series.key),
      sources: parsed.sources?.length ?? 0,
      comments: parsed.comments ? { threads: parsed.comments.threads, replies: parsed.comments.replies } : null,
      replaces: Boolean(post && review.snapshots.some((item) => item.post === post.id && item.at === new Date(when).toISOString())),
      unchanged: Boolean(post) && formatReview(trial) === formatReview(review),
    };
    if (dryRun || preview.unchanged) return { preview };
    const outcome = await this.apply(work, operations, { message: `导入${parsed.platform}后台数据（${list.length} 个文件，统计到 ${beijing(preview.at)}）` });
    const failed = outcome.results.filter((result) => result.status !== "ok");
    if (failed.length) throw problem(400, `导入没有完成：${failed.map((result) => result.message).join("；")}`);
    return { preview: { ...preview, post: id }, ...outcome };
  }

  /** An original file (spreadsheet, screenshot…) into raw/ (or raw/<folder>/), kept as it is. */
  async putRaw(work, name, stream, { replace = false, folder = "" } = {}) {
    const sub = String(folder || "")
      .split(/[\\/]+/)
      .map(cleanName)
      .filter((part) => part && part !== "file")
      .join("/");
    return this.save(work, async ({ folder: root }) => {
      const wanted = `${RAW}/${sub ? `${sub}/` : ""}${cleanName(name)}`;
      confined(root, wanted);
      const target = replace ? wanted : uniquePath(root, wanted);
      const saved = await writeStream(root, target, stream, { overwrite: replace, limit: RAW_LIMIT });
      // The hash lets whoever uploaded check the file arrived whole.
      const sha256 = await sha256Of(path.join(root, target));
      return { message: `上传原始文件 ${target.slice(RAW.length + 1)}`, result: { path: target, size: saved.size, sha256 } };
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
    const scope = this.handle(repo, dir);
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
   * With `lyrics`, rows of works with lyrics carry each line's multiplier (lyricsText). Returns
   * { rows, checkpoint }: without a `checkpoint`, the age most of the posts have reached.
   */
  async compare({ repos, works: ids, tags, experience, lyrics = false, ...options }) {
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
    const checkpoint = options.checkpoint in CHECKPOINTS ? options.checkpoint : defaultCheckpoint(entries, options);
    const rows = compareRows(entries, { ...options, checkpoint });
    if (lyrics)
      for (const { repo, review, work } of entries) {
        const segments = (await this.segments(await this.workFiles(repo, review.work), review)).filter((segment) => segment.kind === "歌词");
        if (!segments.length) continue;
        for (const row of rows.filter((item) => item.repo === repo && item.work === review.work)) {
          const post = review.posts.find((item) => item.id === row.post);
          const now = latest(review, post, { duration: row.duration });
          const analysis = retentionAnalysis({
            retention: now?.retention,
            benchmark: now?.retentionBenchmark,
            duration: row.duration || work.duration,
            segments,
          });
          row.lyrics = (analysis?.segments["歌词"] ?? []).map(({ songTime, label, multiplier }) => ({ songTime, label, multiplier }));
        }
      }
    return { rows, checkpoint };
  }

  // ---- for the AI's context -------------------------------------------------------------

  /** The session brief says that the work has review data (the numbers are read on demand). */
  brief(work) {
    const dir = this.existingSync(work.repo);
    if (!dir || !fs.existsSync(path.join(dir, work.id))) return null;
    const { review, documents, files } = this.readFrom(dir, work.id);
    const waiting = files.filter((file) => !file.used);
    if (!review.posts.length && !waiting.length) return null;
    const platforms = [...new Set(review.posts.map((post) => post.platform))].join("、");
    return {
      text: [
        "## 复盘",
        "",
        `${review.posts.length ? `这个作品已经发布到${platforms}，记录了 ${review.snapshots.length} 次数据` : "这个作品还没有发布记录"}${documents.length ? `，复盘文档：${documents.map((doc) => doc.path).join("、")}` : ""}。`,
        waiting.length ? `还没导入的原始文件：${waiting.map((file) => file.path).join("、")}（平台后台的导出用 review_import 导入）。` : "",
        "用户问起作品的表现、要复盘或和其他作品比较时，用 review_read 看数据、留存（和同类作品比的倍数）和流量，reviews_compare 对比；复盘得出的可复用结论，征得用户同意后整理进经验库。",
      ]
        .filter(Boolean)
        .join("\n"),
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
          ...(now ? { latest: { age: ageLabel(ageDays(post, now.at)), views: now.metrics.views ?? null, retention5s: now.metrics.retention5s ?? null } } : {}),
        };
      }),
      documents: documents.map((doc) => doc.path),
      files: files.length,
      notImported: files.filter((file) => !file.used).map((file) => file.path),
      hint: "详情用 review_read，导入平台导出用 review_import，对比其他作品用 reviews_compare",
    };
  }
}

function fail404(message) {
  throw notFound(message);
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
    seriesOperation,
    momentOperation,
    segmentsOperation,
    removePostOperation,
    removeSnapshotOperation,
    removeMomentOperation,
    z.strictObject({ op: z.literal("write"), path: docPath, content: z.string().max(512 * 1024), expectedSha256: z.string().optional() }),
    z.strictObject({ op: z.literal("edit"), path: docPath, edits: editList }),
    z.strictObject({ op: z.literal("delete"), path: docPath }),
    z.strictObject({ op: z.literal("move"), from: docPath, to: docPath }),
  ]);
  const importInput = {
    files: z.array(z.string().min(1).max(300)).max(50).optional().describe("原始文件的路径（raw/…）"),
    folder: z.string().max(200).optional().describe("导入这个文件夹里的全部表格，例如 raw/2026-10-10"),
    post: z.string().max(20).optional().describe("导入到哪条发布记录；这个平台只有一条时不用写，一条也没有时新建"),
    at: z.string().max(40).optional().describe("数据统计到的时间（带时区）；不写时取每小时数据的最后一个小时"),
    postedAt: z.string().max(40).optional().describe("新建发布记录时的发布时间（带时区）；不写时取每小时数据的第一个小时"),
  };
  const times = (args) => {
    for (const key of ["at", "postedAt"]) if (args[key] && !isZonedTime(args[key])) throw problem(400, `${key}：${args[key]} 不行，${ZONED_HINT}`);
    return args;
  };

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
  router.post(
    `${base}/works/:work/upload`,
    async ({ params, req, query }) => reviews.putRaw(await workOf(params), query.name, req, { folder: query.folder, replace: query.replace === "1" }),
    { raw: true },
  );
  router.post(`${base}/works/:work/import`, async ({ params, req }) => {
    const body = times(await readJson(req));
    const work = await workOf(params);
    const result = await reviews.importExports(work, {
      files: body.files,
      folder: body.folder,
      post: body.post,
      at: body.at,
      postedAt: body.postedAt,
      dryRun: Boolean(body.dryRun),
    });
    return body.dryRun ? result : { ...(await reviews.detail(work)), preview: result.preview };
  });
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
  // Looking at them starts no branch: a repository without reviews has no versions yet.
  const unborn = (params) => ({
    branch: REVIEWS_BRANCH,
    upstream: "",
    ahead: 0,
    behind: 0,
    files: [],
    head: null,
    remote: Boolean(services.repos.get(params.repo).remote),
  });
  router.get(`${base}/status`, async ({ params }) => {
    const handle = await reviews.scopeIfAny(params.repo);
    return handle ? works.status(handle) : unborn(params);
  });
  router.get(`${base}/history`, async ({ params, query }) => {
    const handle = await reviews.scopeIfAny(params.repo);
    return handle ? works.history(handle, { limit: Number(query.limit || 50), skip: Number(query.skip || 0) }) : [];
  });
  router.get(`${base}/changes`, async ({ params, query }) => {
    const handle = await reviews.scopeIfAny(params.repo);
    return handle ? works.changes(handle, query.commit) : [];
  });
  router.get(`${base}/diff`, async ({ params, query }) => {
    const handle = await reviews.scopeIfAny(params.repo);
    return { diff: handle ? await works.diff(handle, { commit: query.commit, file: query.file }) : "" };
  });
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
    const { rows, checkpoint } = await reviews.compare({
      repos,
      checkpoint: query.checkpoint,
      platform: query.platform || undefined,
      curves: query.curves === "1",
    });
    return { rows, checkpoint, columns: [...DEFAULT_COLUMNS, ...momentColumns(rows)], definitions: DEFINITIONS };
  });

  // ---- AI tools ---------------------------------------------------------------------------
  tools.add({
    name: "review_read",
    title: "读取复盘",
    description:
      "作品发布后的复盘资料：发布记录、最新数据（2 秒跳出、5 秒留存、结尾留存等和同类作品的值并列）、每小时流量（首 24/48/72 小时、按天、几波、各渠道）、流量来源（和账号近 7 天平均比）、观众留存——流失率是同类几倍最高的几秒（带前后两秒）、按图层/歌词/镜头等分段的倍数和“按同类走结尾会多多少”、关键时刻还剩多少人——以及评论概况、复盘文档和原始文件。seconds 看一段时间逐秒的留存。传 file 读其中一个文件：平台导出的表格（xlsx、csv）读成文字表格，截图返回图片给你看，复盘文档返回全文。看那几秒的画面用 preview_frames。导入平台导出用 review_import，录入和写复盘用 review_write，和其他作品比较用 reviews_compare。",
    readOnly: true,
    input: {
      work: workArg,
      file: z.string().min(1).max(300).optional().describe("复盘文件夹里的文件，例如 raw/2026-10-10/流量数据.xlsx、raw/后台截图.png、复盘.md"),
      seconds: z
        .tuple([z.number().min(0), z.number().positive()])
        .optional()
        .describe(
          "看一段时间逐秒的留存：[开始秒, 结束秒]，例如 [16, 33]：每秒还在多少、这一秒走掉多少（和同类的、倍数）、那时的图层、歌词、镜头，以及整段按同类走看到结尾的人会多多少",
        ),
      post: z.string().max(20).optional().describe("seconds 看哪条发布记录（默认有留存曲线的最新一条）"),
    },
    async run({ file, seconds, post: postId }, ctx) {
      const work = await ctx.work();
      if (file && seconds) throw problem(400, "file 和 seconds 一次只用一个");
      if (file) return readFile(work, file, ctx);
      const detail = await reviews.detail(work);
      const meta = works.meta(work).meta ?? {};
      if (seconds) return secondsOf(work, detail, meta, seconds, postId);
      const kinds = {};
      for (const segment of detail.segments) kinds[segment.kind] = (kinds[segment.kind] ?? 0) + 1;
      const changed = {};
      for (const post of detail.review.posts) {
        const now = await reviews.changedSince(work, post.version);
        if (now) changed[post.id] = now;
      }
      return {
        data: { review: detail.review, summary: detail.summary, documents: detail.documents, files: detail.files },
        text: reviewText({
          review: detail.review,
          title: detail.review.title || work.id,
          duration: meta.duration,
          files: detail.files,
          documents: detail.documents,
          analyses: detail.analyses,
          segmentKinds: kinds,
          changed,
        }),
      };
    },
  });

  /** review_read's seconds: one post's retention over a stretch, second by second. */
  function secondsOf(work, detail, meta, [from, to], postId) {
    const { review } = detail;
    if (!(to > from)) throw problem(400, "seconds 写 [开始秒, 结束秒]，结束要大于开始");
    const duration = (post) => post.duration ?? meta.duration;
    const post = postId
      ? (review.posts.find((item) => item.id === postId) ??
        fail404(`没有发布记录 ${postId}（现有：${review.posts.map((item) => item.id).join("、") || "无"}）`))
      : review.posts.findLast((item) => latest(review, item, { duration: duration(item) })?.retention?.length);
    const now = post && latest(review, post, { duration: duration(post) });
    if (!now?.retention?.length) throw problem(400, "还没有留存曲线：先用 review_import 导入平台的留存分析，或用 review_write 的 snapshot 写 retention");
    const text = secondsText({
      retention: now.retention,
      benchmark: now.retentionBenchmark,
      duration: duration(post),
      segments: detail.segments,
      moments: review.moments,
      from,
      to,
    });
    if (!text) throw problem(400, `视频只有 ${duration(post) ?? now.retention.at(-1)[0]} 秒，${from}–${to} 秒不在里面`);
    const at = snapshotsOf(review, post).findLast((snapshot) => snapshot.retention?.length)?.at ?? now.at;
    return {
      data: { post: post.id, from, to },
      text: `复盘「${review.title || work.id}」${post.id} ${post.platform} 的留存（统计到 ${beijing(at)}，${ageLabel(ageDays(post, at))}${now.retentionBenchmark?.length ? "，和同类比" : ""}）\n${text}`,
    };
  }

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
      // Signed links (a comments export has one per picture comment) are long and say nothing here.
      const text = tableText(table).replace(/(https?:\/\/[^/\s,"]+)[^\s,"]{60,}/g, "$1/…");
      return { data: { file, sheets: table.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.total })) }, text: `${file}\n\n${text}` };
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
    name: "review_import",
    published: true, // the reviews branch, not the work
    title: "导入平台数据",
    description:
      "把作品复盘资料 raw/ 里平台后台导出的文件直接导入成一次数据记录，不用自己读表格：目前认得抖音创作者中心的作品数据导出（指标数据、逐秒留存和同类作品、每小时播放和涨粉及抖音精选、流量来源和对比 7 日、涨粉脱粉与不感兴趣、观众参与度）和全部评论导出，按表格内容识别，文件名随意。folder 导入一次导出的文件夹（例如 raw/2026-10-10），或用 files 列出文件；内容相同的文件只读一次，两次导出的文件不会混成一次数据（会提示分开导入）。导入到这个平台的发布记录（只有一条时自动选；没有就新建，发布时间取数据的第一个小时，可以用 postedAt 写准确时间），统计时间取每小时数据的最后一个小时（有评论导出时取它的导出时间）。导入过的再导入会说没有变化。每次调用自动保存一个版本。dryRun 只看会导入什么。",
    input: { work: workArg, ...importInput, dryRun: z.boolean().default(false) },
    async run(args, ctx) {
      const work = await ctx.work();
      const result = await reviews.importExports(work, times(args));
      const { preview } = result;
      const target = `${preview.post ?? "新的发布记录"}（${preview.post ? "" : `发布时间 ${beijing(preview.postedAt)}，`}统计到 ${beijing(preview.at)}，北京时间）`;
      const head = preview.unchanged
        ? `这些文件之前已经导入过（${preview.post} 统计到 ${beijing(preview.at)} 的数据），${args.dryRun ? "再导入" : "这次"}没有变化。`
        : `${args.dryRun ? "会导入" : "已导入"}${preview.platform}的数据到 ${target}${preview.replaces ? "，替换这个时间已有的数据" : ""}：`;
      const lines = [
        head,
        ...(preview.unchanged ? [] : preview.recognized.map((item) => `- ${item.path}：${item.parts.join("、")}`)),
        preview.duplicates.length ? `内容相同的文件只读了一次：${preview.duplicates.map((item) => `${item.path}（= ${item.of}）`).join("、")}` : "",
        preview.unrecognized.length ? `没认出的文件（可以用 review_read 读出来再用 review_write 录入）：${preview.unrecognized.join("、")}` : "",
        preview.unchanged
          ? ""
          : `指标 ${preview.metrics.length} 项${preview.retention ? "，逐秒留存" : ""}${preview.benchmark ? "（含同类作品）" : ""}${preview.series.length ? `，每小时数据 ${preview.series.join("、")}` : ""}${preview.sources ? `，流量来源 ${preview.sources} 项` : ""}${preview.comments ? `，评论 ${preview.comments.threads} 条一级、${preview.comments.replies} 条回复` : ""}`,
        args.dryRun || preview.unchanged ? "" : "用 review_read 看分析结果。",
      ];
      return { data: { preview }, text: lines.filter(Boolean).join("\n") };
    },
  });

  tools.add({
    name: "review_write",
    published: true, // the reviews branch, not the work: allowed on a published work
    title: "记录复盘",
    destructive: true,
    description:
      "记录作品发布后的复盘资料，每次调用自动保存为一个版本。operations 按顺序执行：post 新增或修改发布记录（平台、发布时间、标题和话题、置顶评论、链接、发布的是哪个导出文件、目标）；snapshot 录入一条发布记录截至某个时间的累计数据（metrics、同类作品的值 benchmark、留存曲线 retention 和同类的 retentionBenchmark、流量来源 sources、评论概况；同一时间已有的合并）；series 每小时新增的播放、涨粉等（views、followers，分渠道写 views:抖音精选）；moment 关键时刻（例如反转在第几秒，比较时会看那一刻还剩多少人）；segments 自定义分段（例如画在代码里的镜头、歌词），同种类整体替换；remove_post、remove_snapshot、remove_moment 删除；write / edit / delete / move 修改复盘文档（.md，路径相对作品的复盘文件夹，例如 复盘.md）。平台后台导出的文件优先用 review_import 导入。raw/ 里的原始文件保持原样，不能改。失败的逐项说明原因，只需重试失败的。格式和复盘方法见 frame_guide reviews。",
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
          `${icon[result.status]} ${result.index + 1}. ${result.op}${result.path ? ` ${result.path}` : ""}${result.status === "ok" ? (result.note ? `（${result.note}）` : "") : `：${result.message}`}`,
      );
      const head = !changes.length ? "没有改动" : `已保存（${changes.join("；")}）`;
      const ids = review.posts.map((post) => `${post.id} ${post.platform} ${beijing(post.postedAt)}`).join("、");
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
    description: `把作品发布后的数据放在一起比较：每条发布记录一行，都取发布后同一天数的数据（checkpoint，不写时取大多数发布记录都到了的最大天数；总数会一直涨，不同天数的不能直接比；有每小时数据的播放、涨粉正好算到那一天），比例和留存点旁边并列同类作品的值，作品标了关键时刻的（例如反转）会多一列那一刻还剩多少人，最后给中位数和本作品（▶）是中位数的几倍。可以按平台、作品标签、关联的经验库、发布时间筛选。lyrics: true 时，用同一首歌的作品按歌词对齐比较每一句的倍数（分开歌的影响和画面的影响）。用户想知道作品表现如何、和其他作品比、哪类做法效果更好时用。指标：${metricKeys.join("、")}、moment:<关键时刻>，以及平台特有指标的中文名。`,
    readOnly: true,
    input: {
      work: workArg,
      checkpoint: z
        .enum(Object.keys(CHECKPOINTS))
        .optional()
        .describe("发布后第几天：1d、2d、3d、7d、14d、30d，或 latest（各自最新的数据，天数不同只能粗看）。不写时取大多数发布记录都到了的最大天数"),
      platform: z.string().max(40).optional().describe("只看这个平台"),
      tags: z.array(z.string().max(60)).max(10).optional().describe("只看带这些标签之一的作品（project.ts 的 tags）"),
      experience: z.string().max(60).optional().describe("只看关联了这个经验库的作品（同类作品）"),
      works: z.array(z.string().max(64)).max(50).optional().describe("只看这些作品（id）"),
      since: z.string().max(40).optional().describe("发布时间不早于（ISO 日期）"),
      until: z.string().max(40).optional().describe("发布时间不晚于（ISO 日期）"),
      columns: z
        .array(z.string().max(60))
        .min(1)
        .max(20)
        .optional()
        .describe(`表格里的指标，默认 ${DEFAULT_COLUMNS.join("、")} 加上关键时刻`),
      sort: z.string().max(60).default("views").describe("按这个指标从高到低排"),
      curves: z.boolean().default(false).describe("同时给出各条发布记录的留存曲线和同类的（按视频进度 0–100% 对齐，长短不同的视频也能比）"),
      lyrics: z.boolean().default(false).describe("用同一首歌的作品，按歌词逐句对齐比较倍数"),
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
      const { rows, checkpoint } = await reviews.compare({ repos, ...args });
      const value = (row) => row.metrics[args.sort];
      rows.sort((a, b) => (Number.isFinite(value(b)) ? value(b) : -Infinity) - (Number.isFinite(value(a)) ? value(a) : -Infinity));
      let text = compareText(rows, { checkpoint, columns: args.columns, current: work?.id });
      if (args.curves) {
        const curved = rows.filter((row) => row.curve);
        const at = (points) =>
          points
            .filter((_, index) => index % 5 === 0)
            .map(([progress, kept]) => `${Math.round(progress * 100)}% ${formatPercent(kept)}`)
            .join("，");
        text += curved.length
          ? `\n\n留存曲线（视频进度 → 还在看的比例）：\n${curved
              .map((row) => `${row.title}·${row.platform}：${at(row.curve)}${row.curveBenchmark ? `\n  同类：${at(row.curveBenchmark)}` : ""}`)
              .join("\n")}`
          : "\n\n这些发布记录都没有留存曲线。";
      }
      if (args.lyrics)
        text += `\n\n${lyricsText(rows) || "没有两个以上作品用到同一首歌的歌词（需要作品里的 .lrc 歌词或复盘里写的歌词分段，以及留存和同类曲线）。"}`;
      if (!rows.length)
        text = `没有符合条件的发布记录${work ? "（只看了当前作品所在的作品库）" : ""}。先用 review_import 导入平台数据，或用 review_write 记下发布记录和数据。`;
      return { data: { checkpoint, rows: rows.map(({ curve, curveBenchmark, history, hourly, ...row }) => row) }, text };
    },
  });
}
