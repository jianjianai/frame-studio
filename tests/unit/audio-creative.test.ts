import { describe, expect, it, vi } from "vitest";
import {
  validateAudioDocument,
  compileAudioTracks,
  editAudioDocument,
} from "../../src/engine/audio-document.mjs";
import {
  noteToMidi,
  semitoneRate,
  notesInSegment,
  createSamplerAudio,
} from "../../src/engine/audio-authoring";
const document = () => ({
  schemaVersion: 1,
  sources: [{ id: "sample", kind: "file", src: "films/test/sample.wav" }],
  tracks: [{ id: "music", name: "Music" }],
  clips: [
    {
      id: "sample",
      track: "music",
      source: "sample",
      start: 0,
      duration: 4,
      rate: 2,
      pitch: 7,
      preservePitch: true,
      stretch: { formantCompensation: true, preset: "cheaper" },
    },
  ],
});
describe("creative audio authoring contracts", () => {
  it("keeps pitch/formants and source phase through split/compile", () => {
    const doc = editAudioDocument(document(), [
      { op: "split", id: "sample", at: 1.25, newId: "right" },
    ]);
    const tracks = compileAudioTracks(doc);
    expect(tracks[1]).toMatchObject({
      playbackRate: 2,
      pitch: 7,
      preservePitch: true,
      phase: 2.5,
      stretch: { formantCompensation: true, preset: "cheaper" },
    });
  });
  it("rejects invalid stretch and unknown Tone effect without dropping old documents", () => {
    expect(() =>
      validateAudioDocument({
        ...document(),
        clips: [
          { ...document().clips[0], stretch: { blockMs: 20, intervalMs: 40 } },
        ],
      }),
    ).toThrow();
    expect(() =>
      validateAudioDocument({
        ...document(),
        tracks: [
          {
            id: "music",
            name: "Music",
            processors: [{ type: "tone", effect: "NotAnEffect" }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      validateAudioDocument({
        ...document(),
        tracks: [
          {
            id: "music",
            name: "Music",
            processors: [
              { type: "tone", effect: "Chorus", options: { context: {} } },
            ],
          },
        ],
      }),
    ).toThrow("belong to the host");
    const legacy = structuredClone(document());
    delete (legacy.clips[0] as any).pitch;
    delete (legacy.clips[0] as any).preservePitch;
    delete (legacy.clips[0] as any).stretch;
    expect(validateAudioDocument(legacy).clips[0]).toMatchObject({
      pitch: 0,
      preservePitch: false,
    });
  });
  it("converts accidentals and includes sustained notes at arbitrary left edges", () => {
    expect(noteToMidi("C4")).toBe(60);
    expect(noteToMidi("Db4")).toBe(61);
    expect(noteToMidi("B#3")).toBe(60);
    expect(semitoneRate(12)).toBe(2);
    expect(
      notesInSegment([{ at: 1, duration: 3, note: "A4" }], 2, 1),
    ).toMatchObject([{ midi: 69, age: 1, delay: 0, length: 1 }]);
    expect(() => noteToMidi("H4")).toThrow();
    expect(() =>
      notesInSegment([{ at: 0, duration: -1, note: 60 }], 0, 1),
    ).toThrow();
  });
});

import {
  SignalsmithPcmCache,
  signalsmithPadding,
} from "../../src/engine/signalsmith-pcm";
describe("processed PCM reservations", () => {
  it("reserves the official maximum split-computation latency", () => {
    expect(signalsmithPadding()).toBe(0.5);
    expect(
      signalsmithPadding({
        blockMs: 500,
        intervalMs: 250,
        splitComputation: true,
      }),
    ).toBe(0.75);
    expect(signalsmithPadding({ blockMs: 500, splitComputation: true })).toBe(
      0.625,
    );
  });
  it("never evicts pending reservations to admit another render", async () => {
    const cache = new SignalsmithPcmCache(128);
    let finish!: (buffer: AudioBuffer) => void;
    const a = cache.get(
      "a",
      128,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect(() => cache.get("b", 1, async () => ({}) as AudioBuffer)).toThrow(
      "Concurrent",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish({} as AudioBuffer);
    await a;
    await cache.get("b", 128, async () => ({}) as AudioBuffer);
    expect(cache.diagnostics().cacheBytes).toBe(128);
    cache.clear();
  });
  it("keeps render preparation concurrency at two and cancels queued work on release", async () => {
    const cache = new SignalsmithPcmCache(1024);
    const finish: (() => void)[] = [];
    let active = 0,
      peak = 0;
    const work = () =>
      new Promise<AudioBuffer>((resolve) => {
        active++;
        peak = Math.max(peak, active);
        finish.push(() => {
          active--;
          resolve({} as AudioBuffer);
        });
      });
    const a = cache.get("a", 128, work),
      b = cache.get("b", 128, work),
      c = cache.get("c", 128, work);
    const rejected = expect(c).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(2);
    expect(cache.diagnostics().rendering.queued).toBe(1);
    cache.clear();
    await rejected;
    finish.forEach((done) => done());
    await Promise.all([a, b]);
    expect(peak).toBe(2);
  });
});

describe("sampler source preparation", () => {
  it("bounds simultaneous sample decodes and cancels queued sources when the PCM budget is exceeded", async () => {
    let active = 0,
      peak = 0,
      decodes = 0;
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(1),
    }));
    const context = {
      decodeAudioData: async () => {
        active++;
        peak = Math.max(peak, active);
        decodes++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { length: 16, numberOfChannels: 1 } as AudioBuffer;
      },
    } as unknown as BaseAudioContext;
    const module = createSamplerAudio({
      samples: {
        C4: "films/test/c.wav",
        D4: "films/test/d.wav",
        E4: "films/test/e.wav",
        F4: "films/test/f.wav",
      },
      notes: [],
      maxBufferBytes: 100,
    });
    try {
      await expect(module.prepareAudio!(context)).rejects.toThrow(
        "exceed budget",
      );
      expect(peak).toBe(2);
      expect(decodes).toBeLessThan(4);
    } finally {
      module.disposeAudio!(context);
      vi.unstubAllGlobals();
    }
  });
});
