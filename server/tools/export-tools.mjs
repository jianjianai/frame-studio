import { z } from "zod";
import { workArg, asJson } from "./registry.mjs";

export function registerExportTools(registry) {
  const { services } = registry;

  registry.add({
    name: "export_video",
    published: true, // writes outside the work: allowed on a published (view-only) work
    title: "导出视频",
    description:
      "在后台把作品导出为 MP4（H.264 + AAC）。导出使用调用时的作品快照，之后的修改不影响本次导出。wait 秒数内等它完成（不用再查进度）；没完成就返回任务 id，用 task_status 查看。",
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
      return asJson(
        { task: task.id, ...done },
        done.status === "done"
          ? `导出完成：${done.result?.name ?? ""}（${done.result?.width}×${done.result?.height}，${done.result?.duration} 秒）`
          : done.status === "failed" || done.error
            ? `导出失败：${done.error}`
            : `还在导出（${Math.round((done.progress ?? 0) * 100)}%），任务 ${task.id}，用 task_status 继续等待`,
      );
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
