import { z } from "zod";
import sharp from "sharp";
import { workArg, asJson } from "./registry.mjs";
import { formatTime } from "../render.mjs";

const seconds = z.number().finite().nonnegative();

export function registerPreviewTools(registry) {
  const { services } = registry;

  registry.add({
    name: "preview_frames",
    title: "查看画面",
    description: "在浏览器中渲染指定绝对时间（秒）的画面并返回图片，用来亲眼确认修改效果。一次最多 8 张；要看整体节奏用 storyboard。",
    readOnly: true,
    input: {
      work: workArg,
      times: z.array(seconds).min(1).max(8),
      width: z.number().int().min(160).max(1920).multipleOf(2).default(960).describe("输出宽度（像素），高度按画幅计算"),
      subtitles: z.boolean().default(true),
    },
    async run({ times, width, subtitles }, ctx) {
      const work = await ctx.work();
      const result = await services.renderer.frames(work, { times, width, subtitles });
      const images = await Promise.all(
        result.frames.map(async (frame) => ({
          data: await sharp(frame.png).jpeg({ quality: 82 }).toBuffer(),
          mimeType: "image/jpeg",
          label: formatTime(frame.time),
        })),
      );
      const notes = [`${result.width}×${result.height}，时间：${result.frames.map((frame) => formatTime(frame.time)).join("、")}`];
      if (result.errors.length) notes.push("渲染时出现错误：\n" + result.errors.join("\n"));
      return {
        data: { times: result.frames.map((frame) => frame.time), width: result.width, height: result.height, errors: result.errors },
        text: notes.join("\n"),
        images,
      };
    },
  });

  registry.add({
    name: "storyboard",
    title: "分镜总览",
    description: "把多个时间点的画面拼成一张带时间标注的总览图。不传 times 时按 count 在全片均匀取样（默认 12 张）。",
    readOnly: true,
    input: {
      work: workArg,
      times: z.array(seconds).min(1).max(36).optional(),
      count: z.number().int().min(2).max(36).default(12),
      columns: z.number().int().min(1).max(8).optional(),
      start: seconds.optional().describe("只看这一段：开始秒数"),
      end: seconds.optional().describe("只看这一段：结束秒数"),
    },
    async run({ times, count, columns, start, end }, ctx) {
      const work = await ctx.work();
      const meta = services.works.meta(work);
      const duration = meta.ok ? meta.meta.duration : 10;
      if (!times) {
        const from = start ?? 0,
          to = Math.min(end ?? duration, duration);
        times = Array.from({ length: count }, (_, index) => from + ((to - from) * (index + 0.5)) / count);
      }
      const width = (columns ?? Math.min(4, Math.ceil(Math.sqrt(times.length)))) > 4 ? 320 : 480;
      const { image, times: rendered, errors } = await services.renderer.storyboard(work, { times, columns, width });
      return {
        data: { times: rendered, errors },
        text: `分镜 ${rendered.length} 张：${rendered.map((time, index) => `#${index + 1} ${formatTime(time)}`).join("，")}${errors.length ? "\n错误：\n" + errors.join("\n") : ""}`,
        images: [{ data: image, mimeType: "image/jpeg" }],
      };
    },
  });

  registry.add({
    name: "preview_audio",
    title: "分析声音",
    description: "离线渲染一段混音并给出每个时间窗的响度（RMS/峰值 dBFS）、静音段和削波，用来确认声音存在、音量合适。",
    readOnly: true,
    input: { work: workArg, start: seconds.default(0), duration: z.number().positive().max(60).default(10), window: z.number().min(0.05).max(5).default(0.5) },
    async run(args, ctx) {
      const work = await ctx.work();
      const stats = await services.renderer.audioStats(work, args);
      const quiet = stats.overall.rmsDb < -50;
      return asJson(
        stats,
        `${formatTime(stats.start)}–${formatTime(stats.start + stats.duration)}：整体 RMS ${stats.overall.rmsDb} dB，峰值 ${stats.overall.peakDb} dB，削波样本 ${stats.overall.clippedSamples}，静音窗口 ${stats.silentWindows}/${stats.windows.length}。${quiet ? "这段几乎没有声音。" : ""}\n` +
          stats.windows.map((item) => `${formatTime(item.time)} rms ${item.rmsDb} / peak ${item.peakDb}`).join("\n"),
      );
    },
  });
}
