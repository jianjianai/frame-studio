import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioTransport } from "../../src/engine/audio";
import { createPlayerSession } from "../../src/engine/player-session";
import { beginPreviewSnapshot } from "../../src/engine/live-preview-lock";
import {
  prepareAudio,
  disposePreparedAudio,
} from "../../src/engine/audio-graph";
import { nextAudioControls } from "../../src/engine/live-audio-update";
import {
  AdaptiveAudioBuffer,
  MediaRequestQueue,
} from "../../src/engine/media-buffering";
import type {
  AnimationProject,
  AudioTrack,
  GeneratedAudioModule,
  Scene,
} from "../../src/engine/types";

const preview = vi.hoisted(() => vi.fn());
const bindings = vi.hoisted(() => vi.fn());
vi.mock("../../src/engine/preview-audio", async () => ({
  preparePreviewAudio: preview,
  PreviewBuffering: (await import("../../src/engine/media-buffering"))
    .PreviewBuffering,
}));
vi.mock("../../src/engine/audio-source-pool", () => ({
  AudioSourcePool: class {
    buffering = { observePreparation() {} };
    bind(src: string, source: unknown) {
      bindings(src, source);
      return src;
    }
    bufferSeconds() {
      return 4;
    }
    setActiveSources() {}
    diagnostics() {
      return { budgetBytes: 128 * 1024 * 1024 };
    }
    dispose() {}
  },
}));
class Param {
  value = 1;
  setValueAtTime(v: number) {
    this.value = v;
  }
  setTargetAtTime(v: number) {
    this.value = v;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {}
  cancelAndHoldAtTime() {}
}
class Node {
  gain = new Param();
  pan = new Param();
  onended: (() => void) | null = null;
  buffer: unknown;
  loop = false;
  playbackRate = new Param();
  connect() {}
  disconnect() {}
  start() {}
  stop() {}
}
class Context {
  currentTime = 0;
  sampleRate = 48000;
  state = "suspended";
  destination = new Node();
  createGain() {
    return new Node();
  }
  createStereoPanner() {
    return new Node();
  }
  createBufferSource() {
    return new Node();
  }
  createBuffer() {
    return {};
  }
  async suspend() {
    this.state = "suspended";
  }
  async resume() {
    this.state = "running";
  }
  async close() {
    this.state = "closed";
  }
}
const transports: AudioTransport[] = [];
const sessions: ReturnType<typeof createPlayerSession>[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(transports.splice(0).map((t) => t.dispose()));
  vi.unstubAllGlobals();
  preview.mockReset();
  bindings.mockReset();
});
const tracks: AudioTrack[] = [
  { id: "tone", name: "Tone", kind: "generated", gain: 0.8, duration: 20 },
  { id: "other", name: "Other", kind: "generated", gain: 0.5, duration: 20 },
];
const project = (
  module: GeneratedAudioModule,
  extra: Partial<AnimationProject> = {},
) =>
  ({
    duration: 20,
    livePreview: true,
    previewAudioGeneratorRevision: "stable-code",
    audioTracks: tracks,
    loadAudio: async () => module,
    ...extra,
  }) as AnimationProject;
function setup(mod: GeneratedAudioModule) {
  vi.stubGlobal("AudioContext", Context);
  const t = new AudioTransport(project(mod));
  transports.push(t);
  return t;
}

describe("live audio revision transactions", () => {
  it("runs legacy generators directly and changes one gain without restarting voices or context", async () => {
    const voices = new Map<string, any>(),
      creates: string[] = [];
    const prepare = vi.fn();
    const module = {
      prepareAudio: prepare,
      createAudio: vi.fn(({ trackId, destination }) => {
        creates.push(trackId);
        voices.set(trackId, destination);
        return { dispose: vi.fn() };
      }),
    } satisfies GeneratedAudioModule;
    const t = setup(module);
    await t.play();
    const context = t.context;
    await t.updateProject(
      project(module, {
        audioTracks: tracks.map((track) => ({
          ...track,
          gain: track.id === "tone" ? 0.35 : track.gain,
        })),
      }),
      { audioChanged: true },
    );
    expect(preview).not.toHaveBeenCalled();
    expect(t.context).toBe(context);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(creates).toEqual(["tone", "other"]);
    expect(voices.get("tone").gain.value).toBe(0.35);
    expect(t.clock.playing).toBe(true);
  });
  it("replaces only a changed source-time voice, preserving user overrides and unrelated nodes", async () => {
    const starts: string[] = [],
      disposes: string[] = [];
    const module = {
      createAudio: ({ trackId }: any) => {
        starts.push(trackId);
        return { dispose: () => disposes.push(trackId) };
      },
    } satisfies GeneratedAudioModule;
    const t = setup(module);
    await t.play();
    t.setTrack("other", { gain: 0.2 });
    t.seek(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    starts.length = 0;
    disposes.length = 0;
    await t.updateProject(
      project(module, {
        audioTracks: tracks.map((track) => ({
          ...track,
          ...(track.id === "tone" ? { offset: 0.5 } : {}),
          gain: 0.9,
        })),
      }),
    );
    expect(starts).toEqual(["tone"]);
    expect(disposes).toEqual(["tone"]);
    expect(t.controls.get("other")?.gain).toBe(0.2);
    expect(t.clock.time()).toBe(3);
  });
  it("preserves the last good graph and transport state when a new generator fails", async () => {
    const disposed = vi.fn();
    const good = { createAudio: () => ({ dispose: disposed }) };
    const t = setup(good);
    await t.play();
    const context = t.context,
      oldControls = [...t.controls];
    await expect(
      t.updateProject(
        project(
          {
            createAudio() {
              throw Error("bad candidate");
            },
          },
          { previewAudioGeneratorRevision: "new-code" },
        ),
      ),
    ).rejects.toThrow("bad candidate");
    expect(t.context).toBe(context);
    expect(t.clock.playing).toBe(true);
    expect(disposed).not.toHaveBeenCalled();
    expect([...t.controls]).toEqual(oldControls);
  });
  it("cancels async candidate readiness without late commit or disposing a shared module", async () => {
    const oldDisposed = vi.fn(),
      good = { createAudio: () => ({ dispose: oldDisposed }) };
    const t = setup(good);
    await t.play();
    let ready!: () => void;
    const controller = new AbortController();
    const next = {
      prepareAudio: () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
      createAudio: () => ({ dispose: vi.fn() }),
    };
    const update = t.updateProject(
      project(next, { previewAudioGeneratorRevision: "new-code" }),
      { signal: controller.signal },
    );
    const rejected = expect(update).rejects.toMatchObject({
      name: "AbortError",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await rejected;
    ready();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oldDisposed).not.toHaveBeenCalled();
    expect(t.clock.playing).toBe(true);
    expect(t.controls.get("tone")?.gain).toBe(0.8);
  });
  it("applies a paused audio revision without unlocking or resuming its suspended context", async () => {
    const module = { createAudio: vi.fn(() => ({ dispose: vi.fn() })) };
    const t = setup(module);
    await t.updateProject(project(module));
    expect(t.context?.state).toBe("suspended");
    expect(t.clock.playing).toBe(false);
    expect(module.createAudio).not.toHaveBeenCalled();
  });
  it("rolls back paired scene failures before touching working audio voices", async () => {
    const disposed = vi.fn(),
      module = { createAudio: () => ({ dispose: disposed }) };
    const t = setup(module);
    await t.play();
    let suspended = false;
    await expect(
      t.updateProject(
        project(module, {
          audioTracks: tracks.map((track) => ({ ...track, offset: 0.5 })),
        }),
        {
          beforeCommit() {
            suspended = t.context?.state === "suspended";
            throw Error("scene refresh failed");
          },
        },
      ),
    ).rejects.toThrow("scene refresh failed");
    expect(suspended).toBe(true);
    expect(disposed).not.toHaveBeenCalled();
    expect(t.clock.playing).toBe(true);
    expect(t.context?.state).toBe("running");
  });
  it("keeps original frozen media for offline export while live uses compressed renditions", async () => {
    const src = "films/fixture/raw.wav",
      snapshot = project(
        {
          createAudio() {
            throw Error("unused");
          },
        },
        {
          audioTracks: [{ id: "file", name: "Original", kind: "file", src }],
          previewAudioSources: {
            [src]: {
              revision: "sha",
              url: "/live/audio/preview.mp3",
              originalUrl: "/live/assets/raw.wav?v=sha",
              renditions: { economy: "/live/audio/economy.mp3" },
            },
          },
        },
      );
    const context = new Context() as unknown as BaseAudioContext;
    const offline = await prepareAudio(snapshot, context);
    expect(bindings).toHaveBeenLastCalledWith(src, {
      revision: "sha",
      url: "/live/assets/raw.wav?v=sha",
    });
    disposePreparedAudio(offline, context);
    const live = await prepareAudio(snapshot, context, undefined, true);
    expect(bindings).toHaveBeenLastCalledWith(
      src,
      snapshot.previewAudioSources![src],
    );
    disposePreparedAudio(live, context);
  });
  it("reuses an in-progress module session when a newer edit cancels the first candidate", async () => {
    const good = { createAudio: () => ({ dispose: vi.fn() }) },
      t = setup(good);
    await t.play();
    let release!: () => void;
    const disposed = vi.fn(),
      prepare = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    const next = {
      prepareAudio: prepare,
      createAudio: () => ({ dispose: vi.fn() }),
      disposeAudio: disposed,
    };
    const candidate = () =>
      project(next, { previewAudioGeneratorRevision: "fresh-code" });
    const abandoned = t.updateProject(candidate()),
      rejected = expect(abandoned).rejects.toMatchObject({
        name: "AbortError",
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const latest = t.updateProject(candidate());
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await latest;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(disposed).not.toHaveBeenCalled();
  });
  it("adopts changed author defaults while preserving explicit user mixer overrides", () => {
    const next = tracks.map((t) => ({ ...t, gain: 1, muted: true }));
    const controls = nextAudioControls(
      tracks,
      next,
      new Map([
        ["tone", { gain: 0.8, muted: false }],
        ["other", { gain: 0.2, muted: false }],
      ]),
    );
    expect(controls.get("tone")).toEqual({ gain: 1, muted: true });
    expect(controls.get("other")).toEqual({ gain: 0.2, muted: true });
  });
});


class Surface {
  width = 320;
  height = 180;
  frame = "";
  parentElement = null;
  context = {
    fillStyle: "",
    fillRect() {},
    drawImage: (source: Surface) => { this.frame = source.frame; },
  };
  getContext() { return this.context; }
  toDataURL() { return this.frame; }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function pairedProject(module: GeneratedAudioModule, name: string, gain: number, render?: () => Promise<void>) {
  const canvas = new Surface();
  const scene: Scene = {
    canvas: canvas as unknown as HTMLCanvasElement,
    async render(time) { await render?.(); canvas.frame = name + ":" + time; },
    dispose: vi.fn(),
  };
  return project(module, {
    id: "live-pair", title: name, renderer: "canvas", subtitles: [],
    composition: { width: 320, height: 180 },
    audioTracks: tracks.map(track => ({ ...track, ...(track.id === "tone" ? { gain } : {}) })),
    load: async () => ({ createScene: () => scene }),
  });
}
function pairedSession() {
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", { search: "?debug=1" });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("document", {
    createElement: () => new Surface(), getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
  });
  const module = { createAudio: () => ({ dispose: vi.fn() }) };
  const initial = pairedProject(module, "old", 0.8), canvas = new Surface();
  const errors = vi.fn();
  const session = createPlayerSession({
    canvas: canvas as unknown as HTMLCanvasElement, project: initial, quality: "standard", embedded: false,
    initial: { time: 3, playing: false, buffering: false, rate: 1.25, loop: true, volume: 0.4, muted: false },
    controls: { other: { gain: 0.2, muted: false } }, subtitles: () => false, segmentEnd: () => null,
    onSegmentEnd() {}, onSnapshot() {}, onLoading() {}, onError: errors, onFps() {}, onTrackControl() {},
  });
  sessions.push(session); transports.push(session.audio);
  return { session, canvas, module, initial, errors };
}

describe("paired live player acceptance", () => {
  it("advances canvas, audio and observed revision before a delayed resume, and stays accepted when superseded", async () => {
    const { session, canvas, module } = pairedSession();
    await session.ready;
    await session.audio.play();
    const context = session.audio.context as unknown as Context;
    const started = deferred(), release = deferred(), cancel = new AbortController();
    vi.spyOn(context, "resume").mockImplementationOnce(async () => {
      started.resolve(); await release.promise; context.state = "running";
    });
    let applied = 1;
    const next = pairedProject(module, "second", 0.3);
    const update = session.updateProject(next, {
      revision: 2, signal: cancel.signal,
      onCommit() {
        expect(session.renderer.project).toBe(next);
        expect(session.audio.controls.get("tone")?.gain).toBe(0.3);
        applied = 2;
      },
    });
    await started.promise;
    expect(applied).toBe(2);
    expect(canvas.frame).toBe("second:3");
    expect(session.api.getDiagnostics!()).toMatchObject({ livePreview: { revision: 2 } });
    expect(session.audio.context).toBe(context);
    cancel.abort(new DOMException("Superseded SSE revision", "AbortError"));
    const latestProject = pairedProject(module, "third", 0.1);
    const latest = session.updateProject(latestProject, { revision: 3, onCommit: () => { applied = 3; } });
    release.resolve();
    expect(await update).toBe(true);
    expect(await latest).toBe(true);
    expect(applied).toBe(3);
    expect(canvas.frame).toBe("third:3");
    expect(session.audio.controls.get("tone")?.gain).toBe(0.1);
    expect(session.snapshot()).toMatchObject({ time: 3, playing: true, rate: 1.25, loop: true, volume: 0.4 });
    expect(session.audio.controls.get("other")?.gain).toBe(0.2);
  });

  it("freezes the old pair before acceptance and the new pair when export begins during resume", async () => {
    const { session, canvas, module, initial } = pairedSession();
    await session.ready;
    await session.audio.play();
    const rendering = deferred(), finish = deferred(), cancel = new AbortController();
    let applied = 1;
    const next = pairedProject(module, "new", 0.25, async () => { rendering.resolve(); await finish.promise; });
    const abortForExport = () => cancel.abort(new DOMException("Frozen export", "AbortError"));
    window.addEventListener("frame-preview-readers", abortForExport);
    const before = session.updateProject(next, { revision: 2, signal: cancel.signal, onCommit: () => { applied = 2; } });
    await rendering.promise;
    const releaseOld = beginPreviewSnapshot();
    finish.resolve();
    expect(await before).toBe(false);
    expect(applied).toBe(1);
    expect(session.renderer.project).toBe(initial);
    expect(canvas.frame).toBe("old:3");
    expect(session.audio.controls.get("tone")?.gain).toBe(0.8);
    releaseOld();
    window.removeEventListener("frame-preview-readers", abortForExport);

    const context = session.audio.context as unknown as Context;
    const started = deferred(), resume = deferred(), acceptedCancel = new AbortController();
    vi.spyOn(context, "resume").mockImplementationOnce(async () => {
      started.resolve(); await resume.promise; context.state = "running";
    });
    const after = session.updateProject(next, { revision: 2, signal: acceptedCancel.signal, onCommit: () => { applied = 2; } });
    await started.promise;
    window.addEventListener("frame-preview-readers", () => acceptedCancel.abort(), { once: true });
    const releaseNew = beginPreviewSnapshot();
    session.audio.pause();
    const frozen = { project: session.renderer.project, revision: applied, frame: canvas.frame, gain: session.audio.controls.get("tone")?.gain };
    expect(frozen).toEqual({ project: next, revision: 2, frame: "new:3", gain: 0.25 });
    resume.resolve();
    expect(await after).toBe(true);
    expect(session.snapshot().playing).toBe(false);
    expect(canvas.frame).toBe(frozen.frame);
    expect(applied).toBe(frozen.revision);
    releaseNew();
  });

  it("accepts a paused pair without resuming or replacing its context or playback preferences", async () => {
    const { session, canvas, module } = pairedSession();
    await session.ready;
    await session.audio.preparePosition();
    const context = session.audio.context as unknown as Context;
    const resume = vi.spyOn(context, "resume");
    const accepted = vi.fn();
    expect(await session.updateProject(pairedProject(module, "paused", 0.5), { revision: 2, onCommit: accepted })).toBe(true);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(session.audio.context).toBe(context);
    expect(canvas.frame).toBe("paused:3");
    expect(session.snapshot()).toMatchObject({ time: 3, playing: false, rate: 1.25, loop: true, volume: 0.4 });
  });

  it("keeps the accepted pair when playback resume fails or an acceptance observer throws", async () => {
    const { session, canvas, module, errors } = pairedSession();
    await session.ready;
    await session.audio.play();
    const context = session.audio.context as unknown as Context;
    vi.spyOn(context, "resume").mockRejectedValueOnce(Error("resume blocked"));
    let applied = 1;
    const next = pairedProject(module, "accepted", 0.6);
    expect(await session.updateProject(next, { revision: 2, onCommit: () => { applied = 2; } })).toBe(true);
    expect(applied).toBe(2);
    expect(session.renderer.project).toBe(next);
    expect(canvas.frame).toBe("accepted:3");
    expect(session.audio.controls.get("tone")?.gain).toBe(0.6);
    expect(errors).toHaveBeenCalledWith("播放已暂停：resume blocked");
    const observed = pairedProject(module, "observer", 0.7);
    expect(await session.updateProject(observed, { revision: 3, onCommit: () => { throw Error("observer failure"); } })).toBe(true);
    expect(session.renderer.project).toBe(observed);
    expect(canvas.frame).toBe("observer:3");
    expect(session.audio.controls.get("tone")?.gain).toBe(0.7);
  });
});

describe("adaptive weak network backpressure", () => {
  it("increases lookahead for high latency and readiness cost without exceeding PCM budget", () => {
    const policy = new AdaptiveAudioBuffer();
    const baseline = policy.seconds();
    policy.observeNetwork(32000, 2, 3);
    policy.observePreparation(8);
    expect(policy.seconds()).toBeGreaterThan(baseline);
    const limited = policy.seconds(2, 32, 32 * 1024 * 1024);
    expect(limited * 2 * 32 * 384000).toBeLessThanOrEqual(
      (32 * 1024 * 1024) / 2,
    );
    expect(policy.diagnostics().throughputBytesPerSecond).toBe(16000);
  });
  it("holds download slots for the response stream and releases a lease exactly once", async () => {
    const queue = new MediaRequestQueue(1),
      signal = new AbortController().signal;
    const release = await queue.acquire(signal);
    const abort = new AbortController();
    const blocked = queue.acquire(abort.signal);
    const rejected = expect(blocked).rejects.toMatchObject({
      name: "AbortError",
    });
    abort.abort();
    await rejected;
    expect(queue.diagnostics().active).toBe(1);
    release();
    release();
    expect(queue.diagnostics().active).toBe(0);
  });
});
