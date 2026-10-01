import { Input, UrlSource, ALL_FORMATS, AudioBufferSink } from "mediabunny";
import { assetUrl } from "./types";
import {
  PreviewBuffering,
  LIVE_BUFFER_SECONDS,
  MediaRequestQueue,
  AdaptiveAudioBuffer,
} from "./media-buffering";

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
  private pending = new Map<
    string,
    { promise: Promise<AudioBuffer>; abort: AbortController; users: number }
  >();
  private tails = new Map<string, Promise<unknown>>();
  private decodeQueue = new MediaRequestQueue(4);
  private downloadQueue = new MediaRequestQueue(4);
  private urls = new Map<string, string>();
  private decoding = new Map<string, number>();
  readonly buffering = new AdaptiveAudioBuffer();
  private activeSources = 1;
  bind(
    src: string,
    source?: {
      revision: string;
      url?: string;
      renditions?: Record<string, string>;
    },
  ) {
    if (!source) return src;
    const connection =
      typeof navigator !== "undefined"
        ? (
            navigator as Navigator & {
              connection?: {
                saveData?: boolean;
                downlink?: number;
                effectiveType?: string;
              };
            }
          ).connection
        : undefined;
    const measured = this.buffering.diagnostics().throughputBytesPerSecond;
    const constrained =
      connection?.saveData ||
      ["slow-2g", "2g"].includes(connection?.effectiveType ?? "") ||
      (connection?.downlink !== undefined &&
        connection.downlink * 125000 < this.activeSources * 16000) ||
      (measured > 0 && measured < this.activeSources * 16000);
    const economy = constrained && source.renditions?.economy;
    const profile = economy ? "economy" : "preview";
    const key = src + "@revision:" + source.revision + "@rendition:" + profile;
    let url = economy || source.url || assetUrl(src);
    if (!source.url && !url.includes("v="))
      url +=
        (url.includes("?") ? "&" : "?") +
        "v=" +
        encodeURIComponent(source.revision);
    this.urls.set(key, url);
    return key;
  }
  setActiveSources(count: number) {
    this.activeSources = Math.max(1, count);
  }
  bufferSeconds(rate = 1, initial = false) {
    return this.buffering.seconds(
      rate,
      this.activeSources,
      this.budget,
      initial,
    );
  }
  private async fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const signal = init?.signal ?? this.abort.signal;
    const began = performance.now();
    const release = await this.downloadQueue.acquire(signal);
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      release();
      if (signal.aborted) throw error;
      throw new PreviewBuffering("网络连接暂时中断，正在重新连接");
    }
    if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
      release();
      void response.body?.cancel().catch(() => {});
      throw new PreviewBuffering("媒体服务暂时不可用，正在重试");
    }
    const latency = (performance.now() - began) / 1000;
    if (!response.body) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    let size = 0,
      ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      release();
      this.buffering.observeNetwork(
        size,
        (performance.now() - began) / 1000,
        latency,
      );
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => {});
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const result = await reader.read();
          if (result.done) {
            finish();
            controller.close();
          } else {
            size += result.value.byteLength;
            controller.enqueue(result.value);
          }
        } catch (error) {
          finish();
          controller.error(
            signal.aborted
              ? error
              : new PreviewBuffering("媒体下载暂时中断，正在重新连接"),
          );
        }
      },
      cancel: async (reason) => {
        finish();
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
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
          source: new UrlSource(this.urls.get(src) ?? assetUrl(src), {
            maxCacheSize: 2 * 1024 * 1024,
            parallelism: 1,
            fetchFn: (input, init) => this.fetch(input, init),
            getRetryDelay: (attempts) =>
              attempts < 3 ? Math.min(2, 0.25 * 2 ** attempts) : null,
            handleUnhandledError: () => {},
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
          if (e instanceof PreviewBuffering) throw e;
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
    priority = index,
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
    if (task?.abort.signal.aborted) {
      if (this.pending.get(key) === task) this.pending.delete(key);
      task = undefined;
    }
    if (!task) {
      const controller = new AbortController();
      const previous = this.tails.get(src) ?? Promise.resolve();
      const job = {
        promise: undefined! as Promise<AudioBuffer>,
        abort: controller,
        users: 0,
      };
      job.promise = previous
        .catch(() => {})
        .then(() =>
          this.decodeQueue.run(
            controller.signal,
            async () => {
              controller.signal.throwIfAborted();
              this.decoding.set(src, (this.decoding.get(src) ?? 0) + 1);
              try {
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
                      controller.signal.throwIfAborted();
                      if (this.closed)
                        throw Error("Audio source pool disposed");
                      const at = item.timestamp - entry.origin,
                        buffer = item.buffer;
                      const first = Math.max(
                          0,
                          Math.ceil((at - start) * RATE - 1e-6),
                        ),
                        last = Math.min(
                          FRAMES,
                          Math.ceil(
                            (at + buffer.duration - start) * RATE - 1e-6,
                          ),
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
                            (input[Math.min(a + 1, input.length - 1)] -
                              input[a]) *
                              Math.min(1, f);
                        }
                      }
                    }
                  } finally {
                    await iterator.return();
                  }
                }
                controller.signal.throwIfAborted();
                if (this.closed) throw Error("Audio source pool disposed");
                this.cache.set(key, result);
                this.bytes += FRAMES * 8;
                this.metrics.decodedChunks++;
                while (this.bytes > this.budget && this.cache.size) {
                  this.cache.delete(this.cache.keys().next().value!);
                  this.bytes -= FRAMES * 8;
                }
                this.metrics.peakBytes = Math.max(
                  this.metrics.peakBytes,
                  this.bytes,
                );
                // Input caches are separate from decoded PCM and limited to eight sources.
                while (this.inputs.size > 8) {
                  const victim = [...this.inputs.entries()].find(
                    ([key]) => !this.decoding.has(key),
                  );
                  if (!victim) break;
                  const [old, promise] = victim;
                  this.inputs.delete(old);
                  void promise.then(
                    (v) => v.dispose(),
                    () => {},
                  );
                }
                return result;
              } finally {
                const remaining = (this.decoding.get(src) ?? 1) - 1;
                if (remaining) this.decoding.set(src, remaining);
                else this.decoding.delete(src);
              }
            },
            priority,
          ),
        );
      this.tails.set(src, job.promise);
      this.pending.set(key, job);
      void job.promise
        .finally(() => {
          if (this.pending.get(key) === job) this.pending.delete(key);
          if (this.tails.get(src) === job.promise) this.tails.delete(src);
        })
        .catch(() => {});
      task = job;
    }
    task.users++;
    const shared = task;
    return new Promise<AudioBuffer>((resolve, reject) => {
      let done = false;
      const finish = (value?: AudioBuffer, error?: unknown) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        shared.users--;
        if (shared.users === 0 && error && !shared.abort.signal.aborted) {
          shared.abort.abort(error);
          // Input.dispose is the only supported cancellation of an active range request.
          // Never cancel an input while a different clip/seek still consumes its source.
          const stillNeeded = [...this.pending.entries()].some(
            ([k, t]) => k.startsWith(src + ":") && t !== shared && t.users > 0,
          );
          if (!stillNeeded) {
            const input = this.inputs.get(src);
            this.inputs.delete(src);
            void input?.then(
              (entry) => entry.dispose(),
              () => {},
            );
          }
        }
        if (error !== undefined) reject(error);
        else resolve(value!);
      };
      const abort = () =>
        finish(
          undefined,
          signal?.reason ?? new DOMException("Cancelled", "AbortError"),
        );
      signal?.addEventListener("abort", abort, { once: true });
      shared.promise.then(
        (value) => finish(value),
        (error) => finish(undefined, error),
      );
      if (signal?.aborted) abort();
    });
  }
  async prepare(
    src: string,
    offset: number,
    duration: number,
    signal?: AbortSignal,
  ) {
    const jobs: Promise<AudioBuffer>[] = [];
    for (
      let i = Math.floor((offset * RATE) / FRAMES);
      i < Math.ceil(((offset + duration) * RATE) / FRAMES - 1e-8);
      i++
    ) {
      signal?.throwIfAborted();
      jobs.push(
        this.chunk(src, i, signal, i - Math.floor((offset * RATE) / FRAMES)),
      );
    }
    await Promise.all(jobs);
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
          offset +
            Math.max(0, context.currentTime - when) * rate +
            this.bufferSeconds(rate) * rate,
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
      const until = Math.min(
        end,
        offset +
          Math.min(LIVE_BUFFER_SECONDS, this.bufferSeconds(rate, true)) * rate,
      );
      while ((next * FRAMES) / RATE < until - 1e-8) {
        const index = next++,
          buffer = this.cache.get(src + ":" + index);
        if (!buffer)
          throw Error("Audio range must be prepared before scheduling");
        schedule(index, buffer);
      }
      // Prefetching starts after the transport resumes its suspended scheduling context.
      if (context.state === "running") void pump();
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
      downloads: this.downloadQueue.diagnostics(),
      decodeQueue: this.decodeQueue.diagnostics(),
      buffer: this.buffering.diagnostics(),
      sourceByteCacheBudget: 8 * 2 * 1024 * 1024,
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
    for (const task of this.pending.values()) task.abort.abort();
    this.pending.clear();
    this.tails.clear();
    this.urls.clear();
    this.inputs.clear();
    this.cache.clear();
    this.bytes = 0;
  }
}
