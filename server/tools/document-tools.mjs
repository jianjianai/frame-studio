import { z } from "zod";
import { workArg } from "./registry.mjs";

/**
 * The strict operation schemas expand to ~20 KB of JSON schema each (the whole document
 * format); clients get this compact shape instead and the format lives in frame_guide.
 */
const looseOperations = (ops, describe) =>
  z
    .array(z.looseObject({ op: z.enum(ops) }))
    .min(1)
    .max(100)
    .describe(describe);
const editOptions = {
  expectedSha256: z.string().optional().describe("读取时得到的 sha256；文件已被别人改动则拒绝写入"),
  dryRun: z.boolean().default(false).describe("只校验不写入"),
};
import { readVisual, editVisual, readAudio, editAudio } from "../documents.mjs";
import { visualOperationSchema, visualClipSchema } from "../../src/engine/visual-document.mjs";
import { audioOperationSchema, audioClipSchema, audioChannelSchema, audioSourceSchema } from "../../src/engine/audio-document.mjs";
import { resolveAsset } from "./asset-tools.mjs";
import { probe } from "../media.mjs";
import { problem } from "../util.mjs";
import { VOICE_TRACK } from "../audio-analysis.mjs";

/**
 * Subtitles follow voice clips that move: the cues inside a voice clip's old span shift with
 * it (speech_synthesize writes them once, and a moved line with its subtitle left behind is
 * a mistake nobody wants). Voice: a clip on a voice-named track or of a public/voice/ file.
 */
function followSubtitles(before, after, cues, duration) {
  if (!before || !cues?.length) return { cues, moved: [] };
  const sources = new Map(after.sources.map((source) => [source.id, source]));
  const tracks = new Map(after.tracks.map((track) => [track.id, track]));
  const voice = (clip) => VOICE_TRACK.test(tracks.get(clip.track)?.name ?? "") || /(^|\/)voice\//.test(sources.get(clip.source)?.src ?? "");
  let next = cues;
  const moved = [];
  for (const clip of after.clips) {
    const old = before.clips.find((item) => item.id === clip.id);
    const delta = old ? clip.start - old.start : 0;
    if (!old || Math.abs(delta) < 1e-6 || !voice(clip)) continue;
    next = next.map((cue) => {
      if (cue.start < old.start - 0.05 || cue.end > old.start + old.duration + 0.05) return cue;
      const start = Math.round((cue.start + delta) * 1000) / 1000;
      const end = Math.round((cue.end + delta) * 1000) / 1000;
      if (start < 0 || end > duration) return cue;
      moved.push(`「${cue.text}」${start}–${end} 秒`);
      return { ...cue, start, end };
    });
  }
  return { cues: next, moved };
}

/** Most three scenes and model layers at one moment: each holds a WebGL context (a browser keeps ~16). */
const WEBGL_LAYERS = 12;
/**
 * What the format cannot say but rendering would fail on, checked before writing: model
 * animations the file does not have, and too many 3D layers at one moment.
 */
async function checkLayers(services, work, document) {
  const problems = [];
  for (const clip of document.clips) {
    const source = clip.source;
    if (source.kind !== "model" || !source.animation) continue;
    const info = await resolveAsset(services, work, source.src).then(probe).catch(() => null);
    const names = info?.animations?.map((item) => item.name);
    if (names && !names.includes(source.animation)) problems.push(`图层「${clip.id}」：模型 ${source.src} 里没有动画「${source.animation}」（有：${names.join("、") || "无"}）`);
  }
  // A Lottie layer plays its animation's time = offset + (elapsed × rate + phase) [mod loop]: past the end it fails.
  for (const clip of document.clips) {
    if (clip.source.kind !== "lottie") continue;
    const info = await resolveAsset(services, work, clip.source.src).then(probe).catch(() => null);
    if (!info?.duration) continue;
    const reach = clip.offset + (clip.loop ? clip.loop : clip.duration * clip.rate + (clip.phase ?? 0));
    if (reach > info.duration + 1e-3)
      problems.push(
        `图层「${clip.id}」要播放到 ${clip.source.src} 的第 ${+reach.toFixed(3)} 秒，但它只有 ${info.duration} 秒（动画时间 = offset + (经过的时间 × rate + phase)，有 loop 时括号部分对 loop 取余）`,
      );
  }
  const heavy = document.clips.filter((clip) => !clip.hidden && (clip.source.kind === "model" || (clip.source.kind === "scene" && clip.source.engine === "three")));
  for (const at of [...new Set(heavy.map((clip) => clip.start))].sort((a, b) => a - b)) {
    const active = heavy.filter((clip) => clip.start <= at && at < clip.start + clip.duration);
    if (active.length > WEBGL_LAYERS) {
      problems.push(`${at} 秒起同时有 ${active.length} 个三维图层（${active.map((clip) => clip.id).join("、")}）：每个占一个 WebGL 上下文，同一时刻最多 ${WEBGL_LAYERS} 个`);
      break;
    }
  }
  if (problems.length) throw problem(400, problems.join("\n"), "INVALID_LAYERS");
}

/** Field defaults of an object schema (the fields declared with `.default()`). */
const defaultsOf = (schema) =>
  Object.fromEntries(
    Object.entries(schema.shape)
      .filter(([, field]) => field.def?.type === "default")
      .map(([key, field]) => [key, JSON.stringify(field.def.defaultValue)]),
  );
const without = (defaults) => (item) => Object.fromEntries(Object.entries(item).filter(([key, value]) => defaults[key] !== JSON.stringify(value)));
const compactClip = without(defaultsOf(visualClipSchema));
const compactAudioClip = without(defaultsOf(audioClipSchema));
const compactChannel = without(defaultsOf(audioChannelSchema));
const compactSource = Object.fromEntries(audioSourceSchema.options.map((option) => [option.shape.kind.def.values[0], without(defaultsOf(option))]));

/**
 * A document as the AI reads it: fields left at their defaults are dropped (they are in
 * frame_guide) and every item is one line, so a long timeline stays short. The result is
 * still a valid document for `replace`.
 */
const lines = (items, compact) => items.map((item) => "  " + JSON.stringify(compact(item))).join("\n") || "  （无）";

export function registerDocumentTools(registry) {
  registry.add({
    name: "layers_get",
    title: "读取图层",
    description:
      "读取 visual.json 图层时间轴（图片/视频/颜色/Lottie/scene 模块图层，含位置、透明度关键帧、淡入淡出）及其 sha256，每个图层一行，取默认值的字段省略。只有使用 loadVisual 的作品才有。",
    readOnly: true,
    input: { work: workArg },
    async run(_, ctx) {
      const { document, sha256, duration } = readVisual(await ctx.work());
      const clips = document.clips.map(compactClip);
      return {
        data: { sha256, duration, document: { ...document, clips } },
        meta: { sha256 },
        text: `visual.json（作品 ${duration} 秒，背景 ${document.background}）。图层从下到上，省略了取默认值的字段（offset 0、phase 0、rate 1、fit contain、blend source-over）：\n${lines(document.clips, compactClip)}`,
      };
    },
  });

  registry.add({
    name: "layers_edit",
    title: "编辑图层",
    description:
      "原子地编辑 visual.json：add（加图层）、update（只改给出的字段：嵌套对象逐项合并，例如 patch {transform:{opacity:0.5}} 保留原来的 x/y；数组整体替换；unset 删除字段，可写 transform.opacity）、remove、reorder（图层顺序：越靠后越在上面）、split（在某时间切开）、replace（整体替换）。transform 的 x/y/width/height 是相对画面的 0..1 比例，scale 以图层中心缩放，都可以是数字或关键帧数组 [{at,value,easing}]。",
    guide: "layers",
    destructive: true,
    input: {
      work: workArg,
      operations: z.array(visualOperationSchema).min(1).max(100),
      ...editOptions,
    },
    publicInput: {
      work: workArg,
      operations: looseOperations(
        ["add", "update", "remove", "reorder", "split", "replace"],
        '按顺序执行，全部成功才写入。例：{"op":"add","clip":{"id":"logo","source":{"kind":"image","src":"films/<名称>/logo.png"},"start":2,"duration":3}}、{"op":"update","id":"logo","patch":{"start":3,"transform":{"opacity":0.8}},"unset":["crop"]}、{"op":"remove","id":"x"}、{"op":"reorder","id":"x","index":0}、{"op":"split","id":"x","at":5,"newId":"x2"}。字段见 frame_guide layers',
      ),
      ...editOptions,
    },
    async run(args, ctx) {
      const work = await ctx.work();
      await checkLayers(registry.services, work, editVisual(work, { ...args, dryRun: true }).document);
      // Unsetting a field the layer never had does nothing: worth a word (often a misspelt path).
      const before = readVisual(work).document;
      const absent = [];
      for (const op of args.operations) {
        if (op.op !== "update" || !op.unset?.length) continue;
        const clip = before.clips.find((item) => item.id === op.id);
        if (!clip) continue;
        for (const field of op.unset) if (field.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), clip) === undefined) absent.push(`「${op.id}」没有 ${field}`);
      }
      const result = editVisual(work, args);
      if (!args.dryRun) await registry.services.materials?.lockReferenced(work);
      const summary = result.document.clips.map((clip) => `${clip.id} ${round(clip.start)}–${round(clip.start + clip.duration)}s`).join("，");
      return {
        data: { sha256: result.sha256, clips: result.document.clips.length, dryRun: args.dryRun },
        meta: { sha256: result.sha256 },
        text: `${args.dryRun ? "预检通过（未写入）" : "已更新图层"}。图层（从下到上）：${summary || "无"}${absent.length ? `\n注意：unset 的字段本来就不存在，没有改动：${absent.join("、")}` : ""}`,
      };
    },
  });

  registry.add({
    name: "audio_get",
    title: "读取混音",
    description:
      "读取 audio.json 多轨混音（sources 素材、tracks 音轨、clips 片段、buses 总线、master 主输出）及其 sha256，每项一行，取默认值的字段省略。作品还没有音频时为空（audio_edit / audio_place 会自动创建）。",
    readOnly: true,
    input: { work: workArg },
    async run(_, ctx) {
      const { document, sha256, duration } = readAudio(await ctx.work());
      if (!document) return { data: { document: null, sha256: null, duration }, text: "作品还没有 audio.json（audio_place / audio_edit / speech_synthesize 会自动创建）。" };
      const compact = {
        ...document,
        sources: document.sources.map((item) => compactSource[item.kind](item)),
        tracks: document.tracks.map(compactChannel),
        clips: document.clips.map(compactAudioClip),
        buses: document.buses.map(compactChannel),
      };
      if (compact.linkedVideo) delete compact.linkedVideo;
      return {
        data: { sha256, duration, document: compact },
        meta: { sha256 },
        text: [
          `audio.json（作品 ${duration} 秒）。每项一行，省略了取默认值的字段（gain 1、pan 0、muted false、offset 0、rate 1、fade 0、processors/sends/automation 为空等，见 frame_guide audio）。`,
          `sources：\n${lines(compact.sources, (item) => item)}`,
          `tracks：\n${lines(compact.tracks, (item) => item)}`,
          `clips：\n${lines(compact.clips, (item) => item)}`,
          ...(compact.buses.length ? [`buses：\n${lines(compact.buses, (item) => item)}`] : []),
          `master：${JSON.stringify(document.master)}${document.linkedVideo ? "" : "\nlinkedVideo：false（视频图层的原声不进混音）"}`,
        ].join("\n"),
      };
    },
  });

  registry.add({
    name: "audio_edit",
    title: "编辑混音",
    description:
      "原子地编辑 audio.json：update（只改一项的部分字段，例如片段的 gain、start，音轨的 muted，master 的 gain；嵌套对象逐项合并，数组整体替换）、put（新增一项，或用完整内容替换同 id 的项）、remove、split、replace。如果作品还没有 audio.json，会自动创建并在 project.ts 中声明。clip 的 start/duration 是作品时间（秒），offset 是素材内起点。",
    guide: "audio",
    destructive: true,
    input: {
      work: workArg,
      operations: z.array(audioOperationSchema).min(1).max(100),
      ...editOptions,
      subtitles: z.boolean().default(true).describe("移动配音片段时，片段里的字幕跟着移动"),
    },
    publicInput: {
      work: workArg,
      operations: looseOperations(
        ["update", "put", "remove", "split", "replace"],
        '按顺序执行，全部成功才写入。例：{"op":"update","collection":"clips","id":"c1","patch":{"gain":0.5,"fadeOut":1}}、{"op":"update","collection":"master","patch":{"gain":0.8}}、{"op":"put","collection":"clips","value":{"id":"c2","track":"voice","source":"vo1","start":1.2,"duration":3.4}}（新增；id 相同则整项替换）、{"op":"remove","collection":"tracks","id":"fx"}、{"op":"split","id":"c1","at":5,"newId":"c1b"}。字段见 frame_guide audio',
      ),
      ...editOptions,
      subtitles: z.boolean().default(true).describe("移动配音片段（配音音轨上、或 voice/ 里的文件）时，片段里的字幕跟着移动"),
    },
    async run(args, ctx) {
      const work = await ctx.work();
      const before = (() => {
        try {
          return readAudio(work).document;
        } catch {
          return null;
        }
      })();
      const result = editAudio(work, args);
      let follow = { moved: [] };
      const meta = registry.services.works.meta(work);
      if (meta.ok) {
        follow = followSubtitles(before, result.document, meta.meta.subtitles, meta.meta.duration);
        if (args.subtitles !== false && follow.moved.length && !args.dryRun) await registry.services.works.update(work, { subtitles: [...follow.cues].sort((a, b) => a.start - b.start) });
      }
      if (!args.dryRun) await registry.services.materials?.lockReferenced(work);
      const { tracks, clips } = result.document;
      const summary = tracks
        .map((track) => {
          const own = clips.filter((clip) => clip.track === track.id);
          return `${track.name}(${track.id})：${own.map((clip) => `${clip.id} ${round(clip.start)}–${round(clip.start + clip.duration)}s`).join("，") || "空"}`;
        })
        .join("；");
      return {
        data: { sha256: result.sha256, tracks: tracks.length, clips: clips.length, dryRun: args.dryRun },
        meta: { sha256: result.sha256 },
        text: `${args.dryRun ? "预检通过（未写入）" : "已更新混音"}。${summary || "没有音轨"}${follow.moved.length ? (args.subtitles === false ? `\n字幕没有跟着配音移动（subtitles: false）：${follow.moved.map((line) => line.replace(/ [\d.]+–[\d.]+ 秒$/, "")).join("、")} 还在原来的时间` : `\n字幕跟着配音${args.dryRun ? "会" : ""}移动：${follow.moved.join("、")}（不想跟着动时传 subtitles: false）`) : ""}`,
      };
    },
  });
}

const round = (value) => Math.round(value * 100) / 100;
