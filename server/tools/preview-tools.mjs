import path from "node:path";
import { z } from "zod";
import sharp from "sharp";
import { workArg, asJson } from "./registry.mjs";
import { resolveAsset } from "./asset-tools.mjs";
import { formatTime } from "../render.mjs";
import { problem } from "../util.mjs";
import { probe } from "../media.mjs";
import { decodeAudio, loudness, beatThis, mixDown } from "../audio-analysis.mjs";

const seconds = z.number().finite().nonnegative();
const SEPARATE_MAX = 8;

export function registerPreviewTools(registry) {
  const { services } = registry;

  registry.add({
    name: "preview_frames",
    title: "查看画面",
    description:
      "在浏览器中渲染作品画面给你看，用来亲眼确认修改效果。times 指定绝对时间（秒）；或者不给 times，用 count 在全片（或 start–end 一段）均匀取样（都不给时全片取 12 张）。4 张以内分开返回，更多时拼成一张带时间标注的总览图（sheet 可以指定，分开返回最多 8 张）。",
    readOnly: true,
    input: {
      work: workArg,
      times: z.array(seconds).min(1).max(36).optional(),
      count: z.number().int().min(1).max(36).optional().describe("均匀取样的张数（不给 times 时）"),
      start: seconds.optional().describe("取样范围：开始秒数"),
      end: seconds.optional().describe("取样范围：结束秒数"),
      sheet: z.boolean().optional().describe("拼成一张总览图（默认超过 4 张时拼）"),
      columns: z.number().int().min(1).max(8).optional().describe("总览图的列数"),
      width: z.number().int().min(160).max(1920).multipleOf(2).default(960).describe("分开返回时每张的宽度（像素），高度按画幅计算"),
      subtitles: z.boolean().default(true),
    },
    async run({ times, count, start, end, sheet, columns, width, subtitles }, ctx) {
      const work = await ctx.work();
      if (times && (count !== undefined || start !== undefined || end !== undefined)) throw problem(400, "times 和 count/start/end 二选一");
      if (!times) {
        const meta = services.works.meta(work);
        const duration = meta.ok ? meta.meta.duration : 10;
        const from = Math.min(start ?? 0, duration),
          to = Math.min(end ?? duration, duration);
        if (to <= from) throw problem(400, `取样范围 ${from}–${to} 秒无效（作品 ${duration} 秒）`);
        const n = count ?? 12;
        times = Array.from({ length: n }, (_, index) => from + ((to - from) * (index + 0.5)) / n);
      }
      if (sheet ?? times.length > 4) {
        const cells = columns ?? Math.min(4, Math.ceil(Math.sqrt(times.length)));
        const { image, times: rendered, errors } = await services.renderer.storyboard(work, { times, columns: cells, width: cells > 4 ? 320 : 480, subtitles });
        return {
          data: { times: rendered, errors },
          text: `总览 ${rendered.length} 张：${rendered.map((time, index) => `#${index + 1} ${formatTime(time)}`).join("，")}${errors.length ? "\n错误：\n" + errors.join("\n") : ""}`,
          images: [{ data: image, mimeType: "image/jpeg" }],
        };
      }
      if (times.length > SEPARATE_MAX) throw problem(400, `分开返回最多 ${SEPARATE_MAX} 张；更多时用 sheet: true 拼成一张`);
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

  const listTimes = (times) => times.map((time) => time.toFixed(2)).join(" ");
  registry.add({
    name: "preview_audio",
    title: "分析声音",
    description:
      "听不到声音时用数字确认：每个时间窗的响度（RMS/峰值 dBFS）、静音段和削波。默认分析作品混音（start 起 duration 秒，最多 60 秒）；src 分析单个音频或视频文件（films/…、materials/<库>/…，默认整个文件，最多 300 秒）。beats: true 再用 Beat This! 模型给出节奏（BPM）、拍号、每个节拍和每小节第一拍的时间，用来把剪辑点、画面变化对上音乐（耗时约为音频长度的十分之一）。",
    readOnly: true,
    input: {
      work: workArg,
      src: z.string().min(1).max(512).optional().describe("要分析的文件地址；不给则分析作品混音"),
      start: seconds.default(0),
      duration: z.number().positive().max(300).optional().describe("秒数；混音默认 10（最多 60），文件默认到结尾（最多 300）"),
      window: z.number().min(0.05).max(10).optional().describe("响度窗口秒数；默认 0.5，长音频自动加大到不超过 60 个窗口"),
      beats: z.boolean().default(false).describe("同时分析节拍和小节"),
    },
    async run({ src, start, duration, window, beats }, ctx) {
      const work = await ctx.work();
      let left, right, rate, from, length, label;
      if (src) {
        const file = await resolveAsset(services, work, src);
        const total = (await probe(file)).duration;
        from = Math.min(start, total ?? start);
        length = Math.min(duration ?? 300, 300, total ? total - from : 300);
        if (!(length > 0)) throw problem(400, `开始时间 ${start} 秒超出了文件长度 ${total} 秒`);
        ({ left, right, rate } = await decodeAudio(file, { start: from, seconds: length }));
        length = left.length / rate;
        label = src;
      } else {
        ({ left, right, rate, start: from, duration: length } = await services.renderer.audioPcm(work, { start, duration: Math.min(duration ?? 10, 60) }));
        label = "作品混音";
      }
      const step = window ?? Math.max(0.5, Math.ceil(length / 60 / 0.5) * 0.5);
      const stats = { start: from, duration: Math.round(length * 1000) / 1000, windowSeconds: step, ...loudness(left, right, rate, { start: from, window: step }) };
      const quiet = stats.overall.rmsDb < -50;
      const lines = [
        `${label} ${formatTime(from)}–${formatTime(from + length)}：整体 RMS ${stats.overall.rmsDb} dB，峰值 ${stats.overall.peakDb} dB，削波样本 ${stats.overall.clippedSamples}，静音窗口 ${stats.silentWindows}/${stats.windows.length}。${quiet ? "这段几乎没有声音。" : ""}`,
        ...stats.windows.map((item) => `${formatTime(item.time)} rms ${item.rmsDb} / peak ${item.peakDb}`),
      ];
      if (beats) {
        const rhythm = await beatThis(mixDown(left, right), rate, { start: from, modelsDir: path.join(services.config.dirs.models, "beat-this") });
        stats.rhythm = rhythm;
        const where = src ? "文件内时间" : "作品时间";
        lines.push(
          "",
          rhythm.beats.length >= 2
            ? `节奏约 ${rhythm.bpm} BPM${rhythm.beatsPerBar ? `，每小节 ${rhythm.beatsPerBar} 拍` : ""}（Beat This! 模型）。` +
                `\n节拍 ${rhythm.beats.length} 个（秒，${where}）：${listTimes(rhythm.beats)}` +
                `\n小节第一拍 ${rhythm.downbeats.length} 个（秒，${where}；段落和大的画面变化放在这里）：${listTimes(rhythm.downbeats)}`
            : "没有找到节拍（声音太短、太安静或没有节奏）。",
        );
        if (src && rhythm.beats.length) lines.push("文件放到音轨上时，作品时间 = 片段 start + （文件内时间 − 片段 offset）。");
        // The grid library code follows (@frame/engine/tempo): first downbeat in work time.
        if (rhythm.beats.length >= 2)
          lines.push(
            `按这首配乐卡点时，把节拍写进作品：work_update 的 tempo: { bpm: ${rhythm.bpm}, firstBeat: <作品时间里第一小节第一拍的秒数>${rhythm.beatsPerBar ? `, beatsPerBar: ${rhythm.beatsPerBar}` : ""} }，代码里用 beatAt(k) / barAt(n)（@frame/engine/tempo）取时间。`,
          );
      }
      return asJson(stats, lines.join("\n"));
    },
  });
}
