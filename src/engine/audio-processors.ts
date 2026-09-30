import type { AudioTrack } from "./types";
export type Processor = { type: string; bypass?: boolean; [key: string]: any };
export type Channel = {
  id: string;
  gain: number;
  pan: number;
  muted: boolean;
  processors: Processor[];
  output: string;
  sends: { bus: string; gain: number }[];
};
export type AudioMixDocument = {
  tracks: Channel[];
  buses: Channel[];
  clips: { track: string; start: number; duration: number; muted?: boolean }[];
  master: { gain: number; processors: Processor[] };
};
export function effectTail(processors: Processor[]): number {
  return processors
    .filter((p) => !p.bypass)
    .reduce(
      (n, p) =>
        n +
        (p.type === "distortion"
          ? 0.05
          : p.type === "reverb"
            ? p.seconds
            : p.type === "delay"
              ? p.time *
                (p.feedback
                  ? Math.ceil(Math.log(0.00001) / Math.log(p.feedback))
                  : 1)
              : p.type === "filter"
                ? Math.max(0.05, (12 * p.q) / (Math.PI * p.frequency))
                : ["compressor", "limiter"].includes(p.type)
                  ? p.release * 12 + 0.01
                  : 0),
      0,
    );
}
export function mixPreroll(doc?: AudioMixDocument) {
  if (!doc) return 0;
  const buses = new Map(doc.buses.map((b) => [b.id, b]));
  const cache = new Map<string, number>();
  const tail = (c: Channel): number => {
    if (cache.has(c.id)) return cache.get(c.id)!;
    const result =
      effectTail(c.processors) +
      Math.max(
        0,
        ...[c.output, ...c.sends.map((s) => s.bus)]
          .filter((id) => id !== "master")
          .map((id) => tail(buses.get(id)!)),
      );
    cache.set(c.id, result);
    return result;
  };
  return (
    effectTail(doc.master.processors) +
    Math.max(0, ...doc.tracks.map(tail), ...doc.buses.map(tail))
  );
}
export function buildMixGraph(
  context: BaseAudioContext,
  destination: AudioNode,
  doc: AudioMixDocument | undefined,
  from: number,
  when: number,
  rate: number,
) {
  const owned: AudioNode[] = [],
    nodes = new Map<string, GainNode>();
  const make = <T extends AudioNode>(n: T) => {
    owned.push(n);
    return n;
  };
  const series = (input: AudioNode, processors: Processor[]) => {
    let current = input;
    for (const p of processors) {
      if (p.bypass) continue;
      let output: AudioNode;
      if (p.type === "gain") {
        const n = make(context.createGain());
        n.gain.value = p.gain;
        current.connect(n);
        output = n;
      } else if (p.type === "pan") {
        const n = make(context.createStereoPanner());
        n.pan.value = p.pan;
        current.connect(n);
        output = n;
      } else if (p.type === "filter") {
        const n = make(context.createBiquadFilter());
        n.type = p.mode;
        n.frequency.value = p.frequency;
        n.Q.value = p.q;
        n.gain.value = p.gain;
        current.connect(n);
        output = n;
      } else if (p.type === "compressor" || p.type === "limiter") {
        const n = make(context.createDynamicsCompressor());
        n.threshold.value = p.type === "limiter" ? p.ceiling : p.threshold;
        n.knee.value = p.type === "limiter" ? 0 : p.knee;
        n.ratio.value = p.type === "limiter" ? 20 : p.ratio;
        n.attack.value = p.type === "limiter" ? 0.001 : p.attack;
        n.release.value = p.release;
        current.connect(n);
        output = n;
        if (p.type === "limiter") {
          const guard = make(context.createWaveShaper()),
            curve = new Float32Array(8193),
            ceiling = Math.pow(10, p.ceiling / 20);
          for (let i = 0; i < curve.length; i++)
            curve[i] = Math.max(
              -ceiling,
              Math.min(ceiling, (i / (curve.length - 1)) * 2 - 1),
            );
          guard.curve = curve;
          n.connect(guard);
          output = guard;
        }
      } else if (p.type === "duck") {
        const n = make(context.createGain());
        current.connect(n);
        output = n;
        const triggers = (doc?.clips ?? []).filter(
          (c) =>
            c.track === p.track &&
            !c.muted &&
            !doc?.tracks.find((t) => t.id === c.track)?.muted,
        );
        const events = new Set([
          from,
          ...triggers.flatMap((c) => [
            Math.max(0, c.start - p.attack),
            c.start,
            c.start + c.duration,
            c.start + c.duration + p.release,
          ]),
        ]);
        const value = (t: number) =>
          Math.min(
            1,
            ...triggers.map((c) =>
              t < c.start - p.attack || t > c.start + c.duration + p.release
                ? 1
                : t < c.start
                  ? 1 - ((1 - p.amount) * (t - c.start + p.attack)) / p.attack
                  : t <= c.start + c.duration
                    ? p.amount
                    : p.amount +
                      ((1 - p.amount) * (t - c.start - c.duration)) / p.release,
            ),
          );
        n.gain.setValueAtTime(value(from), when);
        for (const t of [...events].sort((a, b) => a - b))
          if (t > from)
            n.gain.linearRampToValueAtTime(value(t), when + (t - from) / rate);
      } else if (p.type === "stereo") {
        const split = make(context.createChannelSplitter(2)),
          merge = make(context.createChannelMerger(2));
        current.connect(split);
        for (let input = 0; input < 2; input++)
          for (let output = 0; output < 2; output++) {
            const g = make(context.createGain());
            g.gain.value = (input === output ? 1 + p.width : 1 - p.width) / 2;
            split.connect(g, input);
            g.connect(merge, 0, output);
          }
        output = merge;
      } else {
        const sum = make(context.createGain()),
          dry = make(context.createGain()),
          wet = make(context.createGain());
        dry.gain.value = 1 - p.mix;
        wet.gain.value = p.mix;
        current.connect(dry);
        dry.connect(sum);
        wet.connect(sum);
        if (p.type === "delay") {
          const delay = make(context.createDelay(2)),
            feedback = make(context.createGain());
          delay.delayTime.value = p.time;
          feedback.gain.value = p.feedback;
          current.connect(delay);
          delay.connect(wet);
          delay.connect(feedback);
          feedback.connect(delay);
        } else if (p.type === "reverb") {
          const convolver = make(context.createConvolver()),
            length = Math.ceil(p.seconds * context.sampleRate),
            impulse = context.createBuffer(2, length, context.sampleRate);
          let seed = p.seed >>> 0;
          for (let c = 0; c < 2; c++) {
            const a = impulse.getChannelData(c);
            for (let i = 0; i < length; i++) {
              seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
              a[i] =
                (seed / 2147483648 - 1) * Math.pow(1 - i / length, p.decay);
            }
          }
          convolver.buffer = impulse;
          current.connect(convolver);
          convolver.connect(wet);
        } else if (p.type === "distortion") {
          const n = make(context.createWaveShaper()),
            curve = new Float32Array(4097);
          for (let i = 0; i < curve.length; i++) {
            const x = (i / (curve.length - 1)) * 2 - 1;
            curve[i] = Math.tanh(p.drive * x) / Math.tanh(p.drive);
          }
          n.curve = curve;
          n.oversample = "4x";
          current.connect(n);
          n.connect(wet);
        } else throw Error("Unsupported audio processor: " + p.type);
        output = sum;
      }
      current = output;
    }
    return current;
  };
  try {
    const master = make(context.createGain());
    master.gain.value = doc?.master.gain ?? 1;
    series(master, doc?.master.processors ?? []).connect(destination);
    nodes.set("master", master);
    for (const c of [...(doc?.tracks ?? []), ...(doc?.buses ?? [])])
      nodes.set(c.id, make(context.createGain()));
    for (const c of [...(doc?.tracks ?? []), ...(doc?.buses ?? [])]) {
      const input = nodes.get(c.id)!,
        gain = make(context.createGain()),
        pan = make(context.createStereoPanner());
      gain.gain.value = c.muted ? 0 : c.gain;
      pan.pan.value = c.pan;
      input.connect(gain);
      gain.connect(pan);
      const out = series(pan, c.processors);
      out.connect(nodes.get(c.output)!);
      for (const s of c.sends) {
        const g = make(context.createGain());
        g.gain.value = s.gain;
        out.connect(g);
        g.connect(nodes.get(s.bus)!);
      }
    }
    return {
      destination: (track: AudioTrack) =>
        nodes.get(track.channel ?? "master") ?? master,
      dispose: () => {
        for (const n of owned.reverse()) n.disconnect();
      },
    };
  } catch (e) {
    for (const n of owned.reverse()) n.disconnect();
    throw e;
  }
}
export function scheduleClipEnvelope(
  param: AudioParam,
  track: AudioTrack,
  from: number,
  length: number,
  when: number,
  rate: number,
) {
  const start = track.start ?? 0,
    fadeOffset = track.fadeOffset ?? 0,
    duration = track.fadeDuration ?? track.duration ?? length,
    keys = track.automation ?? [];
  const value = (t: number) => {
    const local = t - start + fadeOffset;
    let automation = 1;
    if (keys.length) {
      automation = keys[0].value;
      for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1],
          b = keys[i];
        if (local < b.at) {
          automation =
            a.easing === "hold"
              ? a.value
              : a.value +
                (b.value - a.value) *
                  Math.max(0, (local - a.at) / (b.at - a.at));
          break;
        }
        automation = b.value;
      }
    }
    return (
      Math.max(
        0,
        Math.min(
          1,
          track.fadeIn ? local / track.fadeIn : 1,
          track.fadeOut ? (duration - local) / track.fadeOut : 1,
        ),
      ) * automation
    );
  };
  // Fades times a linear automation ramp form a quadratic. Subdivide only
  // those intervals; ordinary ramps remain two events, even in long projects.
  const end = Math.min(from + length, start + (track.duration ?? length));
  const points = new Set([
    from,
    end,
    start - fadeOffset,
    start - fadeOffset + (track.fadeIn ?? 0),
    start - fadeOffset + duration - (track.fadeOut ?? 0),
    ...keys.map((k) => start - fadeOffset + k.at),
  ]);
  param.setValueAtTime(value(from), when);
  let previous = from;
  for (const t of [...points].sort((a, b) => a - b))
    if (t > from && t <= end) {
      const index = keys.findIndex(
          (k) => Math.abs(start - fadeOffset + k.at - t) < 1e-8,
        ),
        jump = index > 0 && keys[index - 1].easing === "hold";
      const right = jump ? Math.max(previous, t - 1 / 48000) : t;
      const curved =
        Math.abs(
          value((previous + right) / 2) - (value(previous) + value(right)) / 2,
        ) > 1e-7;
      const count = curved ? 256 : 1;
      for (let i = 1; i <= count; i++) {
        const at = previous + ((right - previous) * i) / count;
        param.linearRampToValueAtTime(value(at), when + (at - from) / rate);
      }
      if (jump) param.setValueAtTime(value(t), when + (t - from) / rate);
      previous = t;
    }
}
