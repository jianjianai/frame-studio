import {
  createLiveAudioInput,
  enumerateLiveAudioInputs,
  liveAudioInputSupported,
  type LiveAudioInputHandle,
} from "./live-audio-input";
import type * as ToneType from "tone";
import type * as ToneClasses from "tone/build/esm/classes.js";
import { toneEffectNames } from "./audio-capabilities.mjs";
let classes: typeof ToneClasses | undefined;
let preparing: Promise<typeof ToneClasses> | undefined;
let version = "",
  supported: (() => Promise<boolean>) | undefined;
const bufferContexts: WeakRef<BaseAudioContext>[] = [];
function bufferContext() {
  for (let i = bufferContexts.length - 1; i >= 0; i--) {
    const raw = bufferContexts[i].deref();
    if (raw && (!("state" in raw) || raw.state !== "closed")) return raw;
    bufferContexts.splice(i, 1);
  }
  throw Error(
    "Prepare a FRAME audio context before loading Tone audio buffers",
  );
}
export async function prepareTone() {
  return (preparing ??= (async () => {
    const [module, globals, dummy, metadata, browserSupport] =
      await Promise.all([
        import("tone/build/esm/classes.js"),
        import("tone/build/esm/core/Global.js"),
        import("tone/build/esm/core/context/DummyContext.js"),
        import("tone/build/esm/version.js"),
        import("tone/build/esm/core/context/AudioContext.js"),
      ]);
    // Tone's getDefaults calls its global getter even for explicitly contextual nodes.
    // Keep that private fallback inert so no hidden native context/worker can appear.
    class BufferContext extends dummy.DummyContext {
      get sampleRate() {
        try {
          return bufferContext().sampleRate;
        } catch {
          return 48000;
        }
      }
      createBuffer(channels: number, length: number, sampleRate: number) {
        return new AudioBuffer({
          numberOfChannels: channels,
          length,
          sampleRate,
        });
      }
      decodeAudioData(bytes: ArrayBuffer) {
        return bufferContext().decodeAudioData(bytes);
      }
    }
    globals.setContext(new BufferContext());
    classes = module;
    version = metadata.version;
    supported = browserSupport.supported;
    return module;
  })());
}
/** A borrowed context never resumes/closes the player or installs a second clock. */
export function createToneContext(
  raw: BaseAudioContext,
  destination?: AudioNode | ToneType.ToneAudioNode,
): ToneType.BaseContext {
  if (!classes) throw Error("Call prepareTone before constructing Tone nodes");
  const bufferReference = new WeakRef(raw);
  bufferContexts.push(bufferReference);
  const previousStateChange = raw.onstatechange;
  let closed = false;
  const cleanup = (context: ToneType.BaseContext) => {
    if (closed) return;
    closed = true;
    const internals = context as unknown as {
      _initialized: boolean;
      _constants: Map<number, AudioBufferSourceNode>;
    };
    if (internals._initialized) {
      context.transport.dispose();
      context.draw.dispose();
      context.destination.dispose();
      context.listener.dispose();
    }
    for (const node of internals._constants.values()) {
      try {
        node.stop();
      } catch {}
      node.disconnect();
    }
    internals._constants.clear();
    if (installedStateChange)
      raw.removeEventListener("statechange", installedStateChange);
    const index = bufferContexts.indexOf(bufferReference);
    if (index >= 0) bufferContexts.splice(index, 1);
  };
  class BorrowedContext extends classes.Context {
    get clockSource() {
      return "offline" as const;
    }
    set clockSource(value: "offline" | "worker" | "timeout") {
      if (value !== "offline")
        throw Error("FRAME owns clock ticks; use the host scheduling bridge");
    }
    async close() {
      cleanup(this);
    }
    async resume() {}
  }
  class BorrowedOfflineContext extends classes.OfflineContext {
    get clockSource() {
      return "offline" as const;
    }
    set clockSource(value: "offline" | "worker" | "timeout") {
      if (value !== "offline")
        throw Error(
          "Offline Tone clock is driven by deterministic sample blocks",
        );
    }
    async close() {
      cleanup(this);
    }
    async resume() {}
  }
  const context =
    "startRendering" in raw
      ? new BorrowedOfflineContext(raw as OfflineAudioContext)
      : new BorrowedContext({
          context: raw as AudioContext,
          clockSource: "offline",
          lookAhead: 0,
        });
  const installedStateChange = raw.onstatechange;
  raw.onstatechange = previousStateChange;
  if (installedStateChange)
    raw.addEventListener("statechange", installedStateChange);
  if (destination) {
    context.destination.disconnect();
    context.destination.connect(destination);
  }
  return context;
}

const analysisSinks = new WeakMap<
  BaseAudioContext,
  { node: AudioNode; refs: number; closed: boolean; close(): void }
>();
function borrowAnalysisSink(raw: BaseAudioContext) {
  let shared = analysisSinks.get(raw);
  if (!shared || shared.closed) {
    const node = raw.createGain();
    node.gain.value = 0;
    try {
      node.connect(raw.destination);
    } catch (error) {
      node.disconnect();
      throw error;
    }
    const contextClosed = () => {
      if (raw.state === "closed") record.close();
    };
    const record = {
      node,
      refs: 0,
      closed: false,
      close() {
        if (record.closed) return;
        record.closed = true;
        raw.removeEventListener("statechange", contextClosed);
        node.disconnect();
        if (analysisSinks.get(raw) === record) analysisSinks.delete(raw);
      },
    };
    raw.addEventListener("statechange", contextClosed);
    analysisSinks.set(raw, record);
    shared = record;
  }
  shared.refs++;
  const record = shared;
  let released = false;
  return {
    node: record.node,
    release() {
      if (released) return;
      released = true;
      if (!record.closed && --record.refs === 0) record.close();
    },
  };
}

/** Full public Tone API, scoped to one borrowed context; no mutable global singleton is exposed. */
export type HostTone = Omit<typeof ToneType, "setContext" | "Offline"> & {
  setContext(context: ToneType.BaseContext): never;
  Offline(
    callback: (
      context: ToneType.BaseContext,
      Tone: HostTone,
    ) => void | Promise<void>,
    duration: number,
    channels?: number,
    sampleRate?: number,
  ): Promise<ToneType.ToneAudioBuffer>;
};
export function createToneFacade(
  context: ToneType.BaseContext,
  owned?: Set<{ dispose(): unknown }>,
): HostTone {
  const Tone = toneClasses();
  const facade: Record<string, unknown> = { ...Tone };
  // A prototype defaultContext binds all constructor overloads, including positional Part/Sequence/Loop.
  // Nested Tone objects receive this context through the official constructors themselves.
  for (const [name, value] of Object.entries(Tone)) {
    if (
      typeof value !== "function" ||
      !value.prototype ||
      typeof value.prototype.dispose !== "function"
    )
      continue;
    const Constructor = value as unknown as new (...args: unknown[]) => {
      dispose(): unknown;
    };
    class Bound extends Constructor {
      constructor(...args: unknown[]) {
        super(...args);
        if (
          ["Analyser", "Meter", "DCMeter", "FFT", "Waveform"].includes(name)
        ) {
          const node = this as unknown as ToneType.ToneAudioNode & {
            _analysers?: AnalyserNode[];
            _analyser?: { _analysers: AnalyserNode[] };
          };
          const analysers = node._analysers ?? node._analyser?._analysers;
          if (!analysers?.length)
            throw Error(`Tone ${version} ${name} analysis internals changed`);
          const sink = borrowAnalysisSink(node.context.rawContext);
          try {
            // Tone 15's public output bypasses its split/analysis branch. Drive
            // each native analyser silently so inputs without speakers or a
            // recorder still update, retaining official analysis semantics.
            for (const analyser of analysers) Tone.connect(analyser, sink.node);
            const dispose = this.dispose.bind(this);
            this.dispose = () => {
              for (const analyser of analysers) {
                try {
                  Tone.disconnect(analyser, sink.node);
                } catch {}
              }
              sink.release();
              return dispose();
            };
          } catch (error) {
            for (const analyser of analysers) {
              try {
                Tone.disconnect(analyser, sink.node);
              } catch {}
            }
            sink.release();
            try {
              this.dispose();
            } catch {}
            throw error;
          }
        }
        owned?.add(this);
      }
    }
    Object.defineProperty(Bound.prototype, "defaultContext", {
      value: context,
    });
    facade[name] = Bound;
  }
  class HostUserMedia extends Tone.UserMedia {
    private hostInput?: LiveAudioInputHandle;
    private opening?: AbortController;
    private inputRevision = 0;
    constructor(...args: ConstructorParameters<typeof Tone.UserMedia>) {
      super(...args);
      owned?.add(this);
    }
    override async open(labelOrId?: string | number): Promise<this> {
      this.close();
      const revision = ++this.inputRevision;
      const controller = (this.opening = new AbortController());
      const input = await createLiveAudioInput(this.context.rawContext, {
        device: labelOrId,
        signal: controller.signal,
      });
      if (controller.signal.aborted || revision !== this.inputRevision) {
        input.close();
        throw new DOMException("Audio input cancelled", "AbortError");
      }
      this.hostInput = input;
      Tone.connect(input.node, this.output);
      return this;
    }
    override close(): this {
      this.inputRevision++;
      this.opening?.abort(
        new DOMException("Audio input cancelled", "AbortError"),
      );
      this.opening = undefined;
      this.hostInput?.close();
      this.hostInput = undefined;
      return super.close();
    }
    override get state(): "started" | "stopped" {
      return this.hostInput?.state ?? "stopped";
    }
    override get deviceId(): string | undefined {
      return this.hostInput?.device.deviceId;
    }
    override get groupId(): string | undefined {
      return this.hostInput?.device.groupId;
    }
    override get label(): string | undefined {
      return this.hostInput?.device.label;
    }
    static override get supported(): boolean {
      return !context.isOffline && liveAudioInputSupported();
    }
    static override enumerateDevices(): Promise<MediaDeviceInfo[]> {
      if (context.isOffline)
        return Promise.reject(
          new DOMException(
            "Live input requires a realtime context; record it as a project audio asset first",
            "NotSupportedError",
          ),
        );
      return enumerateLiveAudioInputs();
    }
  }
  Object.defineProperty(HostUserMedia.prototype, "defaultContext", {
    value: context,
  });
  facade.UserMedia = HostUserMedia;
  facade.Context = new Proxy(Tone.Context, {
    construct(_constructor, args) {
      const requested = args[0] as
        BaseAudioContext | { context?: BaseAudioContext } | undefined;
      const raw =
        requested && "createBuffer" in requested
          ? requested
          : requested?.context;
      if (raw && raw !== context.rawContext)
        throw Error(
          "A scoped Tone.Context cannot replace FRAME's host context",
        );
      const child = createToneContext(
        context.rawContext,
        context.destination,
      ) as ToneType.Context;
      const parentClock = context as unknown as {
        on(event: string, callback: () => void): void;
        off(event: string, callback: () => void): void;
      };
      const childClock = child as unknown as {
        _currentTime: number;
        emit(event: string): void;
      };
      const tick = () => {
        child.lookAhead = context.lookAhead;
        if (child.isOffline) childClock._currentTime = context.immediate();
        childClock.emit("tick");
      };
      parentClock.on("tick", tick);
      let detached = false;
      const detach = () => {
        if (!detached) {
          detached = true;
          parentClock.off("tick", tick);
        }
      };
      const dispose = child.dispose.bind(child),
        close = child.close.bind(child);
      child.dispose = () => {
        detach();
        return dispose();
      };
      child.close = async () => {
        detach();
        await close();
      };
      owned?.add(child);
      return child;
    },
  });
  for (const name of [
    "Time",
    "Frequency",
    "Midi",
    "Ticks",
    "TransportTime",
  ] as const) {
    const Constructor = Tone[
      (name + "Class") as keyof typeof Tone
    ] as unknown as new (
      context: ToneType.BaseContext,
      ...args: unknown[]
    ) => unknown;
    facade[name] = (...args: unknown[]) => new Constructor(context, ...args);
  }
  Object.assign(facade, {
    context,
    Transport: context.transport,
    Destination: context.destination,
    Master: context.destination,
    Draw: context.draw,
    Listener: context.listener,
    getContext: () => context,
    getTransport: () => context.transport,
    getDestination: () => context.destination,
    getDraw: () => context.draw,
    getListener: () => context.listener,
    now: () => context.now(),
    immediate: () => context.immediate(),
    start: async () => {},
    loaded: () => Tone.ToneAudioBuffer.loaded(),
    setContext: () => {
      throw Error(
        "FRAME owns the context; create a scoped Tone facade instead of replacing it",
      );
    },
    Buffer: facade.ToneAudioBuffer,
    Buffers: facade.ToneAudioBuffers,
    BufferSource: facade.ToneBufferSource,
    Offline: async (
      callback: (
        context: ToneType.BaseContext,
        Tone: HostTone,
      ) => void | Promise<void>,
      duration: number,
      channels = 2,
      sampleRate = context.sampleRate,
    ) => {
      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration * sampleRate * channels * 4 > 128 * 1024 * 1024
      )
        throw Error(
          "Tone.Offline requires a finite duration within the 128MiB PCM budget",
        );
      const raw = new OfflineAudioContext(
          channels,
          Math.ceil(duration * sampleRate),
          sampleRate,
        ),
        scoped = createToneContext(raw),
        nodes = new Set<{ dispose(): unknown }>();
      try {
        await callback(scoped, createToneFacade(scoped, nodes));
        await renderToneClock(scoped);
        return new Tone.ToneAudioBuffer(await raw.startRendering());
      } finally {
        for (const node of [...nodes].reverse()) node.dispose();
        scoped.dispose();
      }
    },
  });
  // Official metadata exports do not initialize Tone's index/global context.
  facade.version = version;
  facade.supported = supported;
  return facade as HostTone;
}
/** Flush offline Transport/Part/Sequence/Loop events using Tone's exact sample-block clock. */
export async function renderToneClock(
  context: ToneType.BaseContext,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await (
    context as unknown as { workletsAreReady(): Promise<void> }
  ).workletsAreReady();
  if (!context.isOffline) return;
  const clock = context as unknown as {
    _currentTime: number;
    _duration: number;
    emit(event: string): void;
  };
  const step = 128 / context.sampleRate,
    yieldEvery = Math.max(1, Math.floor(context.sampleRate / 512));
  let index = 0;
  while (clock._currentTime <= clock._duration) {
    signal?.throwIfAborted();
    clock.emit("tick");
    clock._currentTime += step;
    if (++index % yieldEvery === 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
/** A bounded scheduling pump reads the host AudioContext; it never advances its own time. */
export function driveToneClock(
  context: ToneType.BaseContext,
  onError?: (error: Error) => void,
): () => void {
  if (context.isOffline) return () => {};
  context.lookAhead = 0.1;
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () =>
    (context as unknown as { emit(event: string): void }).emit("tick");
  tick();
  timer = setInterval(() => {
    try {
      tick();
    } catch (error) {
      clearInterval(timer);
      onError?.(error instanceof Error ? error : Error(String(error)));
    }
  }, 25);
  return () => clearInterval(timer);
}
export function toneClasses() {
  if (!classes) throw Error("Tone has not been prepared");
  return classes;
}
export type ToneEffectName = (typeof toneEffectNames)[number];
const contexts = new WeakMap<
  BaseAudioContext,
  { context: ToneType.BaseContext; users: number }
>();
/** Any official effect, with context/routing fixed by the host. */
export function createToneEffect(
  raw: BaseAudioContext,
  effect: ToneEffectName,
  options: Record<string, unknown> = {},
) {
  if (!toneEffectNames.includes(effect))
    throw Error("Unknown Tone effect: " + effect);
  if ("context" in options || "onload" in options || "onerror" in options)
    throw Error("Tone effect context/callbacks belong to the host");
  let session = contexts.get(raw);
  if (!session) {
    session = { context: createToneContext(raw), users: 0 };
    contexts.set(raw, session);
  }
  const Tone = toneClasses();
  type Effect = ToneType.ToneAudioNode & {
    ready?: Promise<unknown>;
    start?(at: number): unknown;
    set(options: Record<string, unknown>): unknown;
  };
  const seed = Number(options.seed ?? 1);
  class StableReverb extends Tone.Reverb {
    // A document effect must have the same impulse at every offline cut/seek.
    // Raw Tone.Reverb remains available to custom authoring code.
    generate(): Promise<this> {
      const decay = Number(this.decay),
        preDelay = Number(this.preDelay),
        sampleRate = this.context.sampleRate;
      const buffer = this.context.createBuffer(
        2,
        Math.max(1, Math.ceil((decay + preDelay) * sampleRate)),
        sampleRate,
      );
      for (let c = 0; c < 2; c++) {
        let state = ((seed || 1) + c * 7919) | 0;
        const samples = buffer.getChannelData(c);
        for (
          let i = Math.ceil(preDelay * sampleRate);
          i < samples.length;
          i++
        ) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          samples[i] =
            ((state >>> 0) / 2147483648 - 1) *
            Math.exp((-6.907755 * (i / sampleRate - preDelay)) / decay);
        }
      }
      (this as unknown as { _convolver: ConvolverNode })._convolver.buffer =
        buffer;
      this.ready = Promise.resolve();
      return Promise.resolve(this);
    }
  }
  const Constructor =
    effect === "Reverb"
      ? StableReverb
      : (
          Tone as unknown as Record<
            string,
            new (options: Record<string, unknown>) => Effect
          >
        )[effect];
  let node: Effect;
  try {
    node = new Constructor({ ...options, context: session.context });
  } catch (e) {
    if (!session.users) {
      session.context.dispose();
      contexts.delete(raw);
    }
    throw e;
  }
  session.users++;
  let disposed = false;
  return {
    node,
    ready: Promise.resolve(node.ready).then(() =>
      (
        session!.context as unknown as { workletsAreReady(): Promise<void> }
      ).workletsAreReady(),
    ),
    connect(
      input: AudioNode,
      output: AudioNode,
      when: number,
      from = 0,
      rate = 1,
    ) {
      // Oscillators in each offline effect graph must reconstruct the source position,
      // including LFOs started inside constructors rather than by effect.start().
      const internal = node as unknown as {
        frequency?: { value: number };
        _frequency?: { value: number };
        _sine?: { setPeriodicWave(wave: PeriodicWave): void };
        _cosine?: { phase: number };
      };
      const frequency = internal.frequency?.value ?? internal._frequency?.value;
      const age = from - (node.start ? 0 : (when - raw.currentTime) * rate);
      for (const value of Object.values(node))
        if (value instanceof Tone.LFO) {
          const hz = Number(frequency ?? value.frequency.value);
          value.phase -= ((age * hz) % 1) * 360;
          // Tone's phase setter writes its stopped DC signal even after the LFO has started.
          // Restore active silence on that additive signal or filter/delay modulation clips.
          if (value.state === "started")
            (
              value as unknown as { _stoppedSignal: ToneType.Signal }
            )._stoppedSignal.setValueAtTime(0, raw.currentTime);
        }
      if (frequency !== undefined) {
        const control = internal.frequency ?? internal._frequency;
        if (control) control.value = frequency * rate;
      } else
        for (const value of Object.values(node))
          if (value instanceof Tone.LFO)
            value.frequency.value = Number(value.frequency.value) * rate;
      if (
        effect === "FrequencyShifter" &&
        internal._sine &&
        internal._cosine &&
        frequency !== undefined
      ) {
        const phase = age * frequency * Math.PI * 2;
        internal._sine.setPeriodicWave(
          raw.createPeriodicWave(
            new Float32Array([0, Math.sin(phase)]),
            new Float32Array([0, Math.cos(phase)]),
          ),
        );
        internal._cosine.phase -= ((age * frequency) % 1) * 360;
      }
      Tone.connect(input, node);
      node.connect(output);
      node.start?.(when);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        node.dispose();
      } finally {
        if (--session!.users === 0) {
          session!.context.dispose();
          contexts.delete(raw);
        }
      }
    },
  };
}
