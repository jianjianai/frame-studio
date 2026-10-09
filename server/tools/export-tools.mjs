import { z } from "zod";
import { workArg, asJson } from "./registry.mjs";

export function registerExportTools(registry) {
  const { services } = registry;

  /** Where a finished export can be fetched: a download address, and the file itself on this machine. */
  const delivery = (work, result) => {
    if (!result?.name) return { text: "", data: {} };
    const file = services.exports.file(work, result.name);
    const link = services.downloads?.link(file, result.name);
    const local = !services.auth.required;
    return {
      data: { ...(link ? { download: link.url } : {}), ...(local ? { file } : {}) },
      text: `${link ? `\n下载地址（${link.expiresInMinutes} 分钟内有效，可以给用户，也可以用 curl -fLo <文件名> '<地址>' 下载）：${link.url}` : ""}${local ? `\n本机文件：${file}` : ""}`,
    };
  };
  const finished = (work, task) => {
    if (task.status === "done") {
      const out = delivery(work, task.result);
      return { data: out.data, text: `导出完成：${task.result?.name ?? ""}（${task.result?.width}×${task.result?.height}，${task.result?.duration} 秒）${out.text}` };
    }
    if (task.status === "failed" || task.error) return { data: {}, text: `导出失败：${task.error}` };
    return { data: {}, text: `还在导出（${Math.round((task.progress ?? 0) * 100)}%），任务 ${task.id}，用 task_status 继续等待` };
  };

  registry.add({
    name: "export_video",
    published: true, // writes outside the work: allowed on a published (view-only) work
    title: "导出视频",
    description:
      "在后台把作品导出为 MP4（H.264 + AAC）。导出使用调用时的作品快照，之后的修改不影响本次导出。wait 秒数内等它完成（不用再查进度）；完成时返回下载地址（1 小时内有效），没完成就返回任务 id，用 task_status 查看。以前的导出列在 work_context 的 exports 中。",
    input: {
      work: workArg,
      width: z.number().int().min(16).max(3840).multipleOf(2).optional().describe("输出宽度，默认长边 1920"),
      fps: z.number().int().min(12).max(60).optional(),
      start: z.number().nonnegative().optional(),
      end: z.number().positive().optional(),
      subtitles: z.boolean().default(true),
      wait: z.number().min(0).max(600).default(0).describe("最多等待的秒数，导出完成就返回结果"),
    },
    async run(options, ctx) {
      const work = await ctx.work();
      const { work: _w, wait, ...rest } = options;
      const task = services.exports.start(work, rest);
      if (!wait) return asJson({ task: task.id }, `已开始导出，任务 ${task.id}`);
      const done = await services.tasks.wait(task.id, wait * 1000);
      const out = finished(work, done);
      return asJson({ task: task.id, ...done, ...out.data }, out.text);
    },
  });

  registry.add({
    name: "task_status",
    title: "任务状态",
    description: "查询后台任务（导出、模型下载等）的状态与进度；wait 秒数内等待其完成。导出完成时返回下载地址。",
    readOnly: true,
    input: { id: z.string(), wait: z.number().min(0).max(600).default(0) },
    async run({ id, wait }, ctx) {
      const task = wait ? await services.tasks.wait(id, wait * 1000) : services.tasks.get(id);
      if (task.kind === "export" && task.work) {
        const work = await ctx.work(task.repo ? `${task.repo}/${task.work}` : task.work);
        const out = finished(work, task);
        return asJson({ ...task, ...out.data }, `${task.title}：${out.text}`);
      }
      return asJson(
        task,
        `${task.title}：${task.status}${task.progress != null ? ` ${Math.round(task.progress * 100)}%` : ""}${task.error ? `，错误：${task.error}` : ""}`,
      );
    },
  });
}
