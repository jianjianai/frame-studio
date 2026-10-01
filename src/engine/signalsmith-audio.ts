import {
  renderSignalsmithPcm,
  scheduleCanonicalPcm,
  SignalsmithPcmCache,
  signalsmithPadding,
} from "./signalsmith-pcm";
import type { GeneratedAudioModule, GeneratedAudioOptions } from "./types";

/** Official Signalsmith 1.3 API, expressed in host AudioContext seconds. */
export interface StretchConfiguration {
  preset?: "default" | "cheaper";
  blockMs?: number | null;
  intervalMs?: number;
  splitComputation?: boolean;
}
export interface StretchSchedule {
  output?: number;
  /** Compatibility with the official implementation's timeline replacement key. */
  outputTime?: number;
  active?: boolean;
  input?: number;
  rate?: number;
  semitones?: number;
  tonalityHz?: number;
  formantSemitones?: number;
  formantCompensation?: boolean;
  formantBaseHz?: number;
  loopStart?: number;
  loopEnd?: number;
}
export interface SignalsmithNode extends AudioWorkletNode {
  inputTime: number;
  schedule(
    change: StretchSchedule,
    adjustPrevious?: boolean,
  ): Promise<StretchSchedule>;
  start(
    when?: number | StretchSchedule,
    offset?: number,
    duration?: number,
    rate?: number,
    semitones?: number,
  ): Promise<StretchSchedule>;
  stop(when?: number): Promise<StretchSchedule>;
  addBuffers(
    channels: Float32Array[],
    transfer?: Transferable[],
  ): Promise<number>;
  dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>;
  latency(): Promise<number>;
  configure(configuration: StretchConfiguration): Promise<void>;
  setUpdateInterval(
    seconds: number,
    callback?: (inputTime: number) => void,
  ): Promise<void>;
  /** Stop processing and release the message port; never closes the host context. */
  dispose(): void;
}
type Factory = ((
  context: BaseAudioContext,
  options?: AudioWorkletNodeOptions,
) => Promise<SignalsmithNode>) & { moduleUrl?: string };
let factory: Factory | undefined;
let preparing: Promise<void> | undefined;
async function loadSignalsmith(): Promise<void> {
  // The official module embeds its WASM. No CDN request or third-party runtime URL.
  if (factory) return;
  const [official, raw] = await Promise.all([
    import("signalsmith-stretch"),
    import("signalsmith-stretch?raw"),
  ]);
  let worklet = raw.default;
  // 1.3.2 accidentally uses one variable both for a scheduled event and current
  // playback time. This can discard the start when a future stop is queued.
  const fixes: [string, string][] = [
    [
      "audioSamples += count;\n\t\t\t\t\t\tblockSamples += count;",
      "inputSamples += count; audioSamples = bufferEnd; blockSamples += count;",
    ],
    [
      "let outputTime = ('outputTime' in objIn) ? objIn.outputTime : currentTime;",
      "let outputTime = objIn.output ?? objIn.outputTime ?? currentTime;",
    ],
    [
      "this.timeMap[1].output <= outputTime",
      "this.timeMap[1].output <= currentTime",
    ],
    [
      "currentMapSegment.input + (outputTime - currentMapSegment.output)*rate",
      "currentMapSegment.input + (currentTime - currentMapSegment.output)*rate",
    ],
    ["\n\t\t\t\tconfigure();", "\n\t\t\t\tthis.configure();"],
    [
      "currentMapSegment.input -= loopLength;\n\t\t\t\t\tinputTime -= loopLength;",
      "let count = Math.floor((inputTime - currentMapSegment.loopStart)/loopLength); currentMapSegment.input -= loopLength*count; inputTime -= loopLength*count;",
    ],
  ];
  for (const [before, after] of fixes) {
    if (!worklet.includes(before))
      throw Error(
        "Signalsmith release changed; review the versioned worklet compatibility fixes",
      );
    worklet = worklet.replace(before, after);
  }
  const loaded = official.default as Factory;
  loaded.moduleUrl = URL.createObjectURL(
    new Blob([worklet], { type: "text/javascript" }),
  );
  factory = loaded;
}
export async function prepareSignalsmith(): Promise<void> {
  preparing ??= loadSignalsmith().catch((e) => {
    preparing = undefined;
    throw e;
  });
  return preparing;
}
function checked(change: StretchSchedule): StretchSchedule {
  for (const [key, value] of Object.entries(change))
    if (typeof value === "number" && !Number.isFinite(value))
      throw Error("Invalid stretch " + key);
  if (change.rate !== undefined && change.rate <= 0)
    throw Error("Stretch rate must be positive");
  return { ...change };
}
function cancelled<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
  });
}
/** All official buffer/live-input methods remain reachable; adds ownership and cancellation. */
export async function createSignalsmithNode(
  context: BaseAudioContext,
  options: AudioWorkletNodeOptions = {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  },
  signal?: AbortSignal,
): Promise<SignalsmithNode> {
  signal?.throwIfAborted();
  if (!context.audioWorklet)
    throw Error(
      "Signalsmith requires AudioWorklet in a secure browser context",
    );
  await prepareSignalsmith();
  let abandoned = false;
  const pending = factory!(context, options);
  void pending
    .then((node) => {
      if (abandoned) {
        node.disconnect();
        node.port.close();
      }
    })
    .catch(() => {});
  let node: SignalsmithNode,
    initializationTimer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<SignalsmithNode>((resolve, reject) => {
    initializationTimer = setTimeout(
      () => reject(Error("Signalsmith AudioWorklet initialization timed out")),
      15000,
    );
    pending.then(resolve, reject);
  });
  try {
    node = await cancelled(bounded, signal);
  } catch (e) {
    abandoned = true;
    throw e;
  } finally {
    clearTimeout(initializationTimer);
  }
  const rawSchedule = node.schedule.bind(node);
  let disposed = false;
  const pendingCalls = new Set<(error: Error) => void>();
  const rpc = <T>(work: Promise<T>): Promise<T> => {
    if (disposed) return Promise.reject(Error("Signalsmith node disposed"));
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        clearTimeout(timer);
        pendingCalls.delete(fail);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(Error("Signalsmith processor did not respond")),
        15000,
      );
      pendingCalls.add(fail);
      work.then((value) => {
        clearTimeout(timer);
        pendingCalls.delete(fail);
        resolve(value);
      }, fail);
    });
  };
  const rawConfigure = node.configure.bind(node),
    rawAdd = node.addBuffers.bind(node),
    rawDrop = node.dropBuffers.bind(node),
    rawLatency = node.latency.bind(node),
    rawUpdate = node.setUpdateInterval.bind(node);
  node.configure = (config) => {
    if (
      config.blockMs !== undefined &&
      config.blockMs !== null &&
      (!Number.isFinite(config.blockMs) || config.blockMs < 0)
    )
      return Promise.reject(Error("Invalid stretch block length"));
    if (
      config.intervalMs !== undefined &&
      (!Number.isFinite(config.intervalMs) ||
        config.intervalMs < 0 ||
        (!!config.blockMs && config.intervalMs > config.blockMs))
    )
      return Promise.reject(Error("Invalid stretch interval"));
    return rpc(rawConfigure(config));
  };
  node.addBuffers = (channels, transfer) => {
    if (
      !channels.length ||
      !channels[0].length ||
      channels.some(
        (c) => !(c instanceof Float32Array) || c.length !== channels[0].length,
      )
    )
      return Promise.reject(
        Error("Stretch buffers must have equal nonzero channel lengths"),
      );
    return rpc(rawAdd(channels, ...(transfer ? [transfer] : [])));
  };
  node.dropBuffers = (toSeconds) => rpc(rawDrop(toSeconds));
  node.latency = () => rpc(rawLatency());
  node.setUpdateInterval = (seconds, callback) => {
    if (!Number.isFinite(seconds) || seconds <= 0)
      return Promise.reject(Error("Stretch update interval must be positive"));
    return rpc(rawUpdate(seconds, callback));
  };
  node.schedule = (change, adjustPrevious) => {
    if (disposed) return Promise.reject(Error("Signalsmith node disposed"));
    const at = change.output ?? change.outputTime ?? context.currentTime;
    // Worklet compatibility fixes keep future changes queued in output-time order.
    return rpc(
      rawSchedule(
        checked({ ...change, output: at, outputTime: at }),
        adjustPrevious,
      ),
    );
  };
  node.start = async (when, offset = 0, duration, rate = 1, semitones = 0) => {
    const change =
      typeof when === "object"
        ? { active: true, ...when }
        : {
            active: true,
            output: when ?? context.currentTime,
            input: offset,
            rate,
            semitones,
          };
    const result = await node.schedule(change);
    if (duration !== undefined)
      await node.stop((change.output ?? context.currentTime) + duration);
    return result;
  };
  node.stop = (when = context.currentTime) =>
    node.schedule({ active: false, output: when });
  node.dispose = () => {
    if (disposed) return;
    void node.stop().catch(() => {});
    disposed = true;
    for (const fail of [...pendingCalls])
      fail(new DOMException("Signalsmith disposed", "AbortError"));
    node.onprocessorerror = null;
    node.disconnect();
    node.port.close();
  };
  return node;
}
export interface SignalsmithAudioOptions {
  /** Decode/construct buffers once per source module. The arrays are copied before transfer. */
  buffers:
    | AudioBuffer
    | Promise<AudioBuffer>
    | (() => AudioBuffer | Promise<AudioBuffer>);
  configuration?: StretchConfiguration;
  schedule?: Omit<
    StretchSchedule,
    "output" | "outputTime" | "input" | "active" | "rate"
  >;
}
/** Source-time generator suitable for arbitrary seeks, rate changes, preview and offline export. */
export function createSignalsmithAudio(
  config: SignalsmithAudioOptions,
): GeneratedAudioModule {
  let buffer: Promise<AudioBuffer> | undefined;
  const samples = new Map<number, Promise<Float32Array[]>>(),
    cache = new SignalsmithPcmCache();
  const sessions = new Set<BaseAudioContext>();
  const load = () => {
    if (!buffer) {
      const job = Promise.resolve().then(() =>
        typeof config.buffers === "function"
          ? config.buffers()
          : config.buffers,
      );
      buffer = job;
      void job.catch(() => {
        if (buffer === job) {
          buffer = undefined;
          samples.clear();
        }
      });
    }
    return buffer;
  };
  const channels = (sampleRate: number) => {
    if (!samples.has(sampleRate))
      samples.set(
        sampleRate,
        load().then((source) =>
          Array.from({ length: source.numberOfChannels }, (_, c) =>
            source.sampleRate === sampleRate
              ? source.getChannelData(c)
              : resampleAudio(
                  source.getChannelData(c),
                  source.sampleRate,
                  sampleRate,
                ),
          ),
        ),
      );
    return samples.get(sampleRate)!;
  };
  const settings = (
    options: Pick<GeneratedAudioOptions, "rate" | "pitch" | "stretch">,
  ) => ({
    configuration: { ...config.configuration, ...options.stretch },
    schedule: { ...config.schedule, ...options.stretch },
    pitch: (config.schedule?.semitones ?? 0) + (options.pitch ?? 0),
    rate: options.rate,
  });
  const shortPcm = async (
    options: Pick<
      GeneratedAudioOptions,
      "context" | "rate" | "pitch" | "stretch"
    >,
  ) => {
    const source = await load(),
      sampleRate = options.context.sampleRate,
      parameters = settings(options);
    if (
      source.duration > 30 ||
      (source.duration / options.rate) * sampleRate * 8 > 16 * 1024 * 1024 ||
      config.schedule?.loopEnd
    )
      return undefined;
    return cache.get(
      JSON.stringify([sampleRate, parameters, "whole"]),
      Math.max(1, Math.round((source.duration / options.rate) * sampleRate)) *
        8,
      async () =>
        renderSignalsmithPcm({
          channels: await channels(sampleRate),
          sampleRate,
          offset: 0,
          duration: source.duration,
          ...parameters,
        }),
    );
  };
  return {
    async prepareAudio(context) {
      sessions.add(context);
      await Promise.all([
        prepareSignalsmith(),
        load(),
        channels(context.sampleRate),
      ]);
    },
    async prepareSegment(options) {
      await cancelled(shortPcm(options), options.signal);
    },
    createAudio(options: GeneratedAudioOptions) {
      const abort = new AbortController();
      let node: SignalsmithNode | undefined,
        sourceNode: AudioBufferSourceNode | undefined,
        canonical: { dispose(): void } | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      const gate = options.context.createGain();
      gate.gain.value = 0;
      gate.gain.setValueAtTime(1, options.when);
      gate.gain.setValueAtTime(
        0,
        options.when + options.duration / options.rate,
      );
      gate.connect(options.destination);
      const dispose = () => {
        if (abort.signal.aborted) return;
        abort.abort();
        clearInterval(timer);
        node?.dispose();
        canonical?.dispose();
        if (sourceNode) {
          try {
            sourceNode.stop();
          } catch {}
          sourceNode.disconnect();
          sourceNode.buffer = null;
        }
        gate.disconnect();
      };
      const ready = (async () => {
        const small = await cancelled(shortPcm(options), abort.signal);
        if (small) {
          abort.signal.throwIfAborted();
          sourceNode = options.context.createBufferSource();
          sourceNode.buffer = small;
          sourceNode.connect(gate);
          if (options.offset / options.rate < small.duration) {
            sourceNode.start(options.when, options.offset / options.rate);
            sourceNode.stop(options.when + options.duration / options.rate);
          }
          return;
        }
        const input = await cancelled(
            channels(options.context.sampleRate),
            abort.signal,
          ),
          parameters = settings(options),
          sampleRate = options.context.sampleRate,
          padding = signalsmithPadding(parameters.configuration, sampleRate);
        const looping =
          (config.schedule?.loopEnd ?? 0) > (config.schedule?.loopStart ?? 0);
        if ("startRendering" in options.context) {
          canonical = await scheduleCanonicalPcm({
            ...options,
            destination: gate,
            signal: abort.signal,
            ...(looping
              ? {
                  loopStart: config.schedule?.loopStart,
                  loopEnd: config.schedule?.loopEnd,
                }
              : {}),
            get: (index) => {
              const outputFrom = index * 2 - 0.01,
                from = outputFrom * options.rate;
              const base =
                Math.max(
                  0,
                  Math.floor(
                    (from - options.rate * (padding + 0.25)) * sampleRate,
                  ),
                ) / sampleRate;
              const last = Math.ceil(
                (from + 2.02 * options.rate + options.rate * padding) *
                  sampleRate,
              );
              return cache.get(
                JSON.stringify([sampleRate, parameters, "grid", index]),
                Math.round(2.02 * sampleRate) * 8,
                () =>
                  renderSignalsmithPcm({
                    channels: input.map((c) => {
                      const begin = Math.round(base * sampleRate),
                        data = new Float32Array(Math.max(1, last - begin));
                      data.set(c.subarray(begin, last));
                      return data;
                    }),
                    sampleRate,
                    offset: from - base,
                    duration: 2.02 * options.rate,
                    ...parameters,
                  }),
              );
            },
          });
          return;
        }
        const base =
          Math.max(
            0,
            Math.floor(
              (Math.min(
                options.offset,
                config.schedule?.loopStart ?? options.offset,
              ) -
                padding * options.rate) *
                sampleRate,
            ),
          ) / sampleRate;
        if (
          looping &&
          (config.schedule!.loopEnd! - base) * sampleRate * input.length * 4 >
            128 * 1024 * 1024
        )
          throw Error("Signalsmith loop input exceeds 128 MiB");
        let next = Math.floor(base * sampleRate),
          pumping = false;
        const append = async (until: number) => {
          const stop = Math.min(input[0].length, Math.ceil(until * sampleRate));
          while (next < stop) {
            const end = Math.min(stop, next + sampleRate);
            const data = input.map((c) => c.slice(next, end));
            await node!.addBuffers(
              data,
              data.map((c) => c.buffer as ArrayBuffer),
            );
            next = end;
            abort.signal.throwIfAborted();
          }
        };
        node = await createSignalsmithNode(
          options.context,
          undefined,
          abort.signal,
        );
        await node.configure(parameters.configuration);
        node.onprocessorerror = () => {
          dispose();
          options.onError?.(Error("Signalsmith processor failed"));
        };
        await append(
          looping
            ? config.schedule!.loopEnd! + padding * options.rate
            : options.offset + (4 + padding) * options.rate,
        );
        abort.signal.throwIfAborted();
        node.connect(gate);
        const preroll = Math.min(
          0.5,
          Math.max(0, options.when - options.context.currentTime),
          options.offset / options.rate,
        );
        await node.schedule({
          ...parameters.schedule,
          active: true,
          output: options.when - preroll,
          input: options.offset - base - preroll * options.rate,
          rate: options.rate,
          semitones: parameters.pitch,
          ...(looping
            ? {
                loopStart: config.schedule!.loopStart! - base,
                loopEnd: config.schedule!.loopEnd! - base,
              }
            : {}),
        });
        await node.stop(options.when + options.duration / options.rate);
        if (!looping)
          timer = setInterval(() => {
            if (pumping || abort.signal.aborted) return;
            pumping = true;
            const position =
              options.offset +
              Math.max(0, options.context.currentTime - options.when) *
                options.rate;
            void append(position + (1.5 + padding) * options.rate)
              .then(() =>
                node!.dropBuffers(
                  Math.max(
                    0,
                    position - base - (padding + 0.25) * options.rate,
                  ),
                ),
              )
              .catch((e) => {
                if (!abort.signal.aborted) {
                  dispose();
                  options.onError?.(e instanceof Error ? e : Error(String(e)));
                }
              })
              .finally(() => {
                pumping = false;
              });
          }, 100);
      })().catch((error) => {
        dispose();
        throw error;
      });
      return { ready, dispose };
    },
    disposeAudio(context) {
      sessions.delete(context);
      if (!sessions.size) {
        buffer = undefined;
        samples.clear();
        cache.clear();
      }
    },
  };
}
/** Copy/resample without detaching a cached source buffer. */
export function resampleAudio(
  data: Float32Array,
  from: number,
  to: number,
): Float32Array {
  if (from === to) return data.slice();
  const output = new Float32Array(
    Math.max(1, Math.round((data.length * to) / from)),
  );
  for (let i = 0; i < output.length; i++) {
    const at = (i * from) / to,
      index = Math.floor(at),
      fraction = at - index;
    output[i] =
      (data[index] ?? 0) * (1 - fraction) +
      (data[index + 1] ?? data[index] ?? 0) * fraction;
  }
  return output;
}
