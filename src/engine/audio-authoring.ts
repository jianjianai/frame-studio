import { assetUrl, type GeneratedAudioModule } from "./types";
import { createToneAudio } from "./audio-adapters";
import { MediaRequestQueue } from "./media-buffering";
import {
  createToneContext,
  createToneFacade,
  renderToneClock,
  prepareTone,
  type HostTone,
} from "./tone-runtime";
import type * as ToneType from "tone";
import { waitAudioReady } from "./live-audio-update";

export interface AudioNote {
  at: number;
  duration: number;
  note: number | string;
  velocity?: number;
  pan?: number;
  /** Only this sample region is played, allowing drum slices and multisamples. */
  sampleOffset?: number;
  sampleDuration?: number;
}
export function noteToMidi(note: number | string): number {
  if (typeof note === "number") {
    if (!Number.isFinite(note) || note < 0 || note > 127)
      throw Error("MIDI pitch must be 0..127");
    return note;
  }
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(note);
  if (!m) throw Error("Use MIDI pitch or scientific note, e.g. C4 or F#3");
  const pitch =
    [0, 2, 4, 5, 7, 9, 11]["CDEFGAB".indexOf(m[1].toUpperCase())] +
    (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return noteToMidi((Number(m[3]) + 1) * 12 + pitch);
}
export function semitoneRate(semitones: number): number {
  if (!Number.isFinite(semitones)) throw Error("Invalid semitones");
  return 2 ** (semitones / 12);
}
/** Includes sustaining notes crossing the left edge, expressed in source seconds. */
export function notesInSegment(
  notes: readonly AudioNote[],
  offset: number,
  duration: number,
) {
  const end = offset + duration;
  return notes.flatMap((note) => {
    if (
      ![note.at, note.duration].every(Number.isFinite) ||
      note.at < 0 ||
      note.duration <= 0
    )
      throw Error("Invalid note timing");
    if (
      note.velocity !== undefined &&
      (!Number.isFinite(note.velocity) ||
        note.velocity < 0 ||
        note.velocity > 1)
    )
      throw Error("Note velocity must be 0..1");
    const start = Math.max(offset, note.at),
      stop = Math.min(end, note.at + note.duration);
    return stop > start
      ? [
          {
            ...note,
            midi: noteToMidi(note.note),
            delay: start - offset,
            age: start - note.at,
            length: stop - start,
          },
        ]
      : [];
  });
}
export interface SamplerAudioOptions {
  samples: Record<string, string | AudioBuffer>;
  notes: readonly AudioNote[];
  attack?: number;
  release?: number;
  decay?: number;
  sustain?: number;
  loop?: { start: number; end: number };
  gain?: number;
  maxBufferBytes?: number;
}
/** Deterministic, polyphonic multisample instrument; reconstructs sample phase/envelope at arbitrary offsets. */
export function createSamplerAudio(
  config: SamplerAudioOptions,
): GeneratedAudioModule {
  const samples = Object.entries(config.samples).map(([root, source]) => ({
    root: noteToMidi(/^\d+$/.test(root) ? Number(root) : root),
    source,
  }));
  if (!samples.length) throw Error("Sampler needs at least one rooted sample");
  const budget = config.maxBufferBytes ?? 128 * 1024 * 1024;
  if (!Number.isFinite(budget) || budget <= 0)
    throw Error("Sampler requires a positive PCM budget");
  const queue = new MediaRequestQueue(2);
  let controller = new AbortController();
  let loaded: Promise<{ root: number; buffer: AudioBuffer }[]> | undefined;
  let stamp = "";
  const load = (context: BaseAudioContext) => {
    const currentStamp = JSON.stringify(
      samples.map((s) =>
        typeof s.source === "string" ? assetUrl(s.source) : s.root,
      ),
    );
    if (stamp !== currentStamp) {
      controller.abort();
      controller = new AbortController();
      loaded = undefined;
      stamp = currentStamp;
    }
    if (!loaded) {
      const signal = controller.signal;
      let bytes = 0;
      const job = Promise.all(
        samples.map((sample) =>
          queue.run(signal, async () => {
            let buffer: AudioBuffer;
            if (typeof sample.source !== "string") buffer = sample.source;
            else {
              if (!sample.source.startsWith("films/"))
                throw Error(
                  "Sampler URLs must be project assets under films/<id>/",
                );
              const response = await fetch(assetUrl(sample.source), { signal });
              if (!response.ok)
                throw Error("Sampler asset unavailable: " + sample.source);
              buffer = await context.decodeAudioData(
                await response.arrayBuffer(),
              );
            }
            signal.throwIfAborted();
            bytes += buffer.length * buffer.numberOfChannels * 4;
            if (bytes > budget)
              throw Error(
                "Sampler decoded assets exceed budget; use fewer samples or streaming Signalsmith",
              );
            return { root: sample.root, buffer };
          }),
        ),
      );
      loaded = job;
      void job.catch(() => {
        if (loaded === job) {
          loaded = undefined;
          controller.abort();
          controller = new AbortController();
        }
      });
    }
    return loaded;
  };
  const sessions = new Set<BaseAudioContext>();
  let readySamples: { root: number; buffer: AudioBuffer }[] | undefined;
  return {
    async prepareAudio(context) {
      sessions.add(context);
      readySamples = await load(context);
    },
    async prepareSegment({ context, signal }) {
      readySamples = await waitAudioReady(load(context), signal);
    },
    createAudio(options) {
      if (!readySamples)
        throw Error("Prepare sampler assets before scheduling");
      if (options.preservePitch || options.stretch)
        throw Error(
          "Use createSignalsmithAudio for independent sample time stretching",
        );
      const owned: AudioNode[] = [],
        sources: AudioBufferSourceNode[] = [];
      const attack = Math.max(0, config.attack ?? 0.005),
        release = Math.max(0, config.release ?? 0.02),
        decay = Math.max(0, config.decay ?? 0),
        sustain = Math.max(0, Math.min(1, config.sustain ?? 1));
      try {
        for (const note of notesInSegment(
          config.notes,
          options.offset,
          options.duration,
        )) {
          const sample = readySamples.reduce((best, s) =>
            Math.abs(s.root - note.midi) < Math.abs(best.root - note.midi)
              ? s
              : best,
          );
          const pitchRate = semitoneRate(
            note.midi - sample.root + (options.pitch ?? 0),
          );
          let sourceOffset = (note.sampleOffset ?? 0) + note.age * pitchRate;
          if (config.loop && sourceOffset >= config.loop.end)
            sourceOffset =
              config.loop.start +
              ((sourceOffset - config.loop.start) %
                (config.loop.end - config.loop.start));
          const sampleEnd = Math.min(
            sample.buffer.duration,
            (note.sampleOffset ?? 0) +
              (note.sampleDuration ?? sample.buffer.duration),
          );
          if (sourceOffset >= sampleEnd || note.velocity === 0) continue;
          const at = options.when + note.delay / options.rate;
          const source = options.context.createBufferSource(),
            gain = options.context.createGain(),
            pan = options.context.createStereoPanner();
          source.buffer = sample.buffer;
          if (config.loop) {
            if (!(
              config.loop.start >= 0 &&
              config.loop.end > config.loop.start &&
              config.loop.end <= sample.buffer.duration
            ))
              throw Error("Sampler loop must fit every sample");
            source.loop = true;
            source.loopStart = config.loop.start;
            source.loopEnd = config.loop.end;
          }
          source.playbackRate.value = pitchRate * options.rate;
          pan.pan.value = note.pan ?? 0;
          const level = (config.gain ?? 1) * (note.velocity ?? 0.8);
          const envelope = (age: number) => {
            const held =
              age < attack
                ? age / Math.max(attack, 1e-9)
                : age < attack + decay
                  ? 1 - ((1 - sustain) * (age - attack)) / Math.max(decay, 1e-9)
                  : sustain;
            return Math.max(
              0,
              Math.min(
                held,
                release ? (sustain * (note.duration - age)) / release : held,
              ),
            );
          };
          gain.gain.setValueAtTime(level * envelope(note.age), at);
          const boundaries = [
            attack,
            attack + decay,
            note.duration - release,
            note.age + note.length,
          ]
            .filter((t) => t > note.age && t <= note.age + note.length)
            .sort((a, b) => a - b);
          for (const time of boundaries)
            gain.gain.linearRampToValueAtTime(
              level * envelope(time),
              at + (time - note.age) / options.rate,
            );
          source.connect(gain);
          gain.connect(pan);
          pan.connect(options.destination);
          owned.push(source, gain, pan);
          sources.push(source);
          source.start(
            at,
            sourceOffset,
            config.loop
              ? note.length * pitchRate
              : Math.min(note.length * pitchRate, sampleEnd - sourceOffset),
          );
          source.stop(at + note.length / options.rate);
        }
      } catch (e) {
        sources.forEach((s) => {
          try {
            s.stop();
          } catch {}
        });
        owned.forEach((n) => n.disconnect());
        throw e;
      }
      let done = false;
      return {
        dispose() {
          if (done) return;
          done = true;
          sources.forEach((s) => {
            try {
              s.stop();
            } catch {}
            s.buffer = null;
          });
          owned.forEach((n) => n.disconnect());
        },
      };
    },
    disposeAudio(context) {
      sessions.delete(context);
      if (!sessions.size) {
        controller.abort();
        controller = new AbortController();
        loaded = undefined;
        readySamples = undefined;
      }
    },
  };
}
export interface ToneSequenceOptions {
  notes: readonly AudioNote[];
  /** One independent instrument per note; effects shared across notes belong to audio.json. */
  instrument(options: {
    Tone: HostTone;
    toneContext: ToneType.BaseContext;
  }): ToneType.ToneAudioNode & {
    triggerAttackRelease(
      note: number,
      duration: number,
      when: number,
      velocity?: number,
    ): unknown;
  };
  prepare?: Parameters<typeof createToneAudio>[1];
  tailSeconds?: number;
  maxBufferBytes?: number;
}
/** Render each distinct voice once, then slice its PCM: sustain, phase and release survive arbitrary seeks. */
export function createToneSequence(
  config: ToneSequenceOptions,
): GeneratedAudioModule {
  const tail = Math.max(0, config.tailSeconds ?? 0.5),
    budget = config.maxBufferBytes ?? 128 * 1024 * 1024;
  const notes = config.notes.map((note) => ({
    ...note,
    duration: note.duration + tail,
  }));
  const cache = new Map<
    string,
    { promise: Promise<AudioBuffer>; bytes: number; settled: boolean }
  >();
  const renderQueue = new MediaRequestQueue(2);
  let renderAbort = new AbortController();
  const sessions = new Set<BaseAudioContext>();
  let used = 0;
  const get = async (
    note: ReturnType<typeof notesInSegment>[number],
    pitch = 0,
  ): Promise<AudioBuffer> => {
    const original = note.duration - tail;
    const key = JSON.stringify([
      note.midi + pitch,
      original,
      note.velocity ?? 0.8,
    ]);
    const previous = cache.get(key);
    if (previous) {
      cache.delete(key);
      cache.set(key, previous);
      return previous.promise;
    }
    const frames = Math.max(1, Math.ceil(note.duration * 48000)),
      bytes = frames * 8;
    if (bytes > budget)
      throw Error(
        "One Tone voice exceeds PCM budget; shorten the note or use a custom streaming generator",
      );
    while (used + bytes > budget && cache.size) {
      const candidate = [...cache].find(([, entry]) => entry.settled);
      if (!candidate)
        throw Error(
          "Concurrent Tone voices exceed PCM budget; shorten notes or reduce polyphony",
        );
      const [oldKey, old] = candidate;
      cache.delete(oldKey);
      used -= old.bytes;
    }
    const promise = renderQueue.run(renderAbort.signal, async () => {
      await prepareTone();
      const raw = new OfflineAudioContext(2, frames, 48000),
        toneContext = createToneContext(raw),
        owned = new Set<{ dispose(): unknown }>(),
        Tone = createToneFacade(toneContext, owned);
      let instrument: ReturnType<ToneSequenceOptions["instrument"]> | undefined;
      try {
        await config.prepare?.({ Tone, toneContext, context: raw });
        instrument = config.instrument({ Tone, toneContext });
        instrument.connect(raw.destination);
        instrument.triggerAttackRelease(
          440 * semitoneRate(note.midi + pitch - 69),
          original,
          0,
          note.velocity ?? 0.8,
        );
        await renderToneClock(toneContext, renderAbort.signal);
        return await raw.startRendering();
      } finally {
        instrument?.dispose();
        for (const node of [...owned].reverse()) {
          try {
            node.dispose();
          } catch {}
        }
        toneContext.dispose();
      }
    });
    const entry = { promise, bytes, settled: false };
    cache.set(key, entry);
    used += bytes;
    void promise
      .finally(() => {
        entry.settled = true;
      })
      .catch(() => {});
    void promise.catch(() => {
      if (cache.get(key)?.promise === promise) {
        cache.delete(key);
        used -= bytes;
      }
    });
    return promise;
  };
  return {
    async prepareAudio(context) {
      sessions.add(context);
      await prepareTone();
    },
    async prepareSegment({ offset, duration, pitch, signal }) {
      await waitAudioReady(
        Promise.all(
          notesInSegment(notes, offset, duration).map((note) =>
            get(note, pitch),
          ),
        ),
        signal,
      );
    },
    createAudio(options) {
      if (options.preservePitch || options.stretch)
        throw Error(
          "Use Signalsmith to stretch rendered Tone voices independently",
        );
      const abort = new AbortController(),
        nodes = new Set<AudioBufferSourceNode>(),
        gains = new Set<StereoPannerNode>();
      const offline = "startRendering" in options.context;
      let timer: ReturnType<typeof setInterval> | undefined,
        cursor = options.offset,
        pumping = false;
      const end = options.offset + options.duration;
      const schedule = async (until: number) => {
        for (const note of notesInSegment(notes, cursor, until - cursor)) {
          const buffer = await get(note, options.pitch);
          abort.signal.throwIfAborted();
          const source = options.context.createBufferSource(),
            pan = options.context.createStereoPanner();
          source.buffer = buffer;
          source.playbackRate.value = options.rate;
          pan.pan.value = note.pan ?? 0;
          source.connect(pan);
          pan.connect(options.destination);
          nodes.add(source);
          gains.add(pan);
          source.onended = () => {
            nodes.delete(source);
            gains.delete(pan);
            source.disconnect();
            pan.disconnect();
            source.buffer = null;
          };
          source.start(
            options.when +
              (cursor - options.offset + note.delay) / options.rate,
            note.age,
            note.length,
          );
        }
        cursor = until;
      };
      const dispose = () => {
        if (abort.signal.aborted) return;
        abort.abort();
        clearInterval(timer);
        for (const source of nodes) {
          source.onended = null;
          try {
            source.stop();
          } catch {}
          source.disconnect();
          source.buffer = null;
        }
        for (const gain of gains) gain.disconnect();
        nodes.clear();
        gains.clear();
      };
      const pump = async () => {
        if (pumping || abort.signal.aborted || cursor >= end) return;
        pumping = true;
        try {
          await schedule(
            Math.min(
              end,
              options.offset +
                (Math.max(0, options.context.currentTime - options.when) +
                  1.5) *
                  options.rate,
            ),
          );
        } catch (e) {
          if (!abort.signal.aborted) {
            dispose();
            options.onError?.(e instanceof Error ? e : Error(String(e)));
          }
        } finally {
          pumping = false;
        }
      };
      const ready = schedule(
        offline ? end : Math.min(end, options.offset + 4 * options.rate),
      )
        .then(() => {
          if (!offline && cursor < end && !abort.signal.aborted)
            timer = setInterval(() => void pump(), 100);
        })
        .catch((e) => {
          dispose();
          throw e;
        });
      return { ready, dispose };
    },
    disposeAudio(context) {
      sessions.delete(context);
      if (!sessions.size) {
        renderAbort.abort();
        renderAbort = new AbortController();
        cache.clear();
        used = 0;
      }
    },
  };
}

export interface ToneTimelineOptions {
  /** Explicit finite source duration, including desired release/effect tails. */
  duration: number;
  sampleRate?: number;
  channels?: 1 | 2;
  maxBufferBytes?: number;
  /** Full bound Tone API; Part/Sequence/Loop use source seconds starting at zero. */
  build(options: {
    Tone: HostTone;
    toneContext: ToneType.BaseContext;
    context: OfflineAudioContext;
    signal: AbortSignal;
  }):
    | void
    | { ready?: Promise<void>; dispose?(): void }
    | Promise<void | { ready?: Promise<void>; dispose?(): void }>;
}
export interface ToneTimelineModule extends GeneratedAudioModule {
  /** Reusable PCM also usable as createSignalsmithAudio({ buffers: timeline.renderBuffer() }). */
  renderBuffer(signal?: AbortSignal): Promise<AudioBuffer>;
}
/** Explicit finite score preparation: all official Tone event APIs, with exact seek/export PCM reconstruction. */
export function createToneTimeline(
  config: ToneTimelineOptions,
): ToneTimelineModule {
  const sampleRate = config.sampleRate ?? 48000,
    channels = config.channels ?? 2,
    budget = config.maxBufferBytes ?? 128 * 1024 * 1024;
  if (
    !Number.isFinite(config.duration) ||
    config.duration <= 0 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 96000 ||
    ![1, 2].includes(channels) ||
    !Number.isFinite(budget) ||
    budget <= 0
  )
    throw Error(
      "Tone timeline requires a finite positive duration, 8..96kHz sample rate and PCM budget",
    );
  const frames = Math.ceil(config.duration * sampleRate),
    bytes = frames * channels * 4;
  if (bytes > budget)
    throw Error(
      "Tone timeline exceeds PCM budget; shorten it or use createToneSequence for a long streaming score",
    );
  const queue = new MediaRequestQueue(2),
    sessions = new Set<BaseAudioContext>();
  let pending: Promise<AudioBuffer> | undefined,
    controller = new AbortController();
  const renderBuffer = (signal?: AbortSignal) => {
    if (!pending) {
      const jobSignal = controller.signal;
      const job = queue.run(jobSignal, async () => {
        await prepareTone();
        jobSignal.throwIfAborted();
        const raw = new OfflineAudioContext(channels, frames, sampleRate),
          toneContext = createToneContext(raw),
          owned = new Set<{ dispose(): unknown }>();
        let result: void | { ready?: Promise<void>; dispose?(): void },
          disposed = false;
        const cleanup = () => {
          if (disposed) return;
          disposed = true;
          try {
            result?.dispose?.();
          } finally {
            for (const node of [...owned].reverse()) {
              try {
                node.dispose();
              } catch {}
            }
            owned.clear();
            toneContext.dispose();
          }
        };
        jobSignal.addEventListener("abort", cleanup, { once: true });
        try {
          result = await waitAudioReady(
            Promise.resolve(
              config.build({
                Tone: createToneFacade(toneContext, owned),
                toneContext,
                context: raw,
                signal: jobSignal,
              }),
            ),
            jobSignal,
          );
          await waitAudioReady(Promise.resolve(result?.ready), jobSignal);
          jobSignal.throwIfAborted();
          // A score may schedule starts/stops itself. This is the source origin if it does not.
          let hasStart = false;
          (
            toneContext.transport as unknown as {
              _clock: {
                _state: {
                  forEach(callback: (event: { state: string }) => void): void;
                };
              };
            }
          )._clock._state.forEach((event) => {
            if (event.state === "started") hasStart = true;
          });
          if (!hasStart) toneContext.transport.start(0);
          await renderToneClock(toneContext, jobSignal);
          const pcm = await raw.startRendering();
          jobSignal.throwIfAborted();
          return pcm;
        } finally {
          jobSignal.removeEventListener("abort", cleanup);
          cleanup();
        }
      });
      pending = job;
      void job.catch(() => {
        if (pending === job) pending = undefined;
      });
    }
    return waitAudioReady(pending, signal);
  };
  return {
    renderBuffer,
    async prepareAudio(context) {
      sessions.add(context);
      await prepareTone();
    },
    async prepareSegment({ signal }) {
      await renderBuffer(signal);
    },
    createAudio(options) {
      if (
        (options.pitch ?? 0) !== 0 ||
        options.preservePitch ||
        options.stretch
      )
        throw Error(
          "Wrap timeline.renderBuffer() with createSignalsmithAudio for independent timeline pitch/time/formant changes",
        );
      const abort = new AbortController();
      let source: AudioBufferSourceNode | undefined;
      const dispose = () => {
        if (abort.signal.aborted) return;
        abort.abort();
        if (source) {
          source.onended = null;
          try {
            source.stop();
          } catch {}
          source.disconnect();
          source.buffer = null;
        }
      };
      const ready = renderBuffer(abort.signal)
        .then((buffer) => {
          abort.signal.throwIfAborted();
          if (options.offset >= buffer.duration) return;
          source = options.context.createBufferSource();
          source.buffer = buffer;
          source.playbackRate.value = options.rate;
          source.connect(options.destination);
          source.onended = () => {
            source?.disconnect();
            if (source) source.buffer = null;
          };
          source.start(
            Math.max(0, options.when),
            Math.max(0, options.offset),
            Math.min(options.duration, buffer.duration - options.offset),
          );
        })
        .catch((e) => {
          dispose();
          throw e;
        });
      return { ready, dispose };
    },
    disposeAudio(context) {
      sessions.delete(context);
      if (!sessions.size) {
        controller.abort();
        controller = new AbortController();
        pending = undefined;
      }
    },
  };
}
