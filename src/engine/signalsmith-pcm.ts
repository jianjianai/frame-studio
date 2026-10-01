import { MediaRequestQueue } from "./media-buffering";
import {
  createSignalsmithNode,
  type StretchConfiguration,
  type StretchSchedule,
} from "./signalsmith-audio";
/** Upper bound for official input/output latency, including split computation. */
export function signalsmithPadding(
  configuration?: StretchConfiguration,
  sampleRate = 48000,
): number {
  if (!configuration?.blockMs) return 0.5;
  const block = Math.round((configuration.blockMs * sampleRate) / 1000);
  const interval = Math.round(
    ((configuration.intervalMs || configuration.blockMs * 0.25) * sampleRate) /
      1000,
  );
  return Math.max(
    0.5,
    (block + (configuration.splitComputation ? interval : 0)) / sampleRate,
  );
}
/** A canonical DSP window: offset/duration use input seconds; resulting PCM uses output seconds. */
export async function renderSignalsmithPcm(options: {
  channels: readonly Float32Array[];
  sampleRate: number;
  offset: number;
  duration: number;
  rate: number;
  pitch: number;
  configuration?: StretchConfiguration;
  schedule?: StretchSchedule;
  signal?: AbortSignal;
}): Promise<AudioBuffer> {
  options.signal?.throwIfAborted();
  const padding = signalsmithPadding(options.configuration, options.sampleRate),
    frames = Math.max(
      1,
      Math.round((options.duration / options.rate) * options.sampleRate),
    );
  const warmup = Math.round(padding * options.sampleRate),
    context = new OfflineAudioContext(2, warmup + frames, options.sampleRate);
  const node = await createSignalsmithNode(context, undefined, options.signal);
  try {
    if (options.configuration) await node.configure(options.configuration);
    const channels = options.channels.map((c) => c.slice());
    await node.addBuffers(
      channels,
      channels.map((c) => c.buffer as ArrayBuffer),
    );
    options.signal?.throwIfAborted();
    node.connect(context.destination);
    await node.schedule({
      ...options.schedule,
      active: true,
      output: 0,
      input: options.offset - padding * options.rate,
      rate: options.rate,
      semitones: options.pitch,
    });
    const all = await context.startRendering();
    options.signal?.throwIfAborted();
    const output = new AudioBuffer({
      numberOfChannels: 2,
      length: frames,
      sampleRate: options.sampleRate,
    });
    for (let c = 0; c < 2; c++)
      output.copyToChannel(
        all.getChannelData(c).subarray(warmup, warmup + frames),
        c,
      );
    return output;
  } finally {
    node.dispose();
  }
}
/** Bounded promise-deduplicated LRU for processed PCM, shared by seeks and export cuts. */
export class SignalsmithPcmCache {
  private entries = new Map<
    string,
    { promise: Promise<AudioBuffer>; bytes: number; settled: boolean }
  >();
  private queue = new MediaRequestQueue(2);
  private abort = new AbortController();
  private bytes = 0;
  constructor(readonly budgetBytes = 32 * 1024 * 1024) {}
  get(
    key: string,
    bytes: number,
    load: () => Promise<AudioBuffer>,
  ): Promise<AudioBuffer> {
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.entries.set(key, old);
      return old.promise;
    }
    if (bytes > this.budgetBytes)
      throw Error("Signalsmith PCM window exceeds cache budget");
    while (this.bytes + bytes > this.budgetBytes && this.entries.size) {
      const candidate = [...this.entries].find(([, entry]) => entry.settled);
      if (!candidate)
        throw Error(
          "Concurrent Signalsmith PCM preparation exceeds cache budget",
        );
      const [id, entry] = candidate;
      this.entries.delete(id);
      this.bytes -= entry.bytes;
    }
    const promise = this.queue.run(this.abort.signal, load);
    const entry = { promise, bytes, settled: false };
    this.entries.set(key, entry);
    this.bytes += bytes;
    void promise
      .finally(() => {
        entry.settled = true;
      })
      .catch(() => {});
    void promise.catch(() => {
      if (this.entries.get(key)?.promise === promise) {
        this.entries.delete(key);
        this.bytes -= bytes;
      }
    });
    return promise;
  }
  diagnostics() {
    return {
      cacheBytes: this.bytes,
      budgetBytes: this.budgetBytes,
      entries: this.entries.size,
      rendering: this.queue.diagnostics(),
    };
  }
  clear() {
    this.abort.abort();
    this.abort = new AbortController();
    this.entries.clear();
    this.bytes = 0;
  }
}

/** Complementary fixed-grid overlap windows; a seek/cut uses exactly the same PCM and weights. */
export async function scheduleCanonicalPcm(options: {
  context: BaseAudioContext;
  destination: AudioNode;
  when: number;
  offset: number;
  duration: number;
  rate: number;
  loopStart?: number;
  loopEnd?: number;
  signal?: AbortSignal;
  get(index: number): Promise<AudioBuffer>;
}): Promise<{ dispose(): void }> {
  const sources = new Set<AudioBufferSourceNode>(),
    gains = new Set<GainNode>();
  const dispose = () => {
    for (const source of sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {}
      source.disconnect();
      source.buffer = null;
    }
    for (const gain of gains) gain.disconnect();
    sources.clear();
    gains.clear();
  };
  const looping =
    options.loopEnd !== undefined &&
    options.loopStart !== undefined &&
    options.loopEnd > options.loopStart;
  let elapsed = 0,
    local = options.offset;
  try {
    while (elapsed < options.duration - 1e-8) {
      const stop = looping
        ? Math.min(options.loopEnd!, local + options.duration - elapsed)
        : local + options.duration - elapsed;
      if (stop <= local) throw Error("Invalid canonical PCM loop extent");
      const a = local / options.rate,
        b = stop / options.rate;
      for (
        let index = Math.max(0, Math.floor((a - 0.01) / 2));
        index * 2 - 0.01 < b - 1e-8;
        index++
      ) {
        const buffer = await options.get(index);
        options.signal?.throwIfAborted();
        const origin = index * 2,
          begin = Math.max(a, origin - 0.01),
          finish = Math.min(b, origin + 2.01);
        if (finish <= begin) continue;
        const source = options.context.createBufferSource(),
          blend = options.context.createGain();
        source.buffer = buffer;
        source.connect(blend);
        blend.connect(options.destination);
        sources.add(source);
        gains.add(blend);
        const at = options.when + elapsed / options.rate + begin - a;
        const weight = (time: number) =>
          time < origin + 0.01
            ? Math.sin(
                (Math.max(0, Math.min(1, (time - origin + 0.01) / 0.02)) *
                  Math.PI) /
                  2,
              ) ** 2
            : time > origin + 1.99
              ? Math.cos(
                  (Math.max(0, Math.min(1, (time - origin - 1.99) / 0.02)) *
                    Math.PI) /
                    2,
                ) ** 2
              : 1;
        // A source start can land one sample before an AudioParam event after floating-point quantization.
        // Initialize the pre-event value too, preventing a one-sample unity-gain impulse at an overlap edge.
        blend.gain.value = weight(begin);
        blend.gain.setValueAtTime(weight(begin), at);
        for (const edge of [origin, origin + 2])
          for (let point = 0; point <= 128; point++) {
            const time = edge - 0.01 + (point * 0.02) / 128;
            if (time > begin && time < finish)
              blend.gain.linearRampToValueAtTime(
                weight(time),
                at + time - begin,
              );
          }
        blend.gain.linearRampToValueAtTime(weight(finish), at + finish - begin);
        source.onended = () => {
          sources.delete(source);
          gains.delete(blend);
          source.disconnect();
          blend.disconnect();
          source.buffer = null;
        };
        source.start(
          Math.max(0, at),
          Math.max(0, begin - origin + 0.01),
          finish - begin,
        );
      }
      elapsed += stop - local;
      local = looping ? options.loopStart! : stop;
    }
    return { dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}
