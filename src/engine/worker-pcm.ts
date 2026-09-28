import type { GeneratedAudioModule, GeneratedAudioOptions } from "./types";
import type { StereoPcm } from "./procedural-audio";

export interface PcmRequest {
  trackId: string;
  startFrame: number;
  frames: number;
  sampleRate: number;
}
export type PcmGenerator = (
  request: PcmRequest,
  signal: AbortSignal,
) => StereoPcm | Promise<StereoPcm>;
/** Call inside a project's module Worker. Absolute sample indices determine the output. */
export function exposePcmGenerator(generate: PcmGenerator) {
  const scope = globalThis as unknown as {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage(value: unknown, transfer?: Transferable[]): void;
  };
  const requests = new Map<number, AbortController>();
  scope.onmessage = ({ data }) => {
    if (data.type === "cancel") {
      requests.get(data.id)?.abort();
      return;
    }
    if (data.type !== "render") return;
    const abort = new AbortController();
    requests.set(data.id, abort);
    void Promise.resolve()
      .then(() => generate(data.request, abort.signal))
      .then((pcm) => {
        if (abort.signal.aborted) return;
        if (
          pcm.length !== 2 ||
          pcm.some(
            (channel) =>
              channel.length !== data.request.frames ||
              channel.some((value) => !Number.isFinite(value)),
          )
        )
          throw new Error("Generator returned invalid stereo PCM");
        scope.postMessage(
          { id: data.id, pcm },
          pcm.map((channel) => channel.buffer as ArrayBuffer),
        );
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          scope.postMessage({ id: data.id, error: String(error) });
      })
      .finally(() => requests.delete(data.id));
  };
}
const sampleRate = 48000,
  chunkFrames = 12000,
  seconds = chunkFrames / sampleRate;
class PcmClient {
  private sequence = 0;
  private disposed = false;
  private pending = new Map<
    number,
    { resolve(value: StereoPcm): void; reject(error: Error): void }
  >();
  private cache = new Map<string, AudioBuffer>();
  private inFlight = new Map<string, Promise<AudioBuffer>>();
  private bytes = 0;
  constructor(
    private worker: Worker,
    private budget: number,
  ) {
    worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.pcm);
    };
    worker.onerror = (event) =>
      this.dispose(new Error(event.message || "PCM Worker failed"));
    worker.onmessageerror = () =>
      this.dispose(new Error("PCM Worker response could not be decoded"));
  }
  async chunk(trackId: string, index: number, context: BaseAudioContext) {
    if (this.disposed) throw new Error("PCM session was disposed");
    const key = trackId + ":" + index;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    if (this.inFlight.has(key)) return this.inFlight.get(key)!;
    const id = ++this.sequence;
    const timeout = setTimeout(
      () => this.dispose(new Error("PCM Worker timed out")),
      30000,
    );
    const pending = new Promise<StereoPcm>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        type: "render",
        id,
        request: {
          trackId,
          startFrame: index * chunkFrames,
          frames: chunkFrames,
          sampleRate,
        } satisfies PcmRequest,
      });
    })
      .then((pcm) => {
        if (this.disposed) throw new Error("PCM session was disposed");
        if (
          pcm.length !== 2 ||
          pcm.some(
            (channel) =>
              channel.length !== chunkFrames ||
              channel.some((value) => !Number.isFinite(value)),
          )
        )
          throw new Error("Invalid Worker PCM");
        const buffer = context.createBuffer(2, chunkFrames, sampleRate);
        pcm.forEach((channel, index) =>
          buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, index),
        );
        this.cache.set(key, buffer);
        this.bytes += chunkFrames * 8;
        while (this.bytes > this.budget) {
          this.cache.delete(this.cache.keys().next().value!);
          this.bytes -= chunkFrames * 8;
        }
        return buffer;
      })
      .finally(() => {
        clearTimeout(timeout);
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, pending);
    return pending;
  }
  get(trackId: string, index: number) {
    return this.cache.get(trackId + ":" + index);
  }
  async ensure(
    trackId: string,
    context: BaseAudioContext,
    offset: number,
    duration: number,
    signal?: AbortSignal,
  ) {
    for (
      let index = Math.floor(offset / seconds);
      index < Math.ceil((offset + duration) / seconds - 1e-8);
      index++
    ) {
      signal?.throwIfAborted();
      const pending = this.chunk(trackId, index, context);
      if (!signal) await pending;
      else
        await new Promise<void>((resolve, reject) => {
          const cancel = () => reject(signal.reason);
          signal.addEventListener("abort", cancel, { once: true });
          pending
            .then(() => resolve(), reject)
            .finally(() => signal.removeEventListener("abort", cancel));
        });
      signal?.throwIfAborted();
    }
  }
  dispose(error = new Error("PCM session disposed")) {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.cache.clear();
    this.bytes = 0;
  }
}
export function createWorkerPcmAudio(options: {
  createWorker(): Worker;
  maxCacheBytes?: number;
}): GeneratedAudioModule {
  const budget = options.maxCacheBytes ?? 128 * 1024 * 1024;
  if (
    !Number.isFinite(budget) ||
    budget < 48000 * 8 * 11 ||
    budget > 512 * 1024 * 1024
  )
    throw new Error("PCM cache must be 4.1..512 MiB");
  const live = new WeakMap<BaseAudioContext, PcmClient>();
  const offlineUsers = new Set<BaseAudioContext>();
  let offline: PcmClient | undefined;
  const isOffline = (context: BaseAudioContext) => "startRendering" in context;
  function client(context: BaseAudioContext) {
    if (isOffline(context))
      return (offline ??= new PcmClient(options.createWorker(), budget));
    let value = live.get(context);
    if (!value) {
      value = new PcmClient(options.createWorker(), budget);
      live.set(context, value);
    }
    return value;
  }
  return {
    prepareAudio(context) {
      client(context);
      if (isOffline(context)) offlineUsers.add(context);
    },
    async prepareSegment({ trackId, context, offset, duration, rate, signal }) {
      await client(context).ensure(
        trackId,
        context,
        offset,
        Math.min(duration, isOffline(context) ? duration : 1.5 * rate),
        signal,
      );
    },
    createAudio(options: GeneratedAudioOptions) {
      const { context, trackId, offset, duration, rate, when, destination } =
        options;
      const stream = client(context),
        end = offset + duration;
      const nodes = new Set<AudioBufferSourceNode>(),
        abort = new AbortController();
      let next = Math.floor(offset / seconds),
        pumping = false;
      const dispose = () => {
        if (abort.signal.aborted) return;
        abort.abort();
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
        const start = Math.max(offset, index * seconds),
          stop = Math.min(end, (index + 1) * seconds),
          at = when + (start - offset) / rate;
        if (!isOffline(context) && at < context.currentTime - 0.04)
          throw new Error("PCM Worker could not keep up; playback paused");
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
        node.start(at, start - index * seconds, stop - start);
      };
      const pump = async () => {
        if (pumping || abort.signal.aborted) return;
        pumping = true;
        try {
          const until = Math.min(
            end,
            offset +
              Math.max(0, context.currentTime - when) * rate +
              1.5 * rate,
          );
          while (next * seconds < until - 1e-8) {
            const index = next++;
            schedule(index, await stream.chunk(trackId, index, context));
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            dispose();
            options.onError?.(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        } finally {
          pumping = false;
        }
      };
      try {
        const until = isOffline(context)
          ? end
          : Math.min(end, offset + 1.5 * rate);
        while (next * seconds < until - 1e-8) {
          const index = next++;
          const buffer = stream.get(trackId, index);
          if (!buffer)
            throw new Error(
              "PCM segment is not prepared or exceeds cache budget",
            );
          schedule(index, buffer);
        }
        return { dispose };
      } catch (error) {
        dispose();
        throw error;
      }
    },
    disposeAudio(context) {
      if (isOffline(context)) {
        offlineUsers.delete(context);
        if (!offlineUsers.size) {
          offline?.dispose();
          offline = undefined;
        }
      } else {
        live.get(context)?.dispose();
        live.delete(context);
      }
    },
  };
}
