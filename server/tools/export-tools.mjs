import { z } from "zod";
import { workArg, asJson } from "./registry.mjs";

export function registerExportTools(registry) {
  const { services } = registry;

  registry.add({
    name: "export_video",
    published: true, // writes outside the work: allowed on a published (view-only) work
    title: "导出视频",
    description: "在后台把作品导出为 MP4（H.264 + AAC）。导出使用调用时的作品快照，之后的修改不影响本次导出。返回任务 id，用 task_status 查看进度。",
    input: {
      work: workArg,
      width: z.number().int().min(16).max(3840).multipleOf(2).optional().describe("输出宽度，默认长边 1920"),
      fps: z.number().int().min(12).max(60).optional(),
      start: z.number().nonnegative().optional(),
      end: z.number().positive().optional(),
      subtitles: z.boolean().default(true),
    },
    async run(options, ctx) {
      const work = await ctx.work();
      const { work: _w, ...rest } = options;
      const task = services.exports.start(work, rest);
      return asJson({ task: task.id }, `已开始导出，任务 ${task.id}`);
    },
  });

  registry.add({
    name: "task_status",
    title: "任务状态",
    description: "查询后台任务（导出、模型下载等）的状态与进度；wait 秒数内等待其完成。",
    readOnly: true,
    input: { id: z.string(), wait: z.number().min(0).max(600).default(0) },
    async run({ id, wait }) {
      const task = wait ? await services.tasks.wait(id, wait * 1000) : services.tasks.get(id);
      return asJson(
        task,
        `${task.title}：${task.status}${task.progress != null ? ` ${Math.round(task.progress * 100)}%` : ""}${task.error ? `，错误：${task.error}` : ""}`,
      );
    },
  });

  registry.add({
    name: "exports_list",
    title: "导出列表",
    description: "列出作品已经导出的视频文件。",
    readOnly: true,
    input: { work: workArg },
    async run(_, ctx) {
      return asJson(services.exports.list(await ctx.work()));
    },
  });
}
