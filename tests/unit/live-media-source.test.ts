import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const media = vi.hoisted(() => ({
  inputs: [] as { options: unknown; disposed: number }[],
  reads: [] as number[],
  openedIterators: 0,
  closedIterators: 0,
  gate: undefined as undefined | (() => Promise<void>),
  ready: undefined as undefined | (() => Promise<void>),
  aspect: 9 / 16,
  qualities: [] as string[],
}));
vi.mock("../../src/engine/types", () => ({
  assetUrl: (src: string) => src,
  previewAssetUrl: (src: string, quality: string) => {
    media.qualities.push(quality);
    return src;
  },
}));
vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  UrlSource: class {
    constructor(
      public url: string,
      public options: unknown,
    ) {}
  },
  Input: class {
    disposed = 0;
    constructor(public options: unknown) {
      media.inputs.push(this);
    }
    dispose() {
      this.disposed++;
    }
    async getPrimaryVideoTrack() {
      await media.ready?.();
      if (this.disposed) throw Error("Input disposed");
      return {
        canDecode: async () => true,
        getFirstTimestamp: async () => 0,
        computeDuration: async () => 100,
        getDisplayWidth: async () => 16,
        getDisplayHeight: async () => 16 * media.aspect,
      };
    }
  },
  CanvasSink: class {
    constructor(
      _track: unknown,
      public options: { width: number },
    ) {}
    async *canvases(time: number) {
      media.openedIterators++;
      try {
        for (let at = Math.floor(time * 10) / 10; at < 100; at += 0.1) {
          media.reads.push(Number(at.toFixed(2)));
          await media.gate?.();
          yield {
            timestamp: at,
            duration: 0.1,
            canvas: {
              width: this.options.width,
              height: Math.round(this.options.width * media.aspect),
            },
          };
        }
      } finally {
        media.closedIterators++;
      }
    }
  },
}));
import {
  clearVideoSourceCache,
  openVideoSource,
  openImageSource,
  videoSourceDiagnostics,
} from "../../src/engine/media-source";
const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
beforeEach(async () => {
  clearVideoSourceCache();
  await tick();
  expect(videoSourceDiagnostics().reservedDecodedBytes).toBe(0);
  expect(videoSourceDiagnostics().images.bitmapBytes).toBe(0);
  media.inputs.length = 0;
  media.reads.length = 0;
  media.openedIterators = 0;
  media.closedIterators = 0;
  media.gate = undefined;
  media.ready = undefined;
  media.aspect = 9 / 16;
  media.qualities.length = 0;
});
afterEach(() => vi.unstubAllGlobals());
describe("live media ownership and range reuse", () => {
  it("rejects a cancelled stale frame promptly without destroying the retained input", async () => {
    const source = await openVideoSource("source.mp4?v=one", 320);
    const blocked = gate();
    media.gate = () => blocked.promise;
    const controller = new AbortController();
    const stale = source.frame(20, controller.signal);
    const rejected = expect(stale).rejects.toMatchObject({
      name: "AbortError",
    });
    await tick();
    controller.abort();
    await rejected;
    expect(media.inputs[0].disposed).toBe(0);
    media.gate = undefined;
    blocked.release();
    const result = await source.frame(4);
    expect(result.width).toBe(320);
    expect(media.inputs[0].disposed).toBe(0);
    source.dispose();
    clearVideoSourceCache();
    await tick();
    expect(media.inputs[0].disposed).toBe(1);
    expect(result.image).toMatchObject({ width: 1, height: 1 });
  });
  it("shares initialization and compressed data, while each scene owns its decoder", async () => {
    const blocked = gate();
    media.ready = () => blocked.promise;
    const cancelled = new AbortController();
    const abandoned = openVideoSource(
      "source.mp4?v=one",
      320,
      cancelled.signal,
    );
    const rejected = expect(abandoned).rejects.toMatchObject({
      name: "AbortError",
    });
    const acquired = openVideoSource("source.mp4?v=one", 640);
    cancelled.abort();
    await rejected;
    expect(media.inputs).toHaveLength(1);
    expect(media.inputs[0].disposed).toBe(0);
    media.ready = undefined;
    blocked.release();
    const second = await acquired;
    const third = await openVideoSource("source.mp4?v=one", 320);
    second.dispose();
    await tick();
    expect((await third.frame(1)).width).toBe(320);
    expect(media.inputs[0].disposed).toBe(0);
    const revision = await openVideoSource("source.mp4?v=two", 320);
    expect(media.inputs).toHaveLength(2);
    third.dispose();
    revision.dispose();
    clearVideoSourceCache();
    await tick();
    expect(media.inputs.map((item) => item.disposed)).toEqual([1, 1]);
  });
  it("coalesces the same timestamp and skips cancelled queued seek bursts", async () => {
    const source = await openVideoSource("source.mp4", 320);
    const blocked = gate();
    media.gate = () => blocked.promise;
    const first = source.frame(0),
      duplicate = source.frame(0);
    await tick();
    const abandoned = Array.from({ length: 50 }, (_, i) => {
      const controller = new AbortController();
      const request = source
        .frame(2 + i, controller.signal)
        .catch((error) => error.name);
      controller.abort();
      return request;
    });
    media.gate = undefined;
    blocked.release();
    expect(await first).toEqual(await duplicate);
    expect(await Promise.all(abandoned)).toEqual(Array(50).fill("AbortError"));
    await source.frame(4);
    expect(media.reads).toEqual([0, 4]);
    expect(videoSourceDiagnostics().network.active).toBeLessThanOrEqual(4);
    source.dispose();
    clearVideoSourceCache();
    await tick();
  });
  it("keeps one sequential decoder during playback and rebuilds it for a true seek", async () => {
    const source = await openVideoSource("source.mp4", 320);
    await source.frame(1);
    await source.frame(1.03);
    await source.frame(1.1);
    await source.frame(1.2);
    expect(media.openedIterators).toBe(1);
    expect(media.reads).toEqual([1, 1.1, 1.2]);
    await source.frame(30);
    await source.frame(3);
    expect(media.openedIterators).toBe(3);
    expect(media.closedIterators).toBe(2);
    source.dispose();
    clearVideoSourceCache();
    await tick();
    expect(media.closedIterators).toBe(3);
  });
  it("evicts only idle sources and enforces the aggregate compressed-data budget", async () => {
    const sources = [];
    for (let i = 0; i < 32; i++)
      sources.push(await openVideoSource("source-" + i + ".mp4", 16));
    const diagnostics = videoSourceDiagnostics();
    expect(diagnostics.reservedCacheBytes).toBe(diagnostics.cacheBudgetBytes);
    await expect(openVideoSource("too-many.mp4", 16)).rejects.toThrow(
      "缓存预算",
    );
    expect(media.inputs).toHaveLength(32);
    sources[0].dispose();
    await tick();
    sources.push(await openVideoSource("next.mp4", 16));
    expect(media.inputs[0].disposed).toBe(1);
    expect(media.inputs[1].disposed).toBe(0);
    for (const source of sources) source.dispose();
    clearVideoSourceCache();
    await tick();
    expect(videoSourceDiagnostics().sources).toBe(0);
  });
  it("refuses canvas reservations beyond the decoded surface budget before allocating", async () => {
    media.aspect = 1;
    const sources = [];
    for (let i = 0; i < 4; i++)
      sources.push(await openVideoSource("large.mp4", 2800));
    expect(videoSourceDiagnostics().reservedDecodedBytes).toBe(
      4 * 2800 * 2800 * 8,
    );
    await expect(openVideoSource("large.mp4", 2800)).rejects.toThrow(
      "画面预算",
    );
    expect(videoSourceDiagnostics().owners).toBe(4);
    sources.forEach((source) => source.dispose());
    clearVideoSourceCache();
    await tick();
  });
  it("session cleanup retires active entries without breaking their current owners", async () => {
    const first = await openVideoSource("source.mp4", 320);
    clearVideoSourceCache();
    expect(media.inputs[0].disposed).toBe(0);
    const second = await openVideoSource("source.mp4", 320);
    expect(media.inputs).toHaveLength(2);
    first.dispose();
    await tick();
    expect(media.inputs[0].disposed).toBe(1);
    expect((await second.frame(2)).width).toBe(320);
    second.dispose();
    clearVideoSourceCache();
    await tick();
  });
  it("limits body downloads across sources and releases network slots on cancel", async () => {
    const source = await openVideoSource("source.mp4", 320);
    const options = media.inputs[0].options as {
      source: { options: { fetchFn: typeof fetch } };
    };
    const remote = vi.fn(async () => {
      const response = new Response(new ReadableStream<Uint8Array>({}), {
        headers: { "Content-Length": "100" },
      });
      Object.defineProperties(response, {
        url: { value: "https://test.invalid/final.mp4" },
        redirected: { value: true },
        type: { value: "basic" },
      });
      return response;
    });
    vi.stubGlobal("fetch", remote);
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const downloads = controllers.map((controller) =>
      options.source.options.fetchFn("/video.mp4", {
        signal: controller.signal,
      }),
    );
    await tick();
    expect(remote).toHaveBeenCalledTimes(4);
    expect(videoSourceDiagnostics().network).toMatchObject({
      active: 4,
      queued: 2,
    });
    const first = await downloads[0];
    expect(first).toMatchObject({
      url: "https://test.invalid/final.mp4",
      redirected: true,
      type: "basic",
    });
    await first.body!.cancel();
    await tick();
    expect(remote).toHaveBeenCalledTimes(5);
    controllers[1].abort();
    await tick();
    expect(remote).toHaveBeenCalledTimes(6);
    await Promise.all(
      (await Promise.all(downloads))
        .slice(1)
        .map((response) => response.body!.cancel()),
    );
    expect(videoSourceDiagnostics().network).toMatchObject({
      active: 0,
      queued: 0,
    });
    source.dispose();
    clearVideoSourceCache();
    await tick();
  });

  it("shares ownership and budgets across hot revision module copies", async () => {
    const first = await openVideoSource("source.mp4?v=one", 320);
    vi.resetModules();
    const revision = await import("../../src/engine/media-source");
    expect(revision.videoSourceDiagnostics().owners).toBe(1);
    const second = await revision.openVideoSource("source.mp4?v=one", 640);
    expect(media.inputs).toHaveLength(1);
    expect(videoSourceDiagnostics().owners).toBe(2);
    first.dispose();
    expect((await second.frame(2)).width).toBe(640);
    second.dispose();
    revision.clearVideoSourceCache();
    await tick();
    expect(videoSourceDiagnostics().reservedDecodedBytes).toBe(0);
    expect(revision.videoSourceDiagnostics().sources).toBe(0);
  });

  it("selects economy sources on a constrained link while explicit high keeps originals", async () => {
    vi.stubGlobal("navigator", {
      connection: { effectiveType: "3g", downlink: 0.8 },
    });
    const automatic = await openVideoSource("source.mp4", 320);
    const original = await openVideoSource(
      "source.mp4",
      320,
      undefined,
      "high",
    );
    const economy = await openVideoSource(
      "source.mp4",
      320,
      undefined,
      "draft",
    );
    expect(media.qualities).toEqual(["draft", "high", "draft"]);
    automatic.dispose();
    original.dispose();
    economy.dispose();
    clearVideoSourceCache();
    await tick();
    vi.stubGlobal("navigator", {
      connection: { effectiveType: "4g", downlink: 10 },
    });
    const standard = await openVideoSource("fast.mp4", 320);
    expect(media.qualities.at(-1)).toBe("standard");
    standard.dispose();
    clearVideoSourceCache();
    await tick();
  });

  it("retries a failed frame with a clean iterator instead of presenting an old cached canvas", async () => {
    const source = await openVideoSource("source.mp4", 320);
    await source.frame(1);
    media.gate = async () => {
      throw Error("Connection lost");
    };
    await expect(source.frame(1.2)).rejects.toThrow("Connection lost");
    media.gate = undefined;
    expect((await source.frame(1.2)).width).toBe(320);
    expect(media.openedIterators).toBe(2);
    expect(media.inputs[0].disposed).toBe(0);
    source.dispose();
    clearVideoSourceCache();
    await tick();
  });
  it("coalesces image bytes while caller cancellation and bitmap close remain owner local", async () => {
    const blocked = gate();
    const remote = vi.fn(async () => {
      await blocked.promise;
      return new Response(new Uint8Array(1024), {
        headers: { "Content-Type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", remote);
    const bitmap = vi.fn(
      async (_image: unknown, options?: ImageBitmapOptions) => ({
        width: options?.resizeWidth ?? 4000,
        height: options?.resizeHeight ?? 2000,
        close: vi.fn(),
      }),
    );
    vi.stubGlobal("createImageBitmap", bitmap);
    const controller = new AbortController();
    const abandoned = openImageSource("image.png", controller.signal, 640, 360);
    const rejected = expect(abandoned).rejects.toMatchObject({
      name: "AbortError",
    });
    const retained = openImageSource("image.png", undefined, 640, 360);
    controller.abort();
    await rejected;
    blocked.release();
    const large = await retained;
    const small = await openImageSource("image.png", undefined, 320, 180);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(large).toMatchObject({ width: 640, height: 320 });
    expect(small).toMatchObject({ width: 320, height: 160 });
    expect(videoSourceDiagnostics().images.cachedBytes).toBe(1024);
    expect(videoSourceDiagnostics().images.bitmapBytes).toBe(
      (640 * 320 + 320 * 160) * 4,
    );
    large.close();
    large.close();
    expect(videoSourceDiagnostics().images.bitmapBytes).toBe(320 * 160 * 4);
    small.close();
    clearVideoSourceCache();
    await tick();
    expect(videoSourceDiagnostics().images).toMatchObject({
      cachedBytes: 0,
      bitmapBytes: 0,
    });
  });
  it("enforces the image compressed cache budget while consuming the response body", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(new Uint8Array(33 * 1024 * 1024)),
    );
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    await expect(openImageSource("too-large.png")).rejects.toThrow(
      "图片缓存预算",
    );
    expect(decode).not.toHaveBeenCalled();
    expect(videoSourceDiagnostics().images.cachedBytes).toBe(0);
    expect(videoSourceDiagnostics().network.active).toBe(0);
  });
});
