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
      "原子地编辑 visual.json：add（加图层）、update（只改给出的字段：嵌套对象逐项合并，例如 patch {transform:{opacity:0.5}} 保留原来的 x/y；数组整体替换；unset 删除字段，可写 transform.opacity）、remove、reorder（图层顺序：越靠后越在上面）、split（在某时间切开）、replace（整体替换）。transform 的 x/y/width/height 是相对画面的 0..1 比例，可以是数字或关键帧数组 [{at,value,easing}]。",
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
      const result = editVisual(work, args);
      if (!args.dryRun) await registry.services.materials?.lockReferenced(work);
      const summary = result.document.clips.map((clip) => `${clip.id} ${round(clip.start)}–${round(clip.start + clip.duration)}s`).join("，");
      return {
        data: { sha256: result.sha256, clips: result.document.clips.length, dryRun: args.dryRun },
        meta: { sha256: result.sha256 },
        text: `${args.dryRun ? "预检通过（未写入）" : "已更新图层"}。图层（从下到上）：${summary || "无"}`,
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
    },
    publicInput: {
      work: workArg,
      operations: looseOperations(
        ["update", "put", "remove", "split", "replace"],
        '按顺序执行，全部成功才写入。例：{"op":"update","collection":"clips","id":"c1","patch":{"gain":0.5,"fadeOut":1}}、{"op":"update","collection":"master","patch":{"gain":0.8}}、{"op":"put","collection":"clips","value":{"id":"c2","track":"voice","source":"vo1","start":1.2,"duration":3.4}}（新增；id 相同则整项替换）、{"op":"remove","collection":"tracks","id":"fx"}、{"op":"split","id":"c1","at":5,"newId":"c1b"}。字段见 frame_guide audio',
      ),
      ...editOptions,
    },
    async run(args, ctx) {
      const work = await ctx.work();
      const result = editAudio(work, args);
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
        text: `${args.dryRun ? "预检通过（未写入）" : "已更新混音"}。${summary || "没有音轨"}`,
      };
    },
  });
}

const round = (value) => Math.round(value * 100) / 100;
