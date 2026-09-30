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
  constructor(private limit = 6) {}
  async run<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
    priority = 0,
  ): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", cancel);
        this.active++;
        resolve();
      };
      const cancel = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      const entry = { start, priority };
      this.waiting.push(entry);
      signal.addEventListener("abort", cancel, { once: true });
      this.drain();
    });
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      this.active--;
      this.drain();
    }
  }
}
