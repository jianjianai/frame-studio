import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SpeechService } from "./service.mjs";
import { readJson } from "../http.mjs";
import { uniquePath } from "../files.mjs";
import { probe } from "../media.mjs";
import { placeAudio } from "../documents.mjs";
import { workArg, asJson } from "../tools/registry.mjs";

/** Generate a voice-over file in the work's public/voice/ folder. */
async function synthesizeInto(services, work, { text, provider, voice, rate, name }) {
  const result = await services.speech.synthesize({ text, provider, voice, rate });
  const base = (name || text.slice(0, 16)).replace(/[\\/\x00-\x1f?#%*:|"<>\s]+/g, "_").replace(/^_+|_+$/g, "") || "voice";
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
    synthesizeInto(services, await services.openWork(params.id, params.repo), await readJson(req)),
  );

  tools.add({
    name: "speech_voices",
    title: "列出声音",
    description: "列出可用的语音引擎和声音。provider 例如 edge、openai、local:<模型>；不传则用默认引擎。",
    readOnly: true,
    input: { provider: z.string().optional() },
    async run({ provider }) {
      const voices = await speech.voices(provider);
      return asJson({
        providers: speech
          .providers()
          .filter((item) => item.ready)
          .map(({ id, name }) => ({ id, name })),
        provider: provider || speech.defaultProvider(),
        voices: voices.slice(0, 200),
      });
    },
  });
  tools.add({
    name: "speech_synthesize",
    title: "生成配音",
    description:
      "把文字合成为语音文件，保存到作品 public/voice/，返回 films/... 地址和时长。设置 place 可直接放到「配音」音轨的 start 秒处。长旁白请按句分段生成，便于对齐画面。",
    input: {
      work: workArg,
      text: z.string().min(1).max(5000),
      provider: z.string().optional(),
      voice: z.string().optional().describe("speech_voices 返回的声音 id；Edge 中文常用 zh-CN-XiaoxiaoNeural / zh-CN-YunxiNeural"),
      rate: z.number().min(0.5).max(2).default(1),
      name: z.string().max(60).optional().describe("文件名（不含扩展名）"),
      place: z.object({ start: z.number().nonnegative(), track: z.string().default("配音") }).optional(),
    },
    async run({ text, provider, voice, rate, name, place }, ctx) {
      const work = await ctx.work();
      const result = await synthesizeInto(services, work, { text, provider, voice, rate, name });
      let clip = null;
      if (place)
        clip = placeAudio(work, {
          src: result.url,
          start: place.start,
          duration: result.duration ?? undefined,
          trackName: place.track,
          name: name || text.slice(0, 20),
        }).clip;
      return asJson(
        { ...result, clip },
        `已生成 ${result.path}（${result.duration?.toFixed(2) ?? "?"} 秒）${clip ? `，放在「${place.track}」音轨 ${place.start}s` : ""}，引用地址 ${result.url}`,
      );
    },
  });
}
