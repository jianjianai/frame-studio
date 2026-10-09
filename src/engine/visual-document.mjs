import { z } from "zod";
import { rendererIds } from "./adapters.mjs";
import { mergePatch, unsetPath } from "./patch.mjs";
const number = z.number().finite();
const id = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "id 只能包含字母、数字、_ 和 -，且以字母开头")
  .max(80);
export const assetReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      /^(films\/[a-z][a-z0-9-]*|materials\/[^/]+)\//.test(value) &&
      !/[\\\\:%?#\u0000-\u001f]/.test(value) &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
    "素材地址应为 films/<作品名称>/<public 下的路径>，或素材库文件 materials/<素材库>/<路径>",
  );
const key = z.strictObject({
  at: number.nonnegative(),
  value: number,
  easing: z.enum(["linear", "hold", "smooth"]).optional(),
});
const animated = z.union([
  number,
  z
    .array(key)
    .min(1)
    .max(1000)
    .refine(
      (keys) => keys.every((k, i) => !i || k.at > keys[i - 1].at),
      "关键帧的 at 必须严格递增",
    ),
]);
export const visualSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("image"), src: assetReferenceSchema }),
  z.strictObject({ kind: z.literal("video"), src: assetReferenceSchema }),
  z.strictObject({ kind: z.literal("lottie"), src: assetReferenceSchema }),
  z.strictObject({
    kind: z.literal("sequence"),
    frames: z.array(assetReferenceSchema).min(1).max(10000),
    fps: number.positive().max(120),
  }),
  z.strictObject({
    kind: z.literal("scene"),
    module: id,
    engine: z.enum(rendererIds),
    parameters: z.record(z.string(), number).optional(),
  }),
  z.strictObject({
    kind: z.literal("color"),
    color: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, "颜色应为 #rrggbb 或 #rrggbbaa"),
  }),
]);
export const visualClipSchema = z
  .strictObject({
    id,
    name: z.string().max(150).optional(),
    source: visualSourceSchema,
    start: number.nonnegative(),
    duration: number.positive().max(3600),
    offset: number.nonnegative().default(0),
    phase: number.nonnegative().default(0),
    rate: number.min(0.05).max(16).default(1),
    loop: number.positive().max(3600).optional(),
    audio: z
      .strictObject({
        enabled: z.boolean(),
        gain: number.min(0).max(4).optional(),
        muted: z.boolean().optional(),
      })
      .optional(),
    hidden: z.boolean().optional(),
    transform: z
      .strictObject({
        x: animated.optional(),
        y: animated.optional(),
        width: animated.optional(),
        height: animated.optional(),
        rotation: animated.optional(),
        opacity: animated.optional(),
      })
      .optional(),
    fit: z.enum(["contain", "cover", "fill"]).default("contain"),
    blend: z
      .enum([
        "source-over",
        "multiply",
        "screen",
        "overlay",
        "darken",
        "lighten",
        "difference",
        "destination-in",
        "destination-out",
      ])
      .default("source-over"),
    crop: z
      .strictObject({
        x: number.min(0).max(1),
        y: number.min(0).max(1),
        width: number.positive().max(1),
        height: number.positive().max(1),
      })
      .refine((r) => r.x + r.width <= 1 && r.y + r.height <= 1)
      .optional(),
    fadeIn: number.nonnegative().optional(),
    fadeOut: number.nonnegative().optional(),
    fadeOffset: number.nonnegative().optional(),
    fadeDuration: number.positive().optional(),
  })
  .superRefine((clip, ctx) => {
    if (
      (clip.fadeIn ?? 0) + (clip.fadeOut ?? 0) >
      (clip.fadeDuration ?? clip.duration)
    )
      ctx.addIssue({ code: "custom", message: "淡入 + 淡出超过了图层时长" });
  });
export const visualDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    background: z
      .string()
      .regex(/^(transparent|#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?)$/, "背景应为 transparent、#rrggbb 或 #rrggbbaa")
      .default("transparent"),
    clips: z.array(visualClipSchema).max(128),
  })
  .superRefine((doc, ctx) => {
    if (new Set(doc.clips.map((c) => c.id)).size !== doc.clips.length)
      ctx.addIssue({ code: "custom", message: "图层 id 不能重复" });
  });
export function validateVisualDocument(value, { projectId, duration } = {}) {
  const doc = visualDocumentSchema.parse(value);
  for (const clip of doc.clips) {
    if (duration !== undefined && clip.start + clip.duration > duration + 1e-7)
      throw new Error(`图层 ${clip.id} 超出作品时长：start ${clip.start} + duration ${clip.duration} = ${+(clip.start + clip.duration).toFixed(3)} > ${duration} 秒`);
    for (const src of clip.source.frames ??
      (clip.source.src ? [clip.source.src] : []))
      if (projectId && !src.startsWith("films/" + projectId + "/") && !src.startsWith("materials/"))
        throw new Error(`图层 ${clip.id} 的素材 ${src} 不属于这个作品，应为 films/${projectId}/...`);
  }
  return doc;
}
export function clipTime(clip, time) {
  if (clip.hidden || time < clip.start || time >= clip.start + clip.duration)
    return null;
  const elapsed = (time - clip.start) * clip.rate + (clip.phase ?? 0);
  return clip.offset + (clip.loop ? elapsed % clip.loop : elapsed);
}
export function sampleValue(value, time, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === "number") return value;
  if (time <= value[0].at) return value[0].value;
  for (let i = 1; i < value.length; i++)
    if (time < value[i].at) {
      const a = value[i - 1],
        b = value[i];
      let t = (time - a.at) / (b.at - a.at);
      if (a.easing === "hold") t = 0;
      if (a.easing === "smooth") t = t * t * (3 - 2 * t);
      return a.value + (b.value - a.value) * t;
    }
  return value[value.length - 1].value;
}
/** `{ opacity: 0.5 }` instead of `{ transform: { opacity: 0.5 } }` is the usual slip. */
const misplacedTransform = (issue) => {
  const keys = issue.code === "unrecognized_keys" ? issue.keys.filter((key) => ["x", "y", "width", "height", "rotation", "opacity"].includes(key)) : [];
  return keys.length ? `${keys.join("、")} 要写在 transform 里，例如 {"transform":{"${keys[0]}":…}}` : undefined;
};
const UNSETTABLE = ["name", "offset", "phase", "rate", "loop", "audio", "hidden", "transform", "fit", "blend", "crop", "fadeIn", "fadeOut", "fadeOffset", "fadeDuration"];
/** Pure edits shared by GUI, CLI and MCP; writes remain compare-and-swap transactions. */
export const visualOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("replace"), document: visualDocumentSchema }),
  z.strictObject({
    op: z.literal("add"),
    clip: visualClipSchema,
    index: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    op: z.literal("update"),
    id,
    // Nested objects merge field by field; the merged clip is validated as a whole.
    patch: z
      .strictObject({
        ...visualClipSchema.shape,
        source: z.record(z.string(), z.unknown()),
        offset: visualClipSchema.shape.offset.removeDefault(),
        phase: visualClipSchema.shape.phase.removeDefault(),
        rate: visualClipSchema.shape.rate.removeDefault(),
        fit: visualClipSchema.shape.fit.removeDefault(),
        blend: visualClipSchema.shape.blend.removeDefault(),
        audio: z.record(z.string(), z.unknown()),
        crop: z.record(z.string(), z.unknown()),
      }, { error: misplacedTransform })
      .omit({ id: true })
      .partial(),
    unset: z
      .array(
        z
          .string()
          .refine(
            (path) => UNSETTABLE.includes(path) || /^(transform|audio|source\.parameters)\.[\w-]+$/.test(path),
            `可以删除的字段：${UNSETTABLE.join("、")}，或嵌套字段如 transform.opacity、audio.gain、source.parameters.<名称>`,
          ),
      )
      .optional(),
  }),
  z.strictObject({ op: z.literal("remove"), id }),
  z.strictObject({
    op: z.literal("reorder"),
    id,
    index: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal("split"),
    id,
    at: number.nonnegative(),
    newId: id,
  }),
]);
export function editVisualDocument(value, operations, context) {
  let doc = structuredClone(validateVisualDocument(value, context));
  for (const raw of operations) {
    const op = visualOperationSchema.parse(raw);
    if (op.op === "replace") {
      doc = validateVisualDocument(op.document, context);
      continue;
    }
    const index = "id" in op ? doc.clips.findIndex((c) => c.id === op.id) : -1;
    if ("id" in op && index < 0) throw new Error(`没有 id 为 ${op.id} 的图层（现有：${doc.clips.map((c) => c.id).join("、") || "无"}）`);
    if (op.op === "add")
      doc.clips.splice(
        Math.min(op.index ?? doc.clips.length, doc.clips.length),
        0,
        op.clip,
      );
    if (op.op === "remove") doc.clips.splice(index, 1);
    if (op.op === "update") {
      const clip = mergePatch(doc.clips[index], op.patch);
      for (const path of op.unset ?? []) unsetPath(clip, path);
      doc.clips[index] = clip;
    }
    if (op.op === "reorder") {
      const [clip] = doc.clips.splice(index, 1);
      doc.clips.splice(Math.min(op.index, doc.clips.length), 0, clip);
    }
    if (op.op === "split") {
      const clip = doc.clips[index],
        elapsed = op.at - clip.start;
      if (elapsed <= 0 || elapsed >= clip.duration)
        throw new Error(`切分点 ${op.at} 必须在图层 ${op.id} 内部（${clip.start}–${clip.start + clip.duration} 秒）`);
      // Keyframes are measured in source time; splitting preserves motion and media phase.
      clip.fadeDuration ??= clip.duration;
      const right = {
        ...structuredClone(clip),
        id: op.newId,
        start: op.at,
        duration: clip.duration - elapsed,
        phase: (clip.phase ?? 0) + elapsed * clip.rate,
        fadeOffset: (clip.fadeOffset ?? 0) + elapsed,
      };
      clip.duration = elapsed;
      doc.clips.splice(index + 1, 0, right);
    }
    doc = validateVisualDocument(doc, context);
  }
  return doc;
}
