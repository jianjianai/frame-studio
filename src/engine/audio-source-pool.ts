import { Input, UrlSource, ALL_FORMATS, AudioBufferSink } from "mediabunny";
import { assetUrl } from "./types";
import { PreviewBuffering, LIVE_BUFFER_SECONDS, LIVE_LOOKAHEAD_SECONDS } from "./media-buffering";

const RATE = 48000,
  FRAMES = 24000;
type Entry = {
  dispose(): void;
  input: Input;
  sink: AudioBufferSink;
  origin: number;
  duration: number;
};
export class AudioSourcePool {
  private inputs = new Map<string, Promise<Entry>>();
  private cache = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer>>();
  private tail: Promise<unknown> = Promise.resolve();
  private bytes = 0;
  private closed = false;
  private abort = new AbortController();
  readonly metrics = {
    decodedChunks: 0,
    cacheHits: 0,
    openedSources: 0,
    peakBytes: 0,
  };
  constructor(private budget = 128 * 1024 * 1024) {}
  private async open(src: string): Promise<Entry> {
    let current = this.inputs.get(src);
    if (!current) {
      current = (async () => {
        const input = new Input({
          source: new UrlSource(assetUrl(src), {
            maxCacheSize: 2 * 1024 * 1024,
            getRetryDelay: () => null,
          }),
          formats: ALL_FORMATS,
        });
        const abort = () => input.dispose();
        this.abort.signal.addEventListener("abort", abort, { once: true });
        try {
          const audio = await input.getPrimaryAudioTrack();
          if (!audio || !(await audio.canDecode()))
            throw Error(
              "音频无法解码，请使用 film audio-media 转为兼容 WAV/FLAC：" + src,
            );
          const video = await input.getPrimaryVideoTrack();
          const origin = await (video ?? audio).getFirstTimestamp();
          const duration = (await audio.computeDuration()) - origin;
          if (this.closed) throw Error("Audio source pool disposed");
          this.metrics.openedSources++;
          return {
            input,
            dispose: () => {
              this.abort.signal.removeEventListener("abort", abort);
              input.dispose();
            },
            sink: new AudioBufferSink(audio),
            origin,
            duration,
          };
        } catch (e) {
          input.dispose();
          this.abort.signal.removeEventListener("abort", abort);
          throw Error(
            "音频无法解码，请在音频面板转换兼容副本，或使用 film audio-media 转为 WAV/FLAC：" +
              src +
              " (" +
              String(e) +
              ")",
          );
        }
      })();
      this.inputs.set(src, current);
      current.catch(() => {
        if (this.inputs.get(src) === current) this.inputs.delete(src);
      });
    }
    return current;
  }
  async chunk(
    src: string,
    index: number,
    signal?: AbortSignal,
  ): Promise<AudioBuffer> {
    signal?.throwIfAborted();
    if (this.closed) throw Error("Audio source pool disposed");
    const key = src + ":" + index;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.metrics.cacheHits++;
      return cached;
    }
    let task = this.pending.get(key);
    if (!task) {
      // Bounded decode concurrency; requests for the same asset window share work.
      task = this.tail
        .catch(() => {})
        .then(async () => {
          if (this.closed) throw Error("Audio source pool disposed");
          const entry = await this.open(src);
          const start = (index * FRAMES) / RATE,
            end = start + FRAMES / RATE;
          const result = new AudioBuffer({
            numberOfChannels: 2,
            length: FRAMES,
            sampleRate: RATE,
          });
          if (start < entry.duration) {
            const iterator = entry.sink.buffers(
              start + entry.origin,
              Math.min(end, entry.duration) + entry.origin,
            );
            try {
              for await (const item of iterator) {
                if (this.closed) throw Error("Audio source pool disposed");
                const at = item.timestamp - entry.origin,
                  buffer = item.buffer;
                const first = Math.max(
                    0,
                    Math.ceil((at - start) * RATE - 1e-6),
                  ),
                  last = Math.min(
                    FRAMES,
                    Math.ceil((at + buffer.duration - start) * RATE - 1e-6),
                  );
                if (buffer.numberOfChannels > 6)
                  throw Error(
                    "超过 5.1 声道的素材请先转换为双声道副本：" + src,
                  );
                const channels = Array.from(
                  { length: buffer.numberOfChannels },
                  (_, i) => buffer.getChannelData(i),
                );
                for (let ch = 0; ch < 2; ch++) {
                  let input = channels[Math.min(ch, channels.length - 1)];
                  if (channels.length > 2) {
                    input = new Float32Array(buffer.length);
                    for (let i = 0; i < input.length; i++) {
                      if (channels.length === 4)
                        input[i] =
                          0.5 * (channels[ch][i] + channels[ch + 2][i]);
                      else
                        input[i] =
                          channels[ch][i] +
                          Math.SQRT1_2 *
                            (channels[2][i] +
                              (channels.length >= 5
                                ? channels[
                                    ch + (channels.length === 6 ? 4 : 3)
                                  ][i]
                                : 0));
                    }
                  }
                  const output = result.getChannelData(ch);
                  for (let i = first; i < last; i++) {
                    const p = (start + i / RATE - at) * buffer.sampleRate,
                      a = Math.max(
                        0,
                        Math.min(input.length - 1, Math.floor(p)),
                      ),
                      f = Math.max(0, p - a);
                    output[i] =
                      input[a] +
                      (input[Math.min(a + 1, input.length - 1)] - input[a]) *
                        Math.min(1, f);
                  }
                }
              }
            } finally {
              await iterator.return();
            }
          }
          if (this.closed) throw Error("Audio source pool disposed");
          this.cache.set(key, result);
          this.bytes += FRAMES * 8;
          this.metrics.decodedChunks++;
          while (this.bytes > this.budget && this.cache.size) {
            this.cache.delete(this.cache.keys().next().value!);
            this.bytes -= FRAMES * 8;
          }
          this.metrics.peakBytes = Math.max(this.metrics.peakBytes, this.bytes);
          // Input caches are separate from decoded PCM and limited to eight sources.
          while (this.inputs.size > 8) {
            const [old, promise] = this.inputs.entries().next().value!;
            this.inputs.delete(old);
            void promise.then(
              (v) => v.dispose(),
              () => {},
            );
          }
          return result;
        });
      this.tail = task;
      this.pending.set(key, task);
      void task.finally(() => this.pending.delete(key)).catch(() => {});
    }
    if (!signal) return task;
    return new Promise<AudioBuffer>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      task!
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async prepare(
    src: string,
    offset: number,
    duration: number,
    signal?: AbortSignal,
  ) {
    for (
      let i = Math.floor((offset * RATE) / FRAMES);
      i < Math.ceil(((offset + duration) * RATE) / FRAMES - 1e-8);
      i++
    ) {
      signal?.throwIfAborted();
      await this.chunk(src, i, signal);
    }
  }
  play(
    src: string,
    options: {
      context: BaseAudioContext;
      destination: AudioNode;
      when: number;
      offset: number;
      duration: number;
      rate: number;
      onError?: (e: Error) => void;
    },
  ) {
    const { context, destination, when, offset, duration, rate } = options,
      offline = "startRendering" in context,
      end = offset + duration;
    let next = Math.floor((offset * RATE) / FRAMES),
      pumping = false;
    const nodes = new Set<AudioBufferSourceNode>(),
      abort = new AbortController();
    const dispose = () => {
      if (abort.signal.aborted) return;
      abort.abort();
      clearInterval(timer);
      for (const node of nodes) {
        node.onended = null;
        try {
          node.stop();
        } catch {}
        node.disconnect();
        node.buffer = null;
      }
      nodes.clear();
    };
    const schedule = (index: number, buffer: AudioBuffer) => {
      if (abort.signal.aborted) return;
      const first = Math.max(offset, (index * FRAMES) / RATE),
        last = Math.min(end, ((index + 1) * FRAMES) / RATE),
        at = when + (first - offset) / rate;
      if (!offline && at < context.currentTime - 0.04)
        throw new PreviewBuffering("正在缓冲音频");
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = rate;
      node.connect(destination);
      nodes.add(node);
      node.onended = () => {
        nodes.delete(node);
        node.disconnect();
        node.buffer = null;
        void pump();
      };
      node.start(at, first - (index * FRAMES) / RATE, last - first);
    };
    const pump = async () => {
      if (pumping || abort.signal.aborted) return;
      pumping = true;
      try {
        const until = Math.min(
          end,
          offset + Math.max(0, context.currentTime - when) * rate + LIVE_LOOKAHEAD_SECONDS * rate,
        );
        while ((next * FRAMES) / RATE < until - 1e-8) {
          const index = next++;
          schedule(index, await this.chunk(src, index, abort.signal));
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          dispose();
          options.onError?.(e instanceof Error ? e : Error(String(e)));
        }
      } finally {
        pumping = false;
      }
    };
    const timer = offline ? undefined : setInterval(() => void pump(), 100);
    try {
      if (offline) {
        const ready = (async () => {
          while ((next * FRAMES) / RATE < end - 1e-8) {
            const index = next++;
            schedule(index, await this.chunk(src, index, abort.signal));
          }
        })();
        return { dispose, ready };
      }
      const until = Math.min(end, offset + LIVE_BUFFER_SECONDS * rate);
      while ((next * FRAMES) / RATE < until - 1e-8) {
        const index = next++,
          buffer = this.cache.get(src + ":" + index);
        if (!buffer)
          throw Error("Audio range must be prepared before scheduling");
        schedule(index, buffer);
      }
      if (!offline) void pump();
      return { dispose };
    } catch (e) {
      dispose();
      throw e;
    }
  }
  diagnostics() {
    return {
      ...this.metrics,
      budgetBytes: this.budget,
      cacheBytes: this.bytes,
      pending: this.pending.size,
      inputs: this.inputs.size,
    };
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const p of this.inputs.values())
      void p.then(
        (v) => v.dispose(),
        () => {},
      );
    this.inputs.clear();
    this.cache.clear();
    this.bytes = 0;
  }
}
