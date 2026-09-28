import type { Score } from "./score.mjs";
import type { StereoPcm } from "./procedural-audio";
import type { GeneratedAudioOptions } from "./types";
import SoundfontWorker from "./soundfont.worker?worker&inline";
import {
  SCORE_SAMPLE_RATE,
  SCORE_CHUNK_SECONDS,
  type ScoreChunkRange,
  type ScoreWorkerRequest,
  type ScoreWorkerResponse,
} from "./soundfont-protocol";

export interface ScoreStreamSource {
  score: Score;
  foley(): StereoPcm;
  levels: { music: number; master: number };
}
type Chunk = { music: StereoPcm | AudioBuffer; foley: StereoPcm | AudioBuffer };

/** Stateful worker, driven by demand from the shared audio timeline, not a render-all loop. */
export class ScoreStream {
  private worker?: Worker;
  private initialization?: Promise<void>;
  private rejectReady?: (error: Error) => void;
  private failure?: Error;
  private requested = "";
  private chunks = new Map<number, Chunk>();
  private listeners = new Set<() => void>();
  private waiters = new Set<{
    from: number;
    through: number;
    resolve(): void;
    reject(error: Error): void;
  }>();
  constructor(
    private source: ScoreStreamSource,
    private loadBank: () => Promise<ArrayBuffer>,
  ) {}
  get duration() {
    return this.source.score.duration;
  }
  get error() {
    return this.failure;
  }
  initialize() {
    return (this.initialization ??= (async () => {
      if (this.failure) throw this.failure;
      const bank = (await this.loadBank()).slice(0);
      if (this.failure) throw this.failure;
      const foley = this.source.foley();
      const { id, duration, bpm, meter, notes, controls, instruments, cues } =
        this.source.score;
      return new Promise<void>((resolve, reject) => {
        this.rejectReady = reject;
        // Blob-backed workers also work in the server's opaque-origin preview sandbox.
        const worker = (this.worker = new SoundfontWorker());
        worker.onmessage = ({ data }: MessageEvent<ScoreWorkerResponse>) => {
          if (data.type === "error") return this.fail(new Error(data.message));
          if (data.type === "ready") {
            this.rejectReady = undefined;
            resolve();
            return;
          }
          this.chunks.set(data.index, { music: data.music, foley: data.foley });
          for (const waiter of this.waiters)
            if (this.hasRange(waiter)) {
              this.waiters.delete(waiter);
              waiter.resolve();
            }
          for (const listener of this.listeners) listener();
        };
        worker.onerror = (error) =>
          this.fail(new Error(error.message || "音频生成线程失败"));
        worker.onmessageerror = () => this.fail(new Error("无法读取音频片段"));
        const message: ScoreWorkerRequest = {
          type: "init",
          score: {
            id,
            duration,
            bpm,
            meter,
            notes,
            controls,
            instruments,
            cues,
          },
          bank,
          foley,
          levels: this.source.levels,
        };
        worker.postMessage(message, [
          bank,
          ...foley.map((c) => c.buffer as ArrayBuffer),
        ]);
      });
    })().catch((error) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }));
  }
  private hasRange({ from, through }: ScoreChunkRange) {
    for (let index = from; index < through; index++)
      if (!this.chunks.has(index)) return false;
    return true;
  }
  private requestRanges() {
    if (!this.worker || this.failure) return;
    const ranges: ScoreChunkRange[] = [];
    for (const { from, through } of [...this.waiters].sort(
      (a, b) => a.from - b.from,
    )) {
      const previous = ranges.at(-1);
      if (previous && from <= previous.through)
        previous.through = Math.max(previous.through, through);
      else ranges.push({ from, through });
    }
    const key = JSON.stringify(ranges);
    if (key === this.requested) return;
    this.requested = key;
    this.worker.postMessage({
      type: "render",
      ranges,
    } satisfies ScoreWorkerRequest);
  }
  async ensure(fromTime: number, until: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.initialize();
    signal?.throwIfAborted();
    if (this.failure) throw this.failure;
    const from = Math.floor(Math.max(0, fromTime) / SCORE_CHUNK_SECONDS);
    const through = Math.ceil(
      Math.min(this.duration, until) / SCORE_CHUNK_SECONDS - 1e-9,
    );
    if (this.hasRange({ from, through })) return;
    return new Promise<void>((resolve, reject) => {
      const clear = () => signal?.removeEventListener("abort", cancel);
      const waiter = {
        from,
        through,
        resolve: () => {
          clear();
          resolve();
        },
        reject: (error: Error) => {
          clear();
          reject(error);
        },
      };
      const cancel = () => {
        this.waiters.delete(waiter);
        clear();
        reject(signal!.reason);
        this.requestRanges();
      };
      this.waiters.add(waiter);
      signal?.addEventListener("abort", cancel, { once: true });
      this.requestRanges();
    });
  }
  buffer(track: "music" | "foley", index: number, context: BaseAudioContext) {
    const chunk = this.chunks.get(index);
    if (!chunk) return undefined;
    const value = chunk[track];
    if (!Array.isArray(value)) return value;
    const buffer = context.createBuffer(2, value[0].length, SCORE_SAMPLE_RATE);
    for (let channel = 0; channel < 2; channel++)
      buffer.copyToChannel(
        value[channel] as Float32Array<ArrayBuffer>,
        channel,
      );
    chunk[track] = buffer;
    return buffer;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.worker?.terminate();
    this.worker = undefined;
    this.rejectReady?.(error);
    this.rejectReady = undefined;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    for (const listener of this.listeners) listener();
  }
  dispose() {
    this.fail(new Error("音频生成已结束"));
    this.chunks.clear();
    this.listeners.clear();
  }
}

/** Native Web Audio nodes keep chunk boundaries sample-accurate, including playbackRate. */
export function createStreamVoice(
  stream: ScoreStream,
  options: GeneratedAudioOptions,
  offline: boolean,
) {
  const { context, destination, offset, duration, when, rate, trackId } =
    options;
  if (trackId !== "music" && trackId !== "foley")
    throw new Error("未知生成音轨: " + trackId);
  const end = Math.min(offset + duration, stream.duration);
  let next = Math.floor(offset / SCORE_CHUNK_SECONDS),
    demanded = -1,
    disposed = false;
  const nodes = new Set<AudioBufferSourceNode>();
  const abort = new AbortController();
  let unsubscribe = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    unsubscribe();
    for (const node of nodes) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        /* A failed start has no running source. */
      }
      node.disconnect();
      node.buffer = null;
    }
    nodes.clear();
  };
  const fail = (error: unknown) => {
    if (disposed) return;
    dispose();
    options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  };
  function pump() {
    if (disposed || end <= offset) return;
    if (stream.error) throw stream.error;
    const now = Math.max(offset, offset + (context.currentTime - when) * rate);
    const until = offline ? end : Math.min(end, now + 1.5 * rate);
    const through = Math.ceil(until / SCORE_CHUNK_SECONDS - 1e-9);
    while (next < through) {
      const buffer = stream.buffer(trackId as "music" | "foley", next, context);
      if (!buffer) {
        if (offline) throw new Error("离线音频片段尚未准备好");
        break;
      }
      const chunkStart = next * SCORE_CHUNK_SECONDS;
      const start = Math.max(offset, chunkStart),
        stop = Math.min(end, chunkStart + buffer.duration);
      const at = when + (start - offset) / rate;
      if (!offline && at < context.currentTime - 0.04)
        throw new Error(
          "音频生成未跟上播放，已暂停以保持声音与画面同步，请继续播放",
        );
      const source = context.createBufferSource();
      nodes.add(source);
      source.buffer = buffer;
      source.playbackRate.value = rate;
      source.connect(destination);
      source.onended = () => {
        source.onended = null;
        source.disconnect();
        source.buffer = null;
        nodes.delete(source);
        try {
          pump();
        } catch (error) {
          fail(error);
        }
      };
      source.start(at, start - chunkStart, stop - start);
      next++;
    }
    if (!offline && through > demanded) {
      demanded = through;
      void stream
        .ensure(next * SCORE_CHUNK_SECONDS, until, abort.signal)
        .catch(fail);
    }
  }
  if (!offline)
    unsubscribe = stream.subscribe(() => {
      try {
        pump();
      } catch (error) {
        fail(error);
      }
    });
  try {
    pump();
    return { dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
