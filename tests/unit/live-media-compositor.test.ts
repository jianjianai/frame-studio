import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const media = vi.hoisted(() => ({
  open: vi.fn(),
  frame: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("../../src/engine/media-source", () => ({
  openVideoSource: media.open,
  openImageSource: vi.fn(),
}));
vi.mock("../../src/engine/types", () => ({ assetUrl: (src: string) => src }));
import { createCompositionScene } from "../../src/engine/compositor";
beforeEach(() => {
  media.open.mockReset();
  media.frame.mockReset();
  media.dispose.mockReset();
  const context = new Proxy(
    {},
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) },
  );
  vi.stubGlobal("document", {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  });
  media.open.mockResolvedValue({
    duration: 100,
    frame: media.frame,
    dispose: media.dispose,
  });
  media.frame.mockResolvedValue({ image: {}, width: 160, height: 90 });
});
afterEach(() => vi.unstubAllGlobals());
const scene = () =>
  createCompositionScene(
    { width: 320, height: 180, quality: "draft" },
    {
      schemaVersion: 1,
      clips: [
        {
          id: "video",
          source: { kind: "video", src: "films/test/source.mp4" },
          start: 0,
          duration: 20,
        },
      ],
    },
  );
describe("composition source cancellation ownership", () => {
  it("retains the active source when a stale frame is cancelled", async () => {
    const composition = scene();
    const controller = new AbortController();
    media.frame.mockImplementationOnce(
      (_time, signal: AbortSignal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const stale = composition.prepareFrame!(1, { signal: controller.signal });
    const rejected = expect(stale).rejects.toMatchObject({
      name: "AbortError",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await rejected;
    expect(media.dispose).not.toHaveBeenCalled();
    await composition.prepareFrame!(2, {
      signal: new AbortController().signal,
    });
    expect(media.open).toHaveBeenCalledTimes(1);
    composition.dispose();
    expect(media.dispose).toHaveBeenCalledTimes(1);
  });
  it("still releases failed decoder resources and retries with a clean source", async () => {
    const composition = scene();
    media.frame.mockRejectedValueOnce(Error("Decoder failed"));
    await expect(
      composition.prepareFrame!(1, { signal: new AbortController().signal }),
    ).rejects.toThrow("Decoder failed");
    expect(media.dispose).toHaveBeenCalledTimes(1);
    await composition.prepareFrame!(2, {
      signal: new AbortController().signal,
    });
    expect(media.open).toHaveBeenCalledTimes(2);
    composition.dispose();
    expect(media.dispose).toHaveBeenCalledTimes(2);
  });
});
