/** Shared media starvation signal: the transport freezes all tracks and retries. */
export class PreviewBuffering extends Error {}
export const LIVE_BUFFER_SECONDS = 4;
export const LIVE_LOOKAHEAD_SECONDS = 8;

/** Keep concurrent downloads bounded; a cancelled queued seek never starts a request. */
export class MediaRequestQueue {
  private active = 0;
  private waiting: { start(): void; priority: number }[] = [];
  private scheduled = false;
  private drain() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.waiting.sort((a, b) => a.priority - b.priority);
      while (this.active < this.limit && this.waiting.length)
        this.waiting.shift()!.start();
    });
  }
  constructor(private limit = 6) {
    if (!Number.isInteger(limit) || limit < 1)
      throw Error("Invalid media concurrency");
  }
  async acquire(signal: AbortSignal, priority = 0): Promise<() => void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", cancel);
        this.active++;
        resolve();
      };
      const cancel = () => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(signal.reason);
      };
      const entry = { start, priority };
      this.waiting.push(entry);
      signal.addEventListener("abort", cancel, { once: true });
      this.drain();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }
  diagnostics() {
    return {
      active: this.active,
      queued: this.waiting.length,
      limit: this.limit,
    };
  }
  async run<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
    priority = 0,
  ): Promise<T> {
    const release = await this.acquire(signal, priority);
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      release();
    }
  }
}

/** Startup and lookahead track measured network readiness, with PCM budget backpressure. */
export class AdaptiveAudioBuffer {
  private latency = 0;
  private throughput = 0;
  private readiness = 0;
  observeNetwork(bytes: number, seconds: number, latency = 0) {
    if (seconds > 0 && bytes > 0) {
      const sample = bytes / seconds;
      this.throughput = this.throughput
        ? this.throughput * 0.75 + sample * 0.25
        : sample;
    }
    if (latency > 0) this.latency = Math.max(latency, this.latency * 0.85);
  }
  observePreparation(seconds: number) {
    if (seconds > 0) this.readiness = Math.max(seconds, this.readiness * 0.85);
  }
  seconds(
    rate = 1,
    activeSources = 1,
    budget = 128 * 1024 * 1024,
    initial = false,
  ) {
    // Each decoded second uses 384000 bytes, with half the budget reserved for
    // concurrent voices, current playback and recently visited seek positions.
    const memory =
      budget / (384000 * Math.max(1, activeSources) * Math.max(1, rate) * 2);
    const desired = initial
      ? Math.max(LIVE_BUFFER_SECONDS, this.latency * 2 + this.readiness)
      : Math.max(LIVE_LOOKAHEAD_SECONDS, this.latency * 3 + this.readiness * 2);
    return Math.max(0.5, Math.min(initial ? 12 : 24, desired, memory));
  }
  diagnostics() {
    return {
      latencySeconds: this.latency,
      throughputBytesPerSecond: this.throughput,
      readinessSeconds: this.readiness,
    };
  }
}
