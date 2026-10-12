import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { workArg, asJson } from "./registry.mjs";
import { tree } from "../files.mjs";
import { checkWork } from "../checks.mjs";
import { problem, confined } from "../util.mjs";
import { editList, runFileOperations, describeFileOperations } from "./file-ops.mjs";
import { probe } from "../media.mjs";
import { projectAudioTracks } from "../../src/engine/types.ts";
import { formatTime } from "../render.mjs";
import { readVisual, readAudio } from "../documents.mjs";

/** What would run past a new, shorter length: layers, audio clips, subtitles, the cover moment. */
function pastEnd(work, meta, duration) {
  const over = [];
  const end = (start, length) => +(start + length).toFixed(3);
  try {
    for (const clip of readVisual(work).document.clips) if (clip.start + clip.duration > duration + 1e-6) over.push(`图层「${clip.id}」到 ${end(clip.start, clip.duration)} 秒`);
  } catch {}
  try {
    for (const clip of readAudio(work).document?.clips ?? []) if (clip.start + clip.duration > duration + 1e-6) over.push(`音频片段「${clip.id}」到 ${end(clip.start, clip.duration)} 秒`);
  } catch {}
  for (const cue of meta.subtitles ?? []) if (cue.end > duration + 1e-6) over.push(`字幕「${cue.text}」到 ${cue.end} 秒`);
  if (meta.posterTime !== undefined && meta.posterTime >= duration) over.push(`封面时间 ${meta.posterTime} 秒`);
  return over;
}

const cueSchema = z
  .strictObject({ start: z.number().nonnegative(), end: z.number().positive(), text: z.string().min(1).max(500) })
  .refine((cue) => cue.end > cue.start, "end 必须大于 start");

// Paths are relative to projects/<名称>/ (the tool descriptions say so once, not per field).
const relativePath = z.string().min(1).max(400);

export async function listAssets(work) {
  const base = path.join(work.dir, "public");
  if (!fs.existsSync(base)) return [];
  const items = [];
  for (const entry of tree(base)) {
    if (entry.type !== "file") continue;
    const info = await probe(path.join(base, entry.path));
    // The version of the file, for thumbnails the studio draws (models, Lottie, panoramas, fonts).
    const version = `${entry.size.toString(36)}-${Math.floor(entry.mtime).toString(36)}`;
    items.push({ path: "public/" + entry.path, url: `films/${work.slug}/${entry.path}`, ...info, version });
  }
  return items;
}

function summarizeMeta(meta) {
  const size = meta.composition || { width: 1920, height: 1080 };
  return {
    title: meta.title,
    subtitle: meta.subtitle,
    description: meta.description,
    renderer: meta.renderer,
    width: size.width,
    height: size.height,
    duration: meta.duration,
    fps: meta.fps,
    beats: meta.beats,
    subtitles: meta.subtitles?.length ? meta.subtitles : [],
    status: meta.status,
  };
}

/**
 * The work against GitHub. An external AI is compared now (it starts with work_context, like
 * opening the work in the studio); built-in sessions are told about changes with each message.
 */
async function githubState(services, work, { compare }) {
  const sync = services.remoteSync;
  if (!sync || !services.repos.get(work.repo)?.remote) return null;
  if (!compare) return sync.get(work);
  const late = new Promise((resolve) => setTimeout(() => resolve(sync.get(work) ?? { state: "unknown" }), 8000).unref());
  return Promise.race([sync.check(work).catch(() => sync.get(work)), late]);
}

export function registerWorkTools(registry) {
  const { services } = registry;
  const { works } = services;

  registry.add({
    name: "works_list",
    title: "列出作品",
    description: "列出所有作品库中的作品（id、标题、时长、尺寸、更新时间）。",
    readOnly: true,
    input: { repo: z.string().optional().describe("只列出这个作品库"), query: z.string().optional().describe("按标题过滤") },
    async run({ repo, query }) {
      let list = await works.list({ repo });
      if (query) list = list.filter((item) => item.title.toLowerCase().includes(query.toLowerCase()));
      return asJson(
        list.map(({ id, repo, title, duration, width, height, fps, updatedAt, location }) => ({
          id,
          repo,
          title,
          duration,
          width,
          height,
          fps,
          updatedAt,
          location,
        })),
      );
    },
  });

  registry.add({
    name: "work_create",
    title: "新建作品",
    description: "新建一个空白作品（含一个可删除的标题图层），返回作品 id。新作品是 Git 分支 works/<id>。",
    input: {
      title: z.string().min(1).max(120),
      description: z.string().max(4000).optional().describe("需求描述，会写入作品 AGENTS.md"),
      repo: z.string().optional().describe("作品库 id（works_list 结果里的 repo），默认 local。素材库属于作品库，要用哪个作品库的素材库就建在哪里"),
      width: z.number().int().min(16).max(7680).optional(),
      height: z.number().int().min(16).max(7680).optional(),
      duration: z.number().positive().max(3600).optional(),
      fps: z.number().int().min(12).max(60).optional(),
    },
    async run(args, ctx) {
      if (ctx.scope.work) throw problem(403, "作品内的 AI 会话不能新建其他作品", "FORBIDDEN");
      const work = await works.create(args);
      // Libraries belong to a repository: say which one the work landed in and what it can use.
      const libraries = services.materials ? await services.materials.libraries(work.repo).catch(() => []) : [];
      const others = services.repos.list().map((repo) => repo.id).filter((id) => id !== work.repo);
      return asJson({ id: work.id, repo: work.repo, dir: work.dir, materials: libraries.map((item) => item.id) }, [
        `已创建作品 ${work.id}（${args.title}），在作品库 ${work.repo}${args.repo ? "" : "（没有指定 repo，用的是默认作品库）"}。作品文件位于 ${work.dir}`,
        libraries.length
          ? `这个作品库的素材库：${libraries.map((item) => `「${item.id}」`).join("")}（作品只能用同一作品库里的素材库）`
          : `这个作品库没有素材库（作品只能用同一作品库里的素材库）${others.length ? `。其他作品库：${others.join("、")}；要用它们的素材库，就在那个作品库里新建作品（repo 参数）` : ""}`,
      ].join("\n"));
    },
  });

  registry.add({
    name: "work_copy",
    published: true, // copying a published (view-only) work is how it gets edited again
    title: "复制作品",
    description:
      "把一个作品完整复制成新作品（代码、图层、混音、字幕、素材和锁定的素材库版本），在同一个作品库里，返回新作品 id。做另一个版本（例如竖屏版、换文案）时用它，再在副本上修改；width/height 同时改副本的画面尺寸（图层位置是比例会跟着变，场景代码要按 options.width/height 重新排版）。",
    input: {
      work: workArg,
      title: z.string().min(1).max(120).optional().describe("副本的标题，默认「原标题（副本）」"),
      width: z.number().int().min(16).max(7680).optional(),
      height: z.number().int().min(16).max(7680).optional(),
    },
    async run({ title, width, height }, ctx) {
      if (ctx.scope.work) throw problem(403, "作品内的 AI 会话不能新建其他作品", "FORBIDDEN");
      const source = await ctx.work();
      const copy = await works.duplicate(source, { title });
      if (width || height) {
        const meta = works.meta(copy);
        const current = (meta.ok && meta.meta.composition) || { width: 1920, height: 1080 };
        await works.update(copy, { composition: { width: width ?? current.width, height: height ?? current.height } });
      }
      const meta = works.meta(copy);
      const size = meta.ok && meta.meta.composition;
      return asJson(
        { id: copy.id, repo: copy.repo, dir: copy.dir },
        `已复制为作品 ${copy.id}（${meta.ok ? meta.meta.title : title ?? ""}${size ? `，${size.width}×${size.height}` : ""}），在作品库 ${copy.repo}。之后的工具调用写 work: "${copy.repo}/${copy.id}"`,
      );
    },
  });

  registry.add({
    name: "work_context",
    title: "作品现状",
    description:
      "读取作品的元数据、文件、素材（地址、类型、时长、尺寸）、图层与音轨概要、未保存的修改、用户在播放器中正在看的位置/选区、最近一次检查结果、最近的导出、作品需求和关联的经验库、作品库里的素材库（各有哪些资源和音效）、发布后的复盘数据概要，以及是否已发布、和 GitHub 是否同步（warnings 里的情况要先处理）。外部 AI 开始工作前先调用。",
    readOnly: true,
    input: { work: workArg },
    async run(_, ctx) {
      const work = await ctx.work();
      const meta = works.meta(work);
      const files = tree(work.dir)
        .filter((entry) => entry.type === "file" && !entry.path.startsWith("public/"))
        .map((entry) => entry.path);
      const assets = await listAssets(work);
      const status = await works.status(work);
      const view = services.viewState.get(`${work.repo}/${work.id}`) || null;
      const notesFile = path.join(work.dir, "AGENTS.md");
      const publishedAt = works.published(work);
      const github = await githubState(services, work, { compare: !ctx.scope.session });
      const warnings = [
        publishedAt && "作品已发布，只能查看：不能修改作品文件、图层、混音和它关联的经验库/素材库（经验库、素材库本身可以照常整理）。要修改，请用户先取消发布或创建副本。",
        github?.state === "behind" &&
          `GitHub 上有这个作品 ${github.behind} 个更新的版本，本机的文件还是旧的。不要修改作品：请用户先在工作台顶部的提示中更新到最新版本。`,
        ["diverged", "conflict"].includes(github?.state) &&
          `本机和 GitHub 上都有这个作品的新版本（本机 ${github.ahead} 个、GitHub ${github.behind} 个）。不要修改作品：请用户先在工作台顶部的提示中选择合并、采用 GitHub 或保留本机的版本。`,
      ].filter(Boolean);
      const result = {
        ...(warnings.length ? { warnings } : {}),
        // The folder only helps an AI on the studio's own computer (a server's path leads an outside AI astray).
        work: { id: work.id, repo: work.repo, slug: work.slug, ...(services.auth.required && !ctx.scope.session ? {} : { dir: work.dir }), branch: work.branch, published: Boolean(publishedAt), github: github && github.state },
        meta: meta.ok ? summarizeMeta(meta.meta) : { error: meta.error },
        entry: meta.ok ? meta.loads : null,
        layers:
          meta.ok && meta.meta.visual
            ? meta.meta.visual.clips.map((clip) => ({
                id: clip.id,
                name: clip.name,
                source: clip.source.kind === "scene" ? `scene:${clip.source.module}` : clip.source.kind + (clip.source.src ? `:${clip.source.src}` : ""),
                start: clip.start,
                duration: clip.duration,
                hidden: clip.hidden,
              }))
            : null,
        audio: meta.ok
          ? projectAudioTracks(meta.meta).map((track) => ({
              id: track.id,
              name: track.name,
              kind: track.kind,
              src: track.src,
              start: track.start ?? 0,
              duration: track.duration,
              gain: track.gain ?? 1,
              muted: track.muted,
            }))
          : null,
        files,
        assets: assets.map(({ url, kind, size, duration, width, height, animations, triangles, problem }) => ({ url, kind, size, duration, width, height, animations, triangles, problem })),
        // Built-in agents have the work's notes and its experience libraries in their session brief.
        ...(ctx.scope.session ? {} : { notes: fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8").slice(0, 6000) : "" }),
        unsavedChanges: status.files.map((file) => `${file.status} ${file.path}`),
        lastVersion: status.head,
        userView: view && { time: view.time, playing: view.playing, selection: view.selection, at: view.at },
        lastCheck: services.checks.get(`${work.repo}/${work.id}`) || null,
        exports: services.exports
          .list(work)
          .slice(0, 5)
          .map(({ name, createdAt, duration, width, height, size }) => ({ name, createdAt, duration, width, height, size })),
        // The production know-how to follow; read it in full with experience_read.
        experiences: services.experience ? services.experience.summary(work, { inBrief: Boolean(ctx.scope.session) }) : null,
        // What the shared libraries hold (resources, sounds) and whether they fit this picture.
        materials: services.resources ? await services.resources.librariesFor(work).catch(() => null) : null,
        // Where the work was posted and how it did (only when there is review data).
        ...(services.reviews ? { reviews: await services.reviews.summary(work).catch(() => null) } : {}),
      };
      return asJson(result);
    },
  });

  registry.add({
    name: "work_check",
    title: "检查作品",
    description:
      "检查 project.ts 元数据、TypeScript 类型、素材引用，并在浏览器中实际加载、渲染几帧（开头、1/4、1/2、3/4、结尾）和一小段音频。返回所有问题。修改代码后调用；frames: true 同时返回这 5 个时刻的分镜图。",
    readOnly: true,
    input: {
      work: workArg,
      runtime: z.boolean().default(true).describe("是否在浏览器中实际加载（较慢但能发现运行错误）"),
      frames: z.boolean().default(false).describe("同时返回检查时渲染的 5 个时刻的分镜图"),
    },
    async run({ runtime, frames }, ctx) {
      const work = await ctx.work();
      const { sheet, sheetTimes, ...result } = await checkWork(services, work, { runtime, frames: frames && runtime });
      const lines = result.problems.map((p) => `- [${p.source}] ${p.file ? p.file + (p.line ? `:${p.line}` : "") + " " : ""}${p.message}`);
      // Console output does not fail a check, but the AI should see it (it only reads `text`).
      const logged = [...new Set((result.console ?? []).map((line) => String(line).slice(0, 300)))];
      const consoleLines = logged.length
        ? `\n浏览器控制台（${logged.length} 条，不影响通过）：\n${logged.slice(0, 5).map((line) => "- " + line).join("\n")}`
        : runtime && result.ok
          ? "浏览器控制台没有警告和错误。"
          : "";
      const text = (result.ok
        ? `检查通过（${result.ms} ms）。${lines.length ? "\n警告：\n" + lines.join("\n") : ""}`
        : `发现 ${result.problems.length} 个问题：\n${lines.join("\n")}`) + consoleLines;
      return {
        ...asJson(result, sheet ? `${text}\n分镜（${sheetTimes.map((time, index) => `#${index + 1} ${formatTime(time)}`).join("，")}）见附图。` : text),
        images: sheet ? [{ data: sheet, mimeType: "image/jpeg" }] : [],
      };
    },
  });

  // ---- files --------------------------------------------------------------

  registry.add({
    name: "files_list",
    title: "列出文件",
    description: "列出作品目录中的文件和大小（不含 exports、.cache）。素材的类型、时长、尺寸见 work_context 的 assets。",
    readOnly: true,
    input: { work: workArg, dir: z.string().optional().describe("子目录（相对 projects/<名称>/），例如 public") },
    async run({ dir }, ctx) {
      const work = await ctx.work();
      const base = dir ? confined(work.dir, dir) : work.dir;
      return asJson(tree(base).map((entry) => ({ path: (dir ? dir.replace(/\/$/, "") + "/" : "") + entry.path, type: entry.type, size: entry.size })));
    },
  });

  const batchOperation = z.discriminatedUnion("op", [
    z.strictObject({ op: z.literal("read"), path: relativePath, startLine: z.number().int().min(1).optional(), lineCount: z.number().int().min(1).max(5000).optional() }),
    z.strictObject({ op: z.literal("write"), path: relativePath, content: z.string().max(4 * 1024 * 1024), expectedSha256: z.string().optional() }),
    z.strictObject({ op: z.literal("edit"), path: relativePath, edits: editList }),
    z.strictObject({ op: z.literal("delete"), path: relativePath }),
    z.strictObject({ op: z.literal("move"), from: relativePath, to: relativePath }),
  ]);

  registry.add({
    name: "files_batch",
    published: true, // reads are fine on a published work; changes are refused below
    title: "读写文件",
    description:
      "读写作品中的文本文件（代码、JSON、SVG 等；路径相对作品目录 projects/<名称>/，例如 scene.ts、public/bg.svg），一次调用可以做多个操作，按顺序执行：read（可用 startLine/lineCount 读一段，返回内容和 sha256）、write（新建或整体替换，自动建文件夹；expectedSha256 可防止覆盖别人刚做的修改）、edit（精确替换：每个 oldText 必须与文件逐字一致含缩进，且恰好出现一次，否则设 replaceAll）、delete、move。保存后用户的预览立即更新。默认能做的都做，失败的逐项说明原因（同一文件前面的操作失败时，后面针对它的操作会跳过），只需重试失败的；atomic: true 时任何一项失败就全部不改。check: true 改完后运行 work_check，frames: true 再附 5 个时刻的分镜图。",
    destructive: true,
    input: {
      work: workArg,
      operations: z.array(batchOperation).min(1).max(100),
      atomic: z.boolean().default(false),
      check: z.boolean().default(false).describe("写入后再运行 work_check；检查不通过时文件已经写入（不会回滚），按报错继续修改，或 version_restore"),
      frames: z.boolean().default(false),
    },
    async run({ operations, atomic, check, frames }, ctx) {
      const work = await ctx.work();
      if (operations.some((item) => item.op !== "read")) works.assertEditable(work);
      const outcome = runFileOperations(work.dir, operations, {
        atomic,
        reader: "files_batch 的 read",
        allow: (item, paths) => {
          if (item.op !== "read" && paths.some((file) => file.split("/")[0] === "exports")) throw problem(400, "exports/ 是导出目录");
          if (item.op === "delete" && item.path === "project.ts") throw problem(400, "不能删除 project.ts");
        },
      });
      const { summary, reads } = describeFileOperations(outcome);
      const checked = check && outcome.wrote ? await checkWork(services, work, { runtime: true, frames }) : null;
      const checkText = checked
        ? checked.ok
          ? `\n检查通过（${checked.ms} ms）。`
          : `\n检查发现 ${checked.problems.length} 个问题：\n${checked.problems.map((p) => `- [${p.source}] ${p.file ? p.file + (p.line ? `:${p.line}` : "") + " " : ""}${p.message}`).join("\n")}`
        : "";
      return {
        data: {
          applied: outcome.applied,
          results: outcome.results.map(({ content, ...result }) => result),
          ...(checked ? { check: { ok: checked.ok, problems: checked.problems } } : {}),
        },
        text: summary + checkText + (reads ? "\n\n" + reads : ""),
        images: checked?.sheet ? [{ data: checked.sheet, mimeType: "image/jpeg" }] : [],
      };
    },
  });

  // ---- versions -----------------------------------------------------------

  registry.add({
    name: "versions_list",
    title: "版本历史",
    description: "列出作品的版本（Git 提交），以及当前未保存的修改。",
    readOnly: true,
    input: { work: workArg, limit: z.number().int().min(1).max(200).default(30) },
    async run({ limit }, ctx) {
      const work = await ctx.work();
      const [history, status] = await Promise.all([works.history(work, { limit }), works.status(work)]);
      return asJson({ unsaved: status.files, versions: history });
    },
  });

  registry.add({
    name: "version_save",
    title: "保存版本",
    description: "把当前全部修改保存为一个版本（Git 提交）。",
    input: { work: workArg, message: z.string().min(1).max(200).describe("版本说明，200 字以内") },
    async run({ message }, ctx) {
      const commit = await works.commit(await ctx.work(), message);
      return asJson({ commit }, commit ? `已保存版本 ${commit.slice(0, 7)}` : "没有需要保存的修改");
    },
  });

  registry.add({
    name: "version_diff",
    title: "查看改动",
    description: "查看未保存的改动（不传 commit）或某个版本相对上一版本的改动（统一 diff 格式）。",
    readOnly: true,
    input: { work: workArg, commit: z.string().optional(), file: z.string().optional() },
    async run({ commit, file }, ctx) {
      const work = await ctx.work();
      const diff = await works.diff(work, { commit, file: file ? `projects/${work.slug}/${file}` : undefined });
      return { data: { commit: commit || null }, text: diff.length > 200000 ? diff.slice(0, 200000) + "\n…(已截断)" : diff || "没有改动" };
    },
  });

  registry.add({
    name: "version_restore",
    title: "恢复版本",
    description: "把作品恢复到某个版本的状态（作为新版本保存，历史不会丢失）。",
    destructive: true,
    input: { work: workArg, commit: z.string().min(4) },
    async run({ commit }, ctx) {
      const result = await works.revert(await ctx.work(), commit);
      return asJson({ commit: result }, `已恢复到 ${commit.slice(0, 7)}`);
    },
  });

  registry.add({
    name: "work_delete",
    published: true, // only a mark beside the work: also for published works
    title: "请求删除作品",
    description:
      "请求删除作品。只做标记，作品不会被删除也不会改动：用户在首页作品列表中看到「AI 请求删除」和你写的原因，确认后作品才移到回收站（可以恢复），也可以选择保留。用户明确要删除作品时使用；cancel: true 撤回请求。",
    input: {
      work: workArg,
      reason: z.string().max(300).default("").describe("为什么删除，显示给用户"),
      cancel: z.boolean().default(false),
    },
    async run({ reason, cancel }, ctx) {
      const work = await ctx.work();
      if (cancel) {
        const cleared = works.clearDeleteRequest(work.repo, work.id);
        return asJson({ requested: false }, cleared ? "已撤回删除请求" : "这个作品没有删除请求");
      }
      const request = works.requestDelete(work, reason);
      return asJson(
        { requested: true, ...request },
        "已标记为「AI 请求删除」，作品还在。请告诉用户：在首页作品列表中确认删除（移到回收站，可以恢复）或保留。",
      );
    },
  });

  registry.add({
    name: "work_update",
    title: "修改作品信息",
    description: "修改 project.ts 中的标题、副标题、描述、时长、帧率、节拍（tempo）、镜头标记、封面画面、字幕样式（subtitleStyle），只替换字段值、保留文件其余内容。字幕内容用 subtitles_edit。",
    input: {
      work: workArg,
      title: z.string().min(1).max(120).optional(),
      subtitle: z.string().max(200).optional(),
      description: z.string().max(4000).optional(),
      duration: z.number().positive().max(3600).optional(),
      fps: z.number().int().min(12).max(60).optional(),
      beats: z
        .array(z.strictObject({ at: z.number().nonnegative(), title: z.string(), detail: z.string().default(""), id: z.string().optional() }))
        .max(200)
        .optional()
        .describe("镜头标记（整体替换），显示在时间轴上，方便和用户指代片段"),
      posterTime: z.number().nonnegative().optional().describe("封面用这一秒的画面（替换上传的封面图片）"),
      tempo: z
        .strictObject({ bpm: z.number().min(20).max(400), firstBeat: z.number().nonnegative().default(0), beatsPerBar: z.number().int().min(1).max(16).default(4) })
        .optional()
        .describe("配乐的节拍：BPM、第一小节第一拍在作品里的秒数、每小节拍数（preview_audio 的 beats 给出）。代码和素材库资源用 @frame/engine/tempo 的 beatAt / barAt 跟着它卡点"),
      width: z.number().int().min(16).max(7680).optional().describe("画面宽度（像素）：改横竖屏或尺寸。图层的位置和大小是比例，跟着变；场景代码要按 options.width/height 画"),
      height: z.number().int().min(16).max(7680).optional().describe("画面高度（像素）"),
      subtitleStyle: z
        .strictObject({ size: z.number().min(0.01).max(0.08).optional(), y: z.number().min(0.05).max(0.95).optional() })
        .optional()
        .describe("字幕的样式：size 字高占画面长边的比例（默认 0.022，竖屏短视频常用 0.03–0.035），y 字幕中线的位置（0.05 顶部 – 0.95 底部，默认 0.92）"),
    },
    async run({ work: _ignored, posterTime, width, height, ...changes }, ctx) {
      const work = await ctx.work();
      const current = works.meta(work);
      if (changes.duration !== undefined && current.ok && changes.duration < current.meta.duration) {
        // A shorter work with layers past its end would not load: say what to shorten first.
        const over = pastEnd(work, current.meta, changes.duration);
        if (over.length)
          throw problem(400, `时长改成 ${changes.duration} 秒后，这些会超出结尾：${over.slice(0, 12).join("；")}${over.length > 12 ? ` 等 ${over.length} 项` : ""}。先用 layers_edit / audio_edit / subtitles_edit 缩短或删除它们，再改时长`);
      }
      if (width || height) {
        const before = works.meta(work);
        const current = (before.ok && before.meta.composition) || { width: 1920, height: 1080 };
        changes.composition = { width: width ?? current.width, height: height ?? current.height };
      }
      await works.update(work, changes);
      if (posterTime !== undefined) {
        services.covers.useFrame(work, posterTime);
        changes.posterTime = posterTime;
      }
      const meta = works.meta(work);
      const tempo = meta.ok && meta.meta.tempo;
      const size = meta.ok && meta.meta.composition;
      const after = meta.ok
        ? `。现在：${meta.meta.title}，${size ? `${size.width}×${size.height}，` : ""}${meta.meta.duration} 秒，${meta.meta.fps} fps${tempo ? `，节拍 ${tempo.bpm} BPM（第一小节第一拍 ${tempo.firstBeat} 秒，每小节 ${tempo.beatsPerBar} 拍）` : ""}`
        : "";
      return asJson(changes, `已更新 ${Object.keys(changes).join("、") || "（无改动）"}${after}`);
    },
  });

  registry.add({
    name: "subtitles_edit",
    title: "编辑字幕",
    description:
      "编辑 project.ts 的字幕（播放器绘制在画面底部，导出时可烧录）。set 整体替换；add 追加（与已有字幕时间重叠的旧字幕会被替换）；removeBetween 删除与某时间段重叠的字幕。返回全部字幕。",
    input: {
      work: workArg,
      set: z.array(cueSchema).max(2000).optional(),
      add: z.array(cueSchema).max(500).optional(),
      removeBetween: z.strictObject({ start: z.number().nonnegative(), end: z.number().positive() }).optional(),
    },
    async run({ set, add, removeBetween }, ctx) {
      const work = await ctx.work();
      const meta = works.meta(work);
      if (!meta.ok) throw problem(422, "project.ts 无法读取：" + meta.error);
      const overlaps = (cue, start, end) => cue.start < end && cue.end > start;
      if (removeBetween && !(removeBetween.end > removeBetween.start))
        throw problem(400, `removeBetween 的 end 必须大于 start（收到 ${removeBetween.start}–${removeBetween.end}），没有删除任何字幕`);
      // Overlapping cues would show only one of them: refuse a set that has some.
      const sorted = [...(set ?? [])].sort((a, b) => a.start - b.start);
      const clash = sorted.find((cue, index) => index && cue.start < sorted[index - 1].end);
      if (clash) {
        const before = sorted[sorted.indexOf(clash) - 1];
        throw problem(400, `set 里的字幕时间重叠：「${before.text}」${before.start}–${before.end} 秒和「${clash.text}」${clash.start}–${clash.end} 秒（同一时刻只显示一条）`);
      }
      let cues = set ?? meta.meta.subtitles ?? [];
      if (removeBetween) cues = cues.filter((cue) => !overlaps(cue, removeBetween.start, removeBetween.end));
      for (const cue of add ?? []) cues = [...cues.filter((old) => !overlaps(old, cue.start, cue.end)), cue];
      cues = cues.map(({ start, end, text }) => ({ start, end, text })).sort((a, b) => a.start - b.start);
      const late = cues.find((cue) => cue.end > meta.meta.duration + 1e-7);
      if (late) throw problem(400, `字幕「${late.text}」结束于 ${late.end} 秒，超过作品时长 ${meta.meta.duration} 秒`);
      await works.update(work, { subtitles: cues });
      return asJson(
        { subtitles: cues },
        `共 ${cues.length} 条字幕：\n` + cues.map((cue) => `${formatTime(cue.start)}–${formatTime(cue.end)} ${cue.text}`).join("\n"),
      );
    },
  });
}
