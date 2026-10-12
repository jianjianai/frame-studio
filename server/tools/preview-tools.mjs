import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import sharp from "sharp";
import { workArg, asJson } from "./registry.mjs";
import { resolveAsset } from "./asset-tools.mjs";
import { formatTime, ffmpegExecutable, digest, contactSheet } from "../render.mjs";
import { problem } from "../util.mjs";
import { probe } from "../media.mjs";
import { decodeAudio, loudness, loudnessStretches, beatThis, mixDown, voiceBalance, VOICE_TRACK } from "../audio-analysis.mjs";
import { projectAudioTracks } from "../../src/engine/types.ts";

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

/**
 * The tracks heard between `from` and `to`, to render one by one: audio.json tracks (all their
 * clips) and video layers with sound. `voice` by name or by files from public/voice/.
 */
export function audibleTracks(meta, from, to) {
  const names = new Map((meta.audioDocument?.tracks ?? []).map((track) => [track.id, track.name]));
  const groups = new Map();
  for (const entry of projectAudioTracks(meta)) {
    if (entry.muted || entry.start >= to || entry.start + (entry.duration ?? Infinity) <= from) continue;
    const id = entry.channel ?? entry.id;
    const group = groups.get(id) ?? { id, name: names.get(entry.channel) ?? entry.name ?? id, files: [] };
    if (entry.src) group.files.push(entry.src);
    groups.set(id, group);
  }
  return [...groups.values()].map(({ id, name, files }) => ({ id, name, voice: VOICE_TRACK.test(name) || (files.length > 0 && files.every((src) => /\/voice\//.test(src))) }));
}

/** Each track alone, and whether the voice stands out. */
function trackLines(solo, window) {
  const power = (rmsDb) => 10 ** (rmsDb / 10);
  const lines = ["各音轨单独的响度："];
  for (const track of solo) {
    const heard = track.windows.filter((item) => item.rmsDb > -60);
    const rms = heard.length ? Math.round(10 * Math.log10(heard.reduce((sum, item) => sum + power(item.rmsDb), 0) / heard.length) * 10) / 10 : null;
    // Very quiet all through: often the wrong file or a gain left near zero.
    const faint = rms !== null && rms < -45 ? "（很轻：是不是素材几乎静音，或 gain 太低？）" : "";
    lines.push(`- 「${track.name}」${track.voice ? "（人声）" : ""}：${rms === null ? "这段没有声音" : `rms ${rms} / peak ${track.overall.peakDb}，有声 ${Math.round(heard.length * window * 10) / 10} 秒${faint}`}`);
  }
  const balance = voiceBalance(solo, window);
  if (balance?.differenceDb != null) {
    const { seconds, differenceDb } = balance;
    if (differenceDb >= 6) lines.push(`人声段（${seconds} 秒）：人声比其他声音响 ${differenceDb} dB，听得清。`);
    else {
      const factor = Math.round(10 ** (-(8 - differenceDb) / 20) * 100) / 100;
      lines.push(
        `人声段（${seconds} 秒）：人声${differenceDb >= 0 ? `只比其他声音响 ${differenceDb} dB` : `比其他声音还低 ${-differenceDb} dB`}，会被盖住。人声一般要比配乐响 6 dB 以上：用 audio_edit 把其他音轨的 gain 乘以约 ${factor}（或调高人声）；只在人声出现时压低配乐（duck）要用户明确同意。`,
      );
    }
  }
  return lines;
}

export function registerPreviewTools(registry) {
  const { services } = registry;

  registry.add({
    name: "preview_frames",
    title: "查看画面",
    description:
      "在浏览器中渲染作品画面给你看，用来亲眼确认修改效果。times 指定绝对时间（秒，超出 0–作品时长的按 0 或最后一刻 时长−0.001 秒画）；或者不给 times，用 count 在全片（或 start–end 一段）均匀取样（都不给时全片取 12 张；取的是等分后每一份的中点，不含首尾两端，看首尾和切点用 times）。4 张以内分开返回，更多时拼成一张带时间标注的总览图（sheet 可以指定，分开返回最多 8 张）。默认 JPEG；format 设为 png 时返回无损 PNG（看细小文字、颜色）。每张都有画面指纹：同一时刻两次渲染指纹相同，画面就完全一样（检查能否倒退、重复渲染时用）。",
    readOnly: true,
    input: {
      work: workArg,
      times: z.array(seconds).min(1).max(36).optional(),
      count: z.number().int().min(1).max(36).optional().describe("均匀取样的张数（不给 times 时）"),
      start: seconds.optional().describe("取样范围：开始秒数"),
      end: seconds.optional().describe("取样范围：结束秒数"),
      sheet: z.boolean().optional().describe("拼成一张总览图（默认超过 4 张时拼）"),
      columns: z.number().int().min(1).max(8).optional().describe("总览图的列数"),
      width: z.number().int().min(160).max(1920).multipleOf(2).optional().describe("分开返回时每张的宽度（像素，默认 960），高度按画幅计算"),
      subtitles: z.boolean().default(true),
      format: z.enum(["jpeg", "png"]).default("jpeg").describe("图片格式：jpeg 小，png 无损"),
      compare: workArg.describe("另一个作品：同样的时刻并排画出两个作品（左边本作品，右边这个），例如对比横屏版和竖屏版。时刻用 times 或 count 取样（最多 12 个），固定拼成一张图"),
    },
    async run({ times, count, start, end, sheet, columns, width, subtitles, format, compare }, ctx) {
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
      if (compare) {
        // Two works side by side at the same moments, each fitted into the same cell.
        if (sheet !== undefined || columns !== undefined || width !== undefined) throw problem(400, "compare 固定拼成一张左右并排的图，不用 sheet、columns、width");
        if (times.length > 12) throw problem(400, "compare 最多 12 个时刻");
        const other = await ctx.work(compare);
        const cell = 480;
        // Each rendered with its long side the cell's size (an even width, as the renderer wants).
        const widthFor = (item) => {
          const meta = services.works.meta(item);
          const { width: w, height: h } = (meta.ok && meta.meta.composition) || { width: 1920, height: 1080 };
          return w >= h ? cell : Math.max(2, Math.round((cell * w) / h / 2) * 2);
        };
        const [mine, theirs] = await Promise.all([work, other].map((item) => services.renderer.frames(item, { times, width: widthFor(item), subtitles })));
        const fit = (png) => sharp(png).resize(cell, cell, { fit: "contain", background: "#16191d" }).png().toBuffer();
        const cells = [];
        for (const [index, time] of times.entries()) {
          const a = mine.frames[index], b = theirs.frames[index];
          cells.push({ png: a ? await fit(a.png) : await sharp({ create: { width: cell, height: cell, channels: 3, background: "#16191d" } }).png().toBuffer(), label: `${formatTime(time)} 本作品` });
          cells.push({ png: b ? await fit(b.png) : await sharp({ create: { width: cell, height: cell, channels: 3, background: "#16191d" } }).png().toBuffer(), label: `${formatTime(time)} ${other.id}` });
        }
        const errors = [...mine.errors.map((text) => `本作品：${text}`), ...theirs.errors.map((text) => `${other.id}：${text}`)];
        return {
          data: { times, errors },
          text: `并排对比（每行一个时刻，左：本作品 ${mine.width}×${mine.height}，右：${other.id} ${theirs.width}×${theirs.height}）：${times.map(formatTime).join("、")}${errors.length ? "\n错误：\n" + errors.join("\n") : ""}`,
          images: [{ data: await contactSheet(cells, cell, cell, 2, format), mimeType: `image/${format}` }],
        };
      }
      if (sheet ?? times.length > 4) {
        const cells = columns ?? Math.min(4, Math.ceil(Math.sqrt(times.length)));
        const { image, times: rendered, errors, digests } = await services.renderer.storyboard(work, { times, columns: cells, width: cells > 4 ? 320 : 480, subtitles, format });
        return {
          data: { times: rendered, errors, digests },
          text: `总览 ${rendered.length} 张：${rendered.map((time, index) => `#${index + 1} ${formatTime(time)}（${digests[index]}）`).join("，")}${errors.length ? "\n错误：\n" + errors.join("\n") : ""}`,
          images: [{ data: image, mimeType: `image/${format}` }],
        };
      }
      if (times.length > SEPARATE_MAX) throw problem(400, `分开返回最多 ${SEPARATE_MAX} 张；更多时用 sheet: true 拼成一张`);
      const result = await services.renderer.frames(work, { times, width: width ?? 960, subtitles });
      const images = await Promise.all(
        result.frames.map(async (frame) => ({
          data: format === "png" ? frame.png : await sharp(frame.png).jpeg({ quality: 82 }).toBuffer(),
          mimeType: `image/${format}`,
          label: formatTime(frame.time),
        })),
      );
      const digests = result.frames.map((frame) => digest(frame.png));
      const notes = [`${result.width}×${result.height}，时间：${result.frames.map((frame, index) => `${formatTime(frame.time)}（${digests[index]}）`).join("、")}`];
      if (result.errors.length) notes.push("渲染时出现错误：\n" + result.errors.join("\n"));
      return {
        data: { times: result.frames.map((frame) => frame.time), width: result.width, height: result.height, errors: result.errors, digests },
        text: notes.join("\n"),
        images,
      };
    },
  });

  /** Stereo PCM → an MP3 file (128 kbit/s) under the studio's temporary folder. */
  const encodeMp3 = async (left, right, rate, file) => {
    const ffmpeg = ffmpegExecutable();
    if (!ffmpeg) throw problem(500, "生成试听需要 FFmpeg", "NO_FFMPEG");
    const pcm = Buffer.alloc(left.length * 4);
    for (let i = 0; i < left.length; i++) {
      pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), i * 4);
      pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), i * 4 + 2);
    }
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", String(rate), "-ac", "2", "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", "128k", file], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("FFmpeg 失败：" + stderr))));
      child.stdin.end(pcm);
    });
  };

  registry.add({
    name: "preview_audio",
    title: "分析声音",
    description:
      "听不到声音时用数字确认：响度（RMS/峰值 dBFS，响度相近的时间合并成一段）、静音段和削波。默认分析作品混音（start 起 duration 秒，最多 60 秒）；src 分析单个音频或视频文件（films/…、materials/<库>/…，默认整个文件，最多 300 秒）。分析混音时（有两条以上音轨）还会单独渲染每条音轨，给出各自的响度，有人声时说明人声是否被盖住。beats: true 再用 Beat This! 模型给出准确的速度（中途变速时分段）、拍号、每小节第一拍的时间和写进 project.ts 的 tempo，用来把剪辑点、画面变化对上音乐（耗时约为音频长度的十分之一）。listen: true 同时把这一段做成 MP3：能听音频的 AI 直接收到音频，结果里还有给用户试听的下载链接（1 小时内有效）——念错字、语气、音色这些数字看不出来，交给能听的人。",
    readOnly: true,
    input: {
      work: workArg,
      src: z.string().min(1).max(512).optional().describe("要分析的文件地址；不给则分析作品混音"),
      start: seconds.default(0),
      duration: z.number().positive().max(300).optional().describe("秒数；混音默认 10（最多 60），文件默认到结尾（最多 300）"),
      window: z.number().min(0.05).max(10).optional().describe("响度窗口秒数；默认 0.5，长音频自动加大到不超过 60 个窗口"),
      beats: z.boolean().default(false).describe("同时分析节拍和小节"),
      tracks: z.boolean().default(true).describe("分析混音时单独渲染各音轨（最多 8 条），给出各自的响度和人声是否被盖住"),
      listen: z.boolean().default(false).describe("同时生成这一段的 MP3 试听（最多 60 秒）"),
    },
    async run({ src, start, duration, window, beats, tracks, listen }, ctx) {
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
      const meta = src || !tracks ? null : services.works.meta(work);
      const audible = meta?.ok ? audibleTracks(meta.meta, from, from + length) : [];
      if (audible.length >= 2 && audible.length <= 8) {
        const solo = [];
        for (const track of audible) {
          const pcm = await services.renderer.audioPcm(work, { start: from, duration: length, track: track.id });
          const level = loudness(pcm.left, pcm.right, pcm.rate, { start: from, window: step });
          solo.push({ ...track, windows: level.windows, overall: level.overall });
        }
        stats.tracks = solo.map(({ windows: _windows, ...track }) => track);
        lines.push("", ...trackLines(solo, step));
      }
      if (beats) {
        const rhythm = await beatThis(mixDown(left, right), rate, { start: from, modelsDir: path.join(services.config.dirs.models, "beat-this") });
        stats.rhythm = rhythm;
        lines.push("", ...rhythmText(rhythm, { file: Boolean(src) }));
      }
      if (listen) {
        // At most a minute: enough to hear a line or a passage, small enough to hand over inline.
        const cut = Math.min(left.length, Math.round(60 * rate));
        const dir = path.join(services.config.dirs.tmp, "listen");
        fs.mkdirSync(dir, { recursive: true });
        for (const old of fs.readdirSync(dir)) if (Date.now() - fs.statSync(path.join(dir, old)).mtimeMs > 3600_000) fs.rmSync(path.join(dir, old), { force: true });
        const name = `${work.slug}-${Math.round(from * 1000)}-${Date.now().toString(36)}.mp3`;
        const file = path.join(dir, name);
        await encodeMp3(left.subarray(0, cut), right.subarray(0, cut), rate, file);
        const link = services.downloads?.link(file, `试听-${name}`);
        stats.listen = { seconds: Math.round((cut / rate) * 1000) / 1000, ...(link ? { url: link.url } : {}) };
        lines.push("", `试听：${formatTime(from)}–${formatTime(from + cut / rate)} 的 MP3 已附在结果里（客户端不能接收音频时只有这条链接）${link ? `，下载地址（${link.expiresInMinutes} 分钟内有效，可以给用户）：${link.url}` : ""}`);
        return { ...asJson(stats, lines.join("\n")), audio: [{ data: fs.readFileSync(file), mimeType: "audio/mpeg" }] };
      }
      return asJson(stats, lines.join("\n"));
    },
  });
}
