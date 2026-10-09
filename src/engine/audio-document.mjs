import { z } from "zod";
import { audioEngines, audioProcessors, toneEffectNames } from "./audio-capabilities.mjs";
export { audioEngines, audioProcessors } from "./audio-capabilities.mjs";
import { toneOptionIssues } from "./tone-effect-options.mjs";
import { assetReferenceSchema } from "./visual-document.mjs";
import { mergePatch, unsetPath } from "./patch.mjs";
const n = z.number().finite();
const id = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
  .max(80);
const key = z.strictObject({
  at: n.nonnegative(),
  value: n,
  easing: z.enum(["linear", "hold"]).default("linear"),
});
export const automationSchema = z
  .array(key)
  .max(1000)
  .refine(
    (a) => a.every((k, i) => !i || k.at > a[i - 1].at),
    "Automation times must increase",
  );
export const stretchOptionsSchema = z.strictObject({
  tonalityHz: n.min(20).max(24000).default(8000),
  formantSemitones: n.min(-48).max(48).default(0),
  formantCompensation: z.boolean().default(false),
  formantBaseHz: n.min(0).max(2000).default(0),
  preset: z.enum(["default", "cheaper"]).default("default"),
  blockMs: n.min(0).max(500).default(0),
  intervalMs: n.min(0).max(250).default(0),
  splitComputation: z.boolean().default(false),
}).refine(v => !v.blockMs || !v.intervalMs || v.intervalMs <= v.blockMs, "Stretch interval must not exceed block length");
const effects = [
  ["tone", { effect: z.enum(toneEffectNames), options: z.record(z.string(), z.json()).superRefine((options,ctx)=>{for(const key of ["context","onload","onerror"])if(key in options)ctx.addIssue({code:"custom",path:[key],message:"Tone context and callbacks belong to the host; use createToneAudio for code callbacks"});}).default({}), tail: n.min(0).max(120).default(2) }],
  ["gain", { gain: n.min(0).max(4).default(1) }],
  ["pan", { pan: n.min(-1).max(1).default(0) }],
  [
    "filter",
    {
      type: z
        .enum([
          "lowpass",
          "highpass",
          "bandpass",
          "notch",
          "lowshelf",
          "highshelf",
          "peaking",
          "allpass",
        ])
        .default("lowpass"),
      frequency: n.min(20).max(20000).default(1200),
      q: n.min(0.01).max(30).default(0.707),
      gain: n.min(-36).max(36).default(0),
    },
  ],
  [
    "compressor",
    {
      threshold: n.min(-100).max(0).default(-24),
      knee: n.min(0).max(40).default(12),
      ratio: n.min(1).max(20).default(4),
      attack: n.min(0.001).max(1).default(0.01),
      release: n.min(0.01).max(1).default(0.2),
    },
  ],
  [
    "limiter",
    {
      ceiling: n.min(-24).max(0).default(-1),
      release: n.min(0.01).max(1).default(0.1),
    },
  ],
  [
    "delay",
    {
      time: n.min(0.001).max(2).default(0.25),
      feedback: n.min(0).max(0.8).default(0.25),
      mix: n.min(0).max(1).default(0.25),
    },
  ],
  [
    "reverb",
    {
      seconds: n.min(0.05).max(5).default(1.2),
      decay: n.min(0.1).max(8).default(3),
      mix: n.min(0).max(1).default(0.2),
      seed: z.number().int().default(1),
    },
  ],
  [
    "distortion",
    { drive: n.min(1).max(30).default(2), mix: n.min(0).max(1).default(0.25) },
  ],
  ["stereo", { width: n.min(0).max(2).default(1) }],
  [
    "duck",
    {
      track: id,
      amount: n.min(0).max(1).default(0.3),
      attack: n.min(0.001).max(1).default(0.03),
      release: n.min(0.01).max(2).default(0.3),
    },
  ],
];
export const audioProcessorSchema = z.discriminatedUnion(
  "type",
  effects.map(([type, shape]) =>
    z.strictObject({
      type: z.literal(type),
      id: id.optional(),
      bypass: z.boolean().default(false),
      ...Object.fromEntries(
        Object.entries(shape).map(([k, v]) => [k === "type" ? "mode" : k, v]),
      ),
    }),
  ),
).superRefine((processor, ctx) => {
  if (processor.type === "tone")
    for (const issue of toneOptionIssues(processor.effect, processor.options))
      ctx.addIssue({ code: "custom", path: ["options", ...issue.path], message: issue.message });
});
// The discovery registry and implemented schema must describe exactly the same
// processor collection, in the same stable order; never advertise unsupported ids.
if (
  effects.length !== audioProcessors.length ||
  effects.some(([type], index) => type !== audioProcessors[index].id)
)
  throw new Error("Audio processor capability registry does not match the schema");
export const audioSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id, kind: z.literal("file"), src: assetReferenceSchema }),
  z.strictObject({
    id,
    kind: z.literal("generated"),
    // A generator of the work's audio.ts, or a sound module of a material library.
    module: z.union([id, z.string().max(300).regex(/^materials\/[^/]+\/[^?#]+\.(?:m?[jt]sx?)$/, "素材库里的声音模块写 materials/<素材库>/<路径>.ts")]),
    trackId: z.string().min(1).max(100).default("main"),
    engine: z.enum(audioEngines.map((e) => e.id)).default("custom"),
  }),
]);
const strip = {
  gain: n.min(0).max(4).default(1),
  pan: n.min(-1).max(1).default(0),
  muted: z.boolean().default(false),
  processors: z.array(audioProcessorSchema).max(16).default([]),
  output: z.string().default("master"),
  sends: z
    .array(z.strictObject({ bus: id, gain: n.min(0).max(2).default(0.25) }))
    .max(8)
    .default([]),
};
export const audioChannelSchema = z.strictObject({
  id,
  name: z.string().min(1).max(100),
  ...strip,
});
export const audioClipSchema = z.strictObject({
  id,
  track: id,
  source: id,
  name: z.string().max(150).optional(),
  start: n.nonnegative(),
  duration: n.positive().max(3600),
  offset: n.nonnegative().default(0),
  phase: n.nonnegative().default(0),
  rate: n.min(0.05).max(16).default(1),
  pitch: n.min(-48).max(48).default(0),
  preservePitch: z.boolean().default(false),
  stretch: stretchOptionsSchema.optional(),
  loop: n.min(0.01).max(3600).optional(),
  gain: n.min(0).max(4).default(1),
  pan: n.min(-1).max(1).default(0),
  muted: z.boolean().default(false),
  fadeIn: n.nonnegative().default(0),
  fadeOut: n.nonnegative().default(0),
  fadeOffset: n.nonnegative().default(0),
  fadeDuration: n.positive().optional(),
  automation: automationSchema.default([]),
});
export const audioDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sources: z.array(audioSourceSchema).max(256).default([]),
  tracks: z.array(audioChannelSchema).max(64).default([]),
  clips: z.array(audioClipSchema).max(1024).default([]),
  buses: z.array(audioChannelSchema).max(16).default([]),
  master: z
    .strictObject({
      gain: n.min(0).max(4).default(1),
      processors: z.array(audioProcessorSchema).max(16).default([]),
    })
    .default({ gain: 1, processors: [] }),
  linkedVideo: z.boolean().default(true),
});
export function validateAudioDocument(value, { projectId, duration } = {}) {
  const d = audioDocumentSchema.parse(value);
  for (const [kind, items] of Object.entries({
    source: d.sources,
    track: d.tracks,
    clip: d.clips,
    bus: d.buses,
  })) {
    const seen = new Set();
    for (const v of items) {
      if (seen.has(v.id)) throw Error(`audio.json 中 ${kind} id 重复：${v.id}`);
      seen.add(v.id);
    }
  }
  const sources = new Set(d.sources.map((s) => s.id)),
    tracks = new Set(d.tracks.map((t) => t.id)),
    buses = new Map(d.buses.map((b) => [b.id, b]));
  if (
    buses.has("master") ||
    d.tracks.some((t) => buses.has(t.id) || t.id === "master")
  )
    throw Error("音轨与总线的 id 不能相同，也不能叫 master");
  for (const s of d.sources)
    if (
      s.kind === "file" &&
      projectId &&
      !s.src.startsWith("films/" + projectId + "/") &&
      !s.src.startsWith("materials/")
    )
      throw Error(`素材 ${s.src} 不属于这个作品，应为 films/${projectId}/... 或素材库文件 materials/...（来源 ${s.id}）`);
  for (const c of d.clips) {
    if (!sources.has(c.source))
      throw Error(`片段 ${c.id} 的 source「${c.source}」不存在（现有：${[...sources].join("、") || "无"}）`);
    if (!tracks.has(c.track))
      throw Error(`片段 ${c.id} 的 track「${c.track}」不存在（现有：${[...tracks].join("、") || "无"}）`);
    if (duration !== undefined && c.start + c.duration > duration + 1e-7)
      throw Error(`片段 ${c.id} 超出作品时长：start ${c.start} + duration ${c.duration} = ${+(c.start + c.duration).toFixed(3)} > ${duration} 秒`);
    if (c.fadeIn + c.fadeOut > (c.fadeDuration ?? c.duration) + 1e-7)
      throw Error(`片段 ${c.id} 的淡入 ${c.fadeIn} + 淡出 ${c.fadeOut} 超过了片段长度 ${c.fadeDuration ?? c.duration}`);
    if (c.automation.some((k) => k.value < 0 || k.value > 4))
      throw Error(`片段 ${c.id} 的音量自动化取值必须在 0–4 之间`);
  }
  const done = new Set(),
    visiting = new Set();
  const visit = (c) => {
    if (visiting.has(c.id)) throw Error(`音频路由形成了循环：${c.id}`);
    if (done.has(c.id)) return;
    if (new Set(c.sends.map((s) => s.bus)).size !== c.sends.length)
      throw Error(`${c.id} 向同一总线发送了多次`);
    visiting.add(c.id);
    for (const dest of [c.output, ...c.sends.map((s) => s.bus)]) {
      if (dest === "master") continue;
      if (!buses.has(dest)) throw Error(`${c.id} 输出到不存在的总线：${dest}`);
      visit(buses.get(dest));
    }
    visiting.delete(c.id);
    done.add(c.id);
  };
  for (const c of [...d.tracks, ...d.buses]) visit(c);
  for (const c of [...d.tracks, ...d.buses, d.master]) {
    const ids = c.processors.map((p) => p.id).filter(Boolean);
    if (new Set(ids).size !== ids.length)
      throw Error(`${c.id ?? "master"} 的处理器 id 重复`);
    for (const p of c.processors)
      if (p.type === "duck" && !tracks.has(p.track))
        throw Error(`${c.id ?? "master"} 的 duck 处理器指向不存在的音轨：${p.track}`);
  }
  return d;
}
export function compileAudioTracks(value) {
  const d = validateAudioDocument(value),
    sources = new Map(d.sources.map((s) => [s.id, s]));
  return d.clips.map((c) => {
    const s = sources.get(c.source),
      channel = d.tracks.find((t) => t.id === c.track);
    return {
      id: "audio:" + c.id,
      name: c.name ?? channel.name,
      kind: s.kind,
      ...(s.kind === "file"
        ? { src: s.src }
        : { module: s.module, sourceTrackId: s.trackId }),
      start: c.start,
      duration: c.duration,
      offset: c.offset,
      phase: c.phase,
      playbackRate: c.rate,
      pitch: c.pitch,
      preservePitch: c.preservePitch,
      stretch: c.stretch,
      ...(c.loop ? { loop: c.loop } : {}),
      gain: c.gain,
      muted: c.muted || channel.muted,
      channel: c.track,
      pan: c.pan,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut,
      fadeOffset: c.fadeOffset,
      fadeDuration: c.fadeDuration,
      automation: c.automation,
    };
  });
}
export const audioOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("replace"), document: audioDocumentSchema }),
  z.strictObject({
    op: z.literal("put"),
    collection: z.enum(["sources", "tracks", "clips", "buses"]),
    value: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    op: z.literal("update"),
    collection: z.enum(["sources", "tracks", "clips", "buses", "master"]),
    id: id.optional(),
    patch: z.record(z.string(), z.unknown()),
    unset: z.array(z.string().regex(/^[\w-]+(\.[\w-]+)*$/)).optional(),
  }),
  z.strictObject({
    op: z.literal("remove"),
    collection: z.enum(["sources", "tracks", "clips", "buses"]),
    id,
  }),
  z.strictObject({
    op: z.literal("split"),
    id,
    at: n.nonnegative(),
    newId: id,
  }),
]);
export function editAudioDocument(value, operations, context) {
  let d = structuredClone(validateAudioDocument(value, context));
  for (const raw of operations) {
    const op = audioOperationSchema.parse(raw);
    if (op.op === "replace") {
      d = structuredClone(op.document);
      continue;
    }
    if (op.op === "put") {
      const a = d[op.collection],
        i = a.findIndex((v) => v.id === op.value.id);
      if (i < 0) a.push(op.value);
      else a[i] = op.value;
    }
    if (op.op === "update") {
      // Only the fields given change; nested objects merge, arrays are replaced.
      const apply = (item) => {
        const next = mergePatch(item, op.patch);
        for (const path of op.unset ?? []) unsetPath(next, path);
        return next;
      };
      if (op.collection === "master") d.master = apply(d.master);
      else {
        if (!op.id) throw Error(`修改 ${op.collection} 中的项需要 id`);
        if (op.patch.id !== undefined && op.patch.id !== op.id) throw Error("update 不能修改 id；要换 id 用 put 新增再 remove 旧的");
        const a = d[op.collection],
          i = a.findIndex((v) => v.id === op.id);
        if (i < 0) throw Error(`${op.collection} 中没有 id 为 ${op.id} 的项（现有：${a.map((v) => v.id).join("、") || "无"}）`);
        a[i] = apply(a[i]);
      }
    }
    if (op.op === "remove") {
      const a = d[op.collection],
        i = a.findIndex((v) => v.id === op.id);
      if (i < 0) throw Error(`${op.collection} 中没有 id 为 ${op.id} 的项`);
      a.splice(i, 1);
    }
    if (op.op === "split") {
      const i = d.clips.findIndex((c) => c.id === op.id);
      if (i < 0) throw Error(`没有 id 为 ${op.id} 的片段`);
      const c = d.clips[i],
        elapsed = op.at - c.start;
      if (elapsed <= 0 || elapsed >= c.duration)
        throw Error(`切分点 ${op.at} 必须在片段 ${op.id} 内部（${c.start}–${c.start + c.duration} 秒）`);
      c.fadeDuration ??= c.duration;
      const right = {
        ...structuredClone(c),
        id: op.newId,
        start: op.at,
        duration: c.duration - elapsed,
        phase: c.phase + elapsed * c.rate,
        fadeOffset: c.fadeOffset + elapsed,
      };
      // Automation uses original clip-local time, preserved by fadeOffset.
      c.duration = elapsed;
      d.clips.splice(i + 1, 0, right);
    }
  }
  return validateAudioDocument(d, context);
}
export function audioSegments(track, projectDuration, from, length) {
  const start = Math.max(from, track.start ?? 0),
    end = Math.min(
      from + length,
      projectDuration,
      (track.start ?? 0) + (track.duration ?? projectDuration),
    );
  const out = [];
  if (end <= start) return out;
  const rate = track.playbackRate ?? 1,
    base = track.offset ?? 0,
    phase = track.phase ?? 0;
  let at = start;
  while (at < end - 1e-9) {
    const t = (at - (track.start ?? 0)) * rate + phase,
      local = track.loop ? ((t % track.loop) + track.loop) % track.loop : t;
    const duration = Math.min(
      end - at,
      track.loop ? (track.loop - local) / rate : end - at,
    );
    if (duration < 1e-9) break;
    out.push({
      delay: at - from,
      offset: base + local,
      duration: duration * rate,
    });
    at += duration;
    if (out.length > 100000) throw Error("Audio segment budget exceeded");
  }
  return out;
}
export function audioAssets(d) {
  return d.sources.filter((s) => s.kind === "file").map((s) => s.src);
}
