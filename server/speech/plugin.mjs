import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SpeechService } from "./service.mjs";
import { readJson } from "../http.mjs";
import { uniquePath } from "../files.mjs";
import { probe } from "../media.mjs";
import { placeAudio } from "../documents.mjs";
import { workArg } from "../tools/registry.mjs";
import { problem } from "../util.mjs";

const round = (value) => Math.round(value * 100) / 100;

/** Generate a voice-over file in the work's public/voice/ folder. */
async function synthesizeInto(services, work, { text, provider, voice, rate, name }) {
  const result = await services.speech.synthesize({ text, provider, voice, rate });
  // File names from the text drop punctuation so they stay short and URL-friendly.
  const base =
    (name || text.replace(/[\p{P}\p{S}]+/gu, " ").trim().slice(0, 12))
      .replace(/[\\/\x00-\x1f?#%*:|"<>\s]+/g, "_")
      .replace(/^_+|_+$/g, "") || "voice";
  const relative = uniquePath(work.dir, `public/voice/${base}.${result.ext}`);
  fs.mkdirSync(path.dirname(path.join(work.dir, relative)), { recursive: true });
  fs.writeFileSync(path.join(work.dir, relative), result.bytes);
  const info = await probe(path.join(work.dir, relative));
  services.events.emit({ type: "assets", work: work.id, repo: work.repo });
  return { path: relative, url: `films/${work.slug}/${relative.replace(/^public\//, "")}`, duration: result.duration ?? info.duration ?? null };
}

export function speechPlugin(services) {
  const { router, tools } = services;
  const speech = (services.speech = new SpeechService(services));

  router.get("/api/speech/providers", () => ({
    providers: speech.providers(),
    defaultProvider: speech.defaultProvider(),
    models: speech.models(),
    openai: { ...(speech.conf().providers?.openai ?? { baseUrl: "", model: "", voices: [] }), hasKey: services.settings.hasSecret("speech:openai") },
  }));
  router.patch("/api/speech/settings", async ({ req }) => speech.updateSettings(await readJson(req)));
  router.get("/api/speech/voices", ({ query }) => speech.voices(query.provider || undefined));
  router.post("/api/speech/models/:id/install", ({ params }) => speech.install(params.id));
  router.delete("/api/speech/models/:id", ({ params }) => speech.remove(params.id));
  router.post("/api/works/:repo/:id/speech", async ({ params, req }) =>
    synthesizeInto(services, await services.openEditable(params.id, params.repo), await readJson(req)),
  );

  tools.add({
    name: "speech_voices",
    title: "列出声音",
    description:
      "列出可用的语音引擎和声音。provider 例如 edge、openai、local:<模型>，不传用默认引擎；language 按语言前缀过滤（默认 zh，传 all 列出全部）。",
    readOnly: true,
    input: {
      provider: z.string().optional(),
      language: z.string().max(20).default("zh").describe("语言前缀，如 zh、zh-CN、en、ja；all 表示全部"),
    },
    async run({ provider, language }) {
      const ready = speech.providers().filter((item) => item.ready);
      const chosen = provider || speech.defaultProvider();
      const all = await speech.voices(chosen);
      const filtered = language === "all" ? all : all.filter((voice) => !voice.language || voice.language.toLowerCase().startsWith(language.toLowerCase()));
      const voices = (filtered.length ? filtered : all).slice(0, 200);
      const line = (voice) => [voice.id, voice.name !== voice.id && voice.name, voice.language, voice.gender].filter(Boolean).join(" · ");
      return {
        data: { providers: ready.map(({ id, name }) => ({ id, name })), provider: chosen, voices },
        text:
          `可用引擎：${ready.map((item) => `${item.id}（${item.name}）`).join("、") || "无"}。当前 ${chosen}` +
          `${filtered.length ? "" : `，没有 ${language} 的声音，以下为全部`}，共 ${voices.length} 个声音：\n` +
          voices.map(line).join("\n"),
      };
    },
  });

  const lineSchema = z.strictObject({
    text: z.string().min(1).max(5000),
    voice: z.string().optional(),
    gap: z.number().min(0).max(30).optional().describe("与上一句的间隔秒数，默认用外层 gap"),
  });
  tools.add({
    name: "speech_synthesize",
    title: "生成配音",
    description:
      "把文字合成为语音，保存到作品 public/voice/，返回 films/... 地址和时长。" +
      "单句用 text；整段旁白用 lines（每句一个文件，按 gap 依次排列）。设置 place 后放到音轨（默认「配音」）的 start 秒处；subtitles: true 同时写入对应时间的字幕。",
    input: {
      work: workArg,
      text: z.string().min(1).max(5000).optional(),
      lines: z.array(lineSchema).min(1).max(100).optional(),
      provider: z.string().optional(),
      voice: z.string().optional().describe("speech_voices 返回的声音 id；Edge 中文常用 zh-CN-XiaoxiaoNeural / zh-CN-YunxiNeural"),
      rate: z.number().min(0.5).max(2).default(1),
      gap: z.number().min(0).max(30).default(0.3).describe("lines 中句与句之间的间隔秒数"),
      name: z.string().max(60).optional().describe("文件名（不含扩展名）；lines 时作为前缀"),
      place: z.object({ start: z.number().nonnegative(), track: z.string().default("配音") }).optional(),
      subtitles: z.boolean().default(false).describe("与 place 一起使用：把每句写成字幕（替换同一时间段的旧字幕）"),
    },
    async run({ text, lines, provider, voice, rate, gap, name, place, subtitles }, ctx) {
      if (Boolean(text) === Boolean(lines)) throw problem(400, "text 和 lines 必须且只能提供一个");
      if (subtitles && !place) throw problem(400, "subtitles 需要和 place 一起使用（需要知道每句的时间）");
      const work = await ctx.work();
      const total = services.works.meta(work).meta?.duration ?? Infinity;
      const items = lines ?? [{ text }];
      const results = [];
      let at = place?.start ?? 0;
      for (const [index, item] of items.entries()) {
        if (index) at += item.gap ?? gap;
        const fileName = name ? (lines ? `${name}-${String(index + 1).padStart(2, "0")}` : name) : undefined;
        const result = await synthesizeInto(services, work, { text: item.text, provider, voice: item.voice ?? voice, rate, name: fileName });
        const length = result.duration ?? 0;
        let clip = null;
        // Lines that start after the end of the work are still generated, just not placed.
        if (place && at < total - 1e-3)
          clip = placeAudio(work, {
            src: result.url,
            start: at,
            duration: result.duration ?? undefined,
            trackName: place.track,
            name: item.text.slice(0, 20),
          }).clip;
        // A clip is cut at the end of the work; the subtitle follows the audible part.
        results.push({ ...result, text: item.text, start: place ? at : undefined, end: place ? at + (clip ? clip.duration : length) : undefined, clip });
        at += length;
      }
      if (subtitles) {
        await tools.call(
          "subtitles_edit",
          {
            work: `${work.repo}/${work.id}`,
            add: results.filter((item) => item.clip).map((item) => ({ start: round(item.start), end: Math.min(round(item.end), total), text: item.text })),
          },
          ctx.scope,
        );
      }
      const cut = results.filter((item) => place && (!item.clip || (item.duration && item.clip.duration < item.duration - 1e-3)));
      const describe = (item) =>
        `${place ? `${round(item.start)}–${round(item.end)}s${item.clip ? "" : "（未放置）"} ` : ""}${item.url}（${item.duration?.toFixed(2) ?? "?"} 秒）${lines ? " " + item.text : ""}`;
      return {
        data: { items: results, end: place ? round(at) : undefined },
        text:
          `已生成 ${results.length} 段配音${place ? `，放在「${place.track}」音轨` : ""}${subtitles ? "，并写入字幕" : ""}：\n` +
          results.map(describe).join("\n") +
          (place ? `\n最后一句结束于 ${round(at)} 秒。` : "") +
          (cut.length
            ? `\n注意：作品只有 ${total} 秒，${cut.map((item) => `「${item.text.slice(0, 12)}」${item.clip ? "被截断" : "没有放上音轨"}`).join("、")}。` +
              `用 work_update 把 duration 改到至少 ${Math.ceil(at)} 秒，再重新放置这些句子（audio_place 用上面的地址，或 audio_edit 把被截断片段的 duration 改回音频时长）。`
            : ""),
      };
    },
  });
}
