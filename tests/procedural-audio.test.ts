import { describe, expect, it } from "vitest";
import { createPcmAudio, type StereoPcm } from "../src/engine/procedural-audio";

function fakeContext() {
  const starts: [number, number, number][] = [];
  const context = {
    currentTime: 0,
    createBuffer: (_channels: number, length: number, sampleRate: number) =>
      ({ duration: length / sampleRate, copyToChannel() {} }) as unknown as AudioBuffer,
    createBufferSource: () => ({
      buffer: null,
      playbackRate: { value: 1 },
      connect() {},
      disconnect() {},
      stop() {},
      start: (...args: [number, number, number]) => starts.push(args),
    }),
  };
  return { context: context as unknown as AudioContext, starts };
}
const pcm = (seconds: number): StereoPcm => [new Float32Array(seconds * 100), new Float32Array(seconds * 100)];
const options = (context: AudioContext, when: number) => ({
  trackId: "hit",
  context,
  destination: {} as AudioNode,
  when,
  offset: 0,
  duration: 2,
  rate: 1,
});

describe("generated PCM sounds", () => {
  it("makes a lazy sound placed past the live buffer when it is scheduled", async () => {
    let made = 0;
    const audio = createPcmAudio({ hit: () => (made++, pcm(2)) }, 100, { lazy: true });
    const { context, starts } = fakeContext();
    await audio.prepareAudio!(context);
    expect(made).toBe(0);
    const voice = audio.createAudio(options(context, 30));
    expect(voice.ready).toBeInstanceOf(Promise);
    await voice.ready;
    expect(made).toBe(1);
    expect(starts).toEqual([[30, 0, 2]]);
    // Made once: the next voice starts right away.
    expect(audio.createAudio(options(context, 40)).ready).toBeUndefined();
    expect(made).toBe(1);
  });
  it("skips ahead when the start time has passed", async () => {
    const audio = createPcmAudio({ hit: () => pcm(2) }, 100, { lazy: true });
    const { context, starts } = fakeContext();
    const voice = audio.createAudio(options(context, 5));
    (context as { currentTime: number }).currentTime = 5.5;
    await voice.ready;
    expect(starts).toEqual([[5.5, 0.5, 1.5]]);
  });
  it("does not play a sound disposed while it is made", async () => {
    const audio = createPcmAudio({ hit: () => pcm(2) }, 100, { lazy: true });
    const { context, starts } = fakeContext();
    const voice = audio.createAudio(options(context, 5));
    voice.dispose();
    await voice.ready;
    expect(starts).toEqual([]);
  });
  it("still requires prepareAudio without lazy", () => {
    const audio = createPcmAudio({ hit: () => pcm(2) }, 100);
    expect(() => audio.createAudio(options(fakeContext().context, 0))).toThrow("prepareAudio");
  });
});
