import { z } from "zod";
import { workArg, asJson } from "./registry.mjs";

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
import { visualOperationSchema } from "../../src/engine/visual-document.mjs";
import { audioOperationSchema } from "../../src/engine/audio-document.mjs";

export function registerDocumentTools(registry) {
  registry.add({
    name: "layers_get",
    title: "读取图层",
    description:
      "读取 visual.json 图层时间轴（图片/视频/颜色/Lottie/scene 模块图层，含位置、透明度关键帧、淡入淡出）及其 sha256。只有使用 loadVisual 的作品才有。",
    readOnly: true,
    input: { work: workArg },
    async run(_, ctx) {
      const result = readVisual(await ctx.work());
      return asJson({ sha256: result.sha256, duration: result.duration, document: result.document });
    },
  });

  registry.add({
    name: "layers_edit",
    title: "编辑图层",
    description:
      "原子地编辑 visual.json：add（加图层）、update（patch 部分字段，unset 删除字段）、remove、reorder（图层顺序：越靠后越在上面）、split（在某时间切开）、replace（整体替换）。transform 的 x/y/width/height 是相对画面的 0..1 比例，可以是数字或关键帧数组 [{at,value,easing}]。",
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
        '按顺序执行，全部成功才写入。例：{"op":"add","clip":{"id":"logo","source":{"kind":"image","src":"films/<名称>/logo.png"},"start":2,"duration":3}}、{"op":"update","id":"logo","patch":{"start":3},"unset":["crop"]}、{"op":"remove","id":"x"}、{"op":"reorder","id":"x","index":0}、{"op":"split","id":"x","at":5,"newId":"x2"}。字段见 frame_guide layers',
      ),
      ...editOptions,
    },
    async run(args, ctx) {
      const result = editVisual(await ctx.work(), args);
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
      "读取 audio.json 多轨混音（sources 素材、tracks 音轨、clips 片段、buses 总线、master 主输出）。作品还没有音频时 document 为 null（audio_edit / audio_place 会自动创建）。",
    readOnly: true,
    input: { work: workArg },
    async run(_, ctx) {
      return asJson(readAudio(await ctx.work()));
    },
  });

  registry.add({
    name: "audio_edit",
    title: "编辑混音",
    description:
      "原子地编辑 audio.json：put（新增或替换 sources/tracks/clips/buses 中的一项）、remove、split、replace。如果作品还没有 audio.json，会自动创建并在 project.ts 中声明。clip 的 start/duration 是作品时间（秒），offset 是素材内起点。",
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
        ["put", "remove", "split", "replace"],
        '按顺序执行，全部成功才写入。例：{"op":"put","collection":"clips","value":{"id":"c2","track":"voice","source":"vo1","start":1.2,"duration":3.4}}（id 相同则整项替换）、{"op":"remove","collection":"tracks","id":"fx"}、{"op":"split","id":"c1","at":5,"newId":"c1b"}。字段见 frame_guide audio',
      ),
      ...editOptions,
    },
    async run(args, ctx) {
      const result = editAudio(await ctx.work(), args);
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
