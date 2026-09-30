import { z } from "zod";
import { assetReferenceSchema } from "./visual-document.mjs";
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
const effects = [
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
);
export const audioProcessors = effects.map(([type]) => ({
  id: type,
  name: {
    gain: "增益",
    pan: "声像",
    filter: "均衡 / 滤波",
    compressor: "压缩",
    limiter: "峰值保护",
    delay: "延迟",
    reverb: "混响",
    distortion: "失真",
    stereo: "立体声宽度",
    duck: "旁白避让",
  }[type],
}));
export const audioEngines = [
  { id: "web-audio", name: "Web Audio", realtime: true, offline: true },
  { id: "tone", name: "Tone.js", realtime: true, offline: true },
  {
    id: "worker-pcm",
    name: "PCM Worker / WASM",
    realtime: true,
    offline: true,
  },
  { id: "soundfont", name: "SoundFont / MIDI", realtime: true, offline: true },
  { id: "custom", name: "项目自定义生成器", realtime: true, offline: true },
];
export const audioSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id, kind: z.literal("file"), src: assetReferenceSchema }),
  z.strictObject({
    id,
    kind: z.literal("generated"),
    module: id,
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
  }))
    if (new Set(items.map((v) => v.id)).size !== items.length)
      throw Error("Duplicate audio " + kind + " id");
  const sources = new Set(d.sources.map((s) => s.id)),
    tracks = new Set(d.tracks.map((t) => t.id)),
    buses = new Map(d.buses.map((b) => [b.id, b]));
  if (
    buses.has("master") ||
    d.tracks.some((t) => buses.has(t.id) || t.id === "master")
  )
    throw Error("Track/bus ids must be distinct and cannot be master");
  for (const s of d.sources)
    if (
      s.kind === "file" &&
      projectId &&
      !s.src.startsWith("films/" + projectId + "/")
    )
      throw Error("Cross-project audio asset");
  for (const c of d.clips) {
    if (!sources.has(c.source) || !tracks.has(c.track))
      throw Error("Unknown audio source/track: " + c.id);
    if (duration !== undefined && c.start + c.duration > duration + 1e-7)
      throw Error("Audio clip exceeds project duration");
    if (c.fadeIn + c.fadeOut > (c.fadeDuration ?? c.duration) + 1e-7)
      throw Error("Audio fades exceed clip duration");
    if (c.automation.some((k) => k.value < 0 || k.value > 4))
      throw Error("Audio gain automation must be 0..4");
  }
  const done = new Set(),
    visiting = new Set();
  const visit = (c) => {
    if (visiting.has(c.id)) throw Error("Audio routing cycle");
    if (done.has(c.id)) return;
    if (new Set(c.sends.map((s) => s.bus)).size !== c.sends.length)
      throw Error("Duplicate audio send");
    visiting.add(c.id);
    for (const dest of [c.output, ...c.sends.map((s) => s.bus)]) {
      if (dest === "master") continue;
      if (!buses.has(dest)) throw Error("Unknown audio bus: " + dest);
      visit(buses.get(dest));
    }
    visiting.delete(c.id);
    done.add(c.id);
  };
  for (const c of [...d.tracks, ...d.buses]) visit(c);
  for (const c of [...d.tracks, ...d.buses, d.master]) {
    const ids = c.processors.map((p) => p.id).filter(Boolean);
    if (new Set(ids).size !== ids.length)
      throw Error("Duplicate processor id in channel");
    for (const p of c.processors)
      if (p.type === "duck" && !tracks.has(p.track))
        throw Error("Unknown ducking trigger track");
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
    if (op.op === "remove") {
      const a = d[op.collection],
        i = a.findIndex((v) => v.id === op.id);
      if (i < 0) throw Error("Unknown audio item");
      a.splice(i, 1);
    }
    if (op.op === "split") {
      const i = d.clips.findIndex((c) => c.id === op.id);
      if (i < 0) throw Error("Unknown audio clip");
      const c = d.clips[i],
        elapsed = op.at - c.start;
      if (elapsed <= 0 || elapsed >= c.duration)
        throw Error("Split must be inside clip");
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
