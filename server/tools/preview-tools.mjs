import { z } from "zod";
import sharp from "sharp";
import { workArg, asJson } from "./registry.mjs";
import { resolveAsset } from "./asset-tools.mjs";
import { formatTime } from "../render.mjs";
import { problem } from "../util.mjs";
import { probe } from "../media.mjs";
import { decodeAudio, loudness, trackBeats, mixDown } from "../audio-analysis.mjs";

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
      "听不到声音时用数字确认：每个时间窗的响度（RMS/峰值 dBFS）、静音段和削波。默认分析作品混音（start 起 duration 秒，最多 60 秒）；src 分析单个音频或视频文件（films/…、materials/<库>/…，默认整个文件，最多 300 秒）。beats: true 再给出节奏（BPM）、每个节拍的时间和最强的起音（重音），用来把剪辑点、画面变化对上音乐。",
    readOnly: true,
    input: {
      work: workArg,
      src: z.string().min(1).max(512).optional().describe("要分析的文件地址；不给则分析作品混音"),
      start: seconds.default(0),
      duration: z.number().positive().max(300).optional().describe("秒数；混音默认 10（最多 60），文件默认到结尾（最多 300）"),
      window: z.number().min(0.05).max(10).optional().describe("响度窗口秒数；默认 0.5，长音频自动加大到不超过 60 个窗口"),
      beats: z.boolean().default(false).describe("同时分析节拍"),
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
        const rhythm = trackBeats(mixDown(left, right), rate, { start: from });
        stats.rhythm = rhythm;
        lines.push(
          "",
          rhythm.bpm
            ? `节奏约 ${rhythm.bpm} BPM（节拍明显程度 ${rhythm.strength}，0–1${rhythm.strength < 0.3 ? "，节奏不明显，节拍点仅供参考" : ""}；如果听感明显快一倍或慢一倍，按两倍或一半理解）。` +
                `\n节拍 ${rhythm.beats.length} 个（秒，${src ? "文件内时间" : "作品时间"}）：${listTimes(rhythm.beats)}` +
                (rhythm.onsets.length ? `\n最强的起音（重音，适合放切点、闪光、文字出现）：${rhythm.onsets.map((item) => `${item.time.toFixed(2)}(${item.strength})`).join(" ")}` : "")
            : "没有找到稳定的节奏（声音太短、太安静或没有节拍）。",
        );
        if (src && rhythm.beats.length) lines.push("文件放到音轨上时，作品时间 = 片段 start + （文件内时间 − 片段 offset）。");
      }
      return asJson(stats, lines.join("\n"));
    },
  });
}
