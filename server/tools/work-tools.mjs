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
    items.push({ path: "public/" + entry.path, url: `films/${work.slug}/${entry.path}`, ...info });
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
      repo: z.string().optional().describe("作品库 id，默认 local"),
      width: z.number().int().min(16).max(7680).optional(),
      height: z.number().int().min(16).max(7680).optional(),
      duration: z.number().positive().max(3600).optional(),
      fps: z.number().int().min(12).max(60).optional(),
    },
    async run(args, ctx) {
      if (ctx.scope.work) throw problem(403, "作品内的 AI 会话不能新建其他作品", "FORBIDDEN");
      const work = await works.create(args);
      return asJson({ id: work.id, repo: work.repo, dir: work.dir }, `已创建作品 ${work.id}（${args.title}）。作品文件位于 ${work.dir}`);
    },
  });

  registry.add({
    name: "work_context",
    title: "作品现状",
    description:
      "读取作品的元数据、文件、素材（地址、类型、时长、尺寸）、图层与音轨概要、未保存的修改、用户在播放器中正在看的位置/选区、最近一次检查结果、最近的导出、作品需求和关联的经验库、作品库里的素材库（各有哪些资源和音效），以及是否已发布、和 GitHub 是否同步（warnings 里的情况要先处理）。外部 AI 开始工作前先调用。",
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
        assets: assets.map(({ url, kind, size, duration, width, height }) => ({ url, kind, size, duration, width, height })),
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
      const text = result.ok
        ? `检查通过（${result.ms} ms）。${lines.length ? "\n警告：\n" + lines.join("\n") : ""}`
        : `发现 ${result.problems.length} 个问题：\n${lines.join("\n")}`;
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
      check: z.boolean().default(false),
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
    input: { work: workArg, message: z.string().min(1).max(200) },
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
    description: "修改 project.ts 中的标题、副标题、描述、时长、帧率、节拍（tempo）、镜头标记、封面画面，只替换字段值、保留文件其余内容。字幕用 subtitles_edit。",
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
    },
    async run({ work: _ignored, posterTime, ...changes }, ctx) {
      const work = await ctx.work();
      await works.update(work, changes);
      if (posterTime !== undefined) {
        services.covers.useFrame(work, posterTime);
        changes.posterTime = posterTime;
      }
      const meta = works.meta(work);
      const tempo = meta.ok && meta.meta.tempo;
      const after = meta.ok
        ? `。现在：${meta.meta.title}，${meta.meta.duration} 秒，${meta.meta.fps} fps${tempo ? `，节拍 ${tempo.bpm} BPM（第一小节第一拍 ${tempo.firstBeat} 秒，每小节 ${tempo.beatsPerBar} 拍）` : ""}`
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
