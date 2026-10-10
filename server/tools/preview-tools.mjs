import path from "node:path";
import { z } from "zod";
import sharp from "sharp";
import { workArg, asJson } from "./registry.mjs";
import { resolveAsset } from "./asset-tools.mjs";
import { formatTime } from "../render.mjs";
import { problem } from "../util.mjs";
import { probe } from "../media.mjs";
import { decodeAudio, loudness, loudnessStretches, beatThis, mixDown } from "../audio-analysis.mjs";

const seconds = z.number().finite().nonnegative();
const SEPARATE_MAX = 8;

const listTimes = (times) => times.map((time) => time.toFixed(2)).join(" ");
const seconds2 = (value) => Math.round(value * 1000) / 1000;

/**
 * Beat This! results for the AI: the exact tempo of each steady stretch (a grid it can write
 * into project.ts and follow with beatAt / barAt), beats listed only where no grid fits, the
 * downbeats, and the tempo line with firstBeat already worked out.
 */
export function rhythmText(rhythm, { file }) {
  const where = file ? "文件内时间" : "作品时间";
  if (rhythm.beats.length < 2) return ["没有找到节拍（声音太短、太安静或没有节奏）。"];
  const segments = rhythm.segments ?? [];
  const main = [...segments].sort((a, b) => b.count - a.count)[0];
  const meter = rhythm.beatsPerBar ? `，每小节 ${rhythm.beatsPerBar} 拍` : "";
  const grid = (item) => `${item.bpm} BPM（每拍 ${item.interval.toFixed(4)} 秒，${item.count} 拍，实际节拍和这个网格最多差 ${item.maxError} 秒）`;
  const lines = [];
  if (segments.length === 1) lines.push(`节奏（Beat This! 模型，${where}）：全曲 ${grid(main)}${meter}，第一拍 ${main.start.toFixed(2)} 秒。`);
  else if (segments.length > 1)
    lines.push(
      `节奏（Beat This! 模型，${where}）：中途变速，分 ${segments.length} 段${meter}：`,
      ...segments.map((item) => `- ${formatTime(item.start)}–${formatTime(item.end)}：${grid(item)}`),
    );
  // Beats a grid does not describe: other stretches than the main one, or irregular ones.
  const loose = rhythm.beats.filter((time) => !main || time < main.start - 0.01 || time > main.end + 0.01 || main.maxError > 0.06);
  if (!main) lines.push(`节拍 ${rhythm.beats.length} 个（秒，${where}）：${listTimes(rhythm.beats)}`);
  else if (loose.length) lines.push(`${main.maxError > 0.06 ? "节拍不太规整，" : ""}主段以外的节拍 ${loose.length} 个（秒，${where}）：${listTimes(loose)}`);
  if (rhythm.downbeats.length) lines.push(`小节第一拍 ${rhythm.downbeats.length} 个（秒，${where}；段落和大的画面变化放在这里）：${listTimes(rhythm.downbeats)}`);
  if (!main) return lines;
  // The grid's first downbeat in the main stretch: firstBeat of the tempo.
  const downbeat = rhythm.downbeats.find((time) => time >= main.start - 0.03 && time <= main.end + 0.03) ?? main.start;
  const first = seconds2(main.first + Math.round((downbeat - main.first) / main.interval) * main.interval);
  const tempo = `{ bpm: ${main.bpm}, firstBeat: ${file ? "<作品时间>" : first}${rhythm.beatsPerBar ? `, beatsPerBar: ${rhythm.beatsPerBar}` : ""} }`;
  lines.push(
    `按这首配乐卡点：work_update 的 tempo: ${tempo}，代码里用 beatAt(k) / barAt(n)（@frame/engine/tempo）取时间。` +
      (file ? `firstBeat 是第一小节第一拍在作品里的时间：文件内 ${first} 秒，放到音轨上后 = 片段 start + ${first} − 片段 offset（从作品 0 秒起放、offset 0 时就是 ${first}）。` : "") +
      (segments.length > 1 ? `tempo 只有一个速度：${formatTime(main.start)}–${formatTime(main.end)} 以外的剪辑点用上面列出的节拍时间，不要用 beatAt。` : ""),
  );
  return lines;
}

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

  registry.add({
    name: "preview_audio",
    title: "分析声音",
    description:
      "听不到声音时用数字确认：响度（RMS/峰值 dBFS，响度相近的时间合并成一段）、静音段和削波。默认分析作品混音（start 起 duration 秒，最多 60 秒）；src 分析单个音频或视频文件（films/…、materials/<库>/…，默认整个文件，最多 300 秒）。beats: true 再用 Beat This! 模型给出准确的速度（中途变速时分段）、拍号、每小节第一拍的时间和写进 project.ts 的 tempo，用来把剪辑点、画面变化对上音乐（耗时约为音频长度的十分之一）。",
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
        // A number alone does not say what to do about it.
        ...(!src && stats.overall.clippedSamples > 100
          ? ["过载（削波）会破音：用 audio_edit 把最响的片段或音轨 gain 调低（配乐和人声同时出现时配乐常用 0.3–0.5），或调低 master 的 gain。"]
          : []),
        `响度（${step} 秒一窗，相差 2 dB 以内的合并）：`,
        ...loudnessStretches(stats.windows, step).map((item) => `${formatTime(item.start)}–${formatTime(item.end)} ${item.silent ? "静音" : `rms ${item.rmsDb} / peak ${item.peakDb}`}`),
      ];
      if (beats) {
        const rhythm = await beatThis(mixDown(left, right), rate, { start: from, modelsDir: path.join(services.config.dirs.models, "beat-this") });
        stats.rhythm = rhythm;
        lines.push("", ...rhythmText(rhythm, { file: Boolean(src) }));
      }
      return asJson(stats, lines.join("\n"));
    },
  });
}
