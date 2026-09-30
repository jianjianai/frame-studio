import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioSourcePool } from "../../src/engine/audio-source-pool";
const state = vi.hoisted(() => ({
  opened: [] as string[],
  decoded: 0,
  disposed: 0,
}));
vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  UrlSource: class {
    constructor(public url: string) {}
  },
  Input: class {
    source: any;
    constructor(options: any) {
      this.source = options.source;
      state.opened.push(this.source.url);
    }
    async getPrimaryVideoTrack() {
      return null;
    }
    async getPrimaryAudioTrack() {
      return {
        src: this.source.url,
        canDecode: async () => true,
        getFirstTimestamp: async () => 0,
        computeDuration: async () => 60,
      };
    }
    dispose() {
      state.disposed++;
    }
  },
  AudioBufferSink: class {
    constructor(private track: any) {}
    async *buffers(start: number, end: number) {
      state.decoded++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const data = new Float32Array(Math.ceil((end - start) * 48000)).fill(
        this.track.src.includes("new") ? 0.8 : 0.2,
      );
      yield {
        timestamp: start,
        buffer: {
          duration: end - start,
          length: data.length,
          sampleRate: 48000,
          numberOfChannels: 1,
          getChannelData: () => data,
        },
      };
    }
  },
}));
class Buffer {
  duration: number;
  data: Float32Array[];
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  constructor(options: {
    numberOfChannels: number;
    length: number;
    sampleRate: number;
  }) {
    Object.assign(this, options);
    this.numberOfChannels = options.numberOfChannels;
    this.length = options.length;
    this.sampleRate = options.sampleRate;
    this.duration = this.length / this.sampleRate;
    this.data = Array.from(
      { length: this.numberOfChannels },
      () => new Float32Array(this.length),
    );
  }
  getChannelData(i: number) {
    return this.data[i];
  }
}
const pools: AudioSourcePool[] = [];
afterEach(() => {
  pools.splice(0).forEach((p) => p.dispose());
  vi.unstubAllGlobals();
  state.opened = [];
  state.decoded = 0;
  state.disposed = 0;
});
function pool(budget?: number) {
  vi.stubGlobal("AudioBuffer", Buffer);
  const p = new AudioSourcePool(budget);
  pools.push(p);
  return p;
}
describe("versioned pooled audio windows", () => {
  it("coalesces overlapping clip requests and cancellation preserves a remaining consumer", async () => {
    const p = pool(),
      cancel = new AbortController();
    const first = p.chunk("shared.wav", 0, cancel.signal),
      second = p.chunk("shared.wav", 0);
    const rejected = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    cancel.abort();
    await rejected;
    const buffer = await second;
    expect(buffer.getChannelData(0)[0]).toBeCloseTo(0.2);
    expect(state.decoded).toBe(1);
    expect(p.diagnostics().pending).toBe(0);
    await p.chunk("shared.wav", 0);
    expect(state.decoded).toBe(1);
    expect(p.diagnostics().cacheHits).toBe(1);
  });
  it("distinguishes overwritten files at the same author URL and reuses unchanged revisions", async () => {
    const p = pool(),
      old = p.bind("same.wav", { revision: "old", url: "/proxy/old.mp3" }),
      next = p.bind("same.wav", { revision: "new", url: "/proxy/new.mp3" });
    const a = await p.chunk(old, 0),
      b = await p.chunk(next, 0);
    expect(a.getChannelData(0)[0]).toBeCloseTo(0.2);
    expect(b.getChannelData(0)[0]).toBeCloseTo(0.8);
    await p.chunk(
      p.bind("same.wav", { revision: "old", url: "/proxy/old.mp3" }),
      0,
    );
    expect(state.opened).toEqual(["/proxy/old.mp3", "/proxy/new.mp3"]);
    expect(state.decoded).toBe(2);
  });
  it("does not attach a fresh seek to an already abandoned shared request", async () => {
    const p = pool(),
      controller = new AbortController();
    const stale = p.chunk("same.wav", 0, controller.signal);
    const rejected = expect(stale).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    const current = p.chunk("same.wav", 0);
    await rejected;
    expect((await current).getChannelData(0)[0]).toBeCloseTo(0.2);
    expect(p.diagnostics().pending).toBe(0);
  });
  it("selects a lower bandwidth rendition for constrained networks without mixing its cache identity", async () => {
    const p = pool(),
      descriptor = {
        revision: "sha",
        url: "/proxy/preview.mp3",
        renditions: { economy: "/proxy/economy.mp3" },
      };
    const normal = p.bind("source.wav", descriptor);
    await p.chunk(normal, 0);
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const economy = p.bind("source.wav", descriptor);
    await p.chunk(economy, 0);
    expect(economy).not.toBe(normal);
    expect(state.opened).toEqual(["/proxy/preview.mp3", "/proxy/economy.mp3"]);
    expect(state.decoded).toBe(2);
  });
  it("cancels a queued abandoned seek before opening any source and keeps decoded memory bounded", async () => {
    const p = pool(192000),
      abort = new AbortController();
    const abandoned = p.chunk("abandoned.wav", 0, abort.signal);
    const rejected = expect(abandoned).rejects.toMatchObject({
      name: "AbortError",
    });
    abort.abort();
    await rejected;
    await p.prepare("current.wav", 0, 2);
    expect(state.opened.some((url) => url.includes("abandoned"))).toBe(false);
    expect(p.diagnostics().cacheBytes).toBeLessThanOrEqual(192000);
    expect(p.diagnostics().decodedChunks).toBe(4);
  });
});
