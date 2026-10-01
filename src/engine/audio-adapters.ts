import type { GeneratedAudioModule, GeneratedAudioOptions } from "./types";
import type * as ToneType from "tone";
import {
  createToneContext,
  createToneFacade,
  driveToneClock,
  renderToneClock,
  prepareTone,
  type HostTone,
} from "./tone-runtime";
export {
  createToneFacade,
  createToneContext,
  prepareTone,
} from "./tone-runtime";
export type { HostTone } from "./tone-runtime";
export {
  createSignalsmithNode,
  createSignalsmithAudio,
  prepareSignalsmith,
} from "./signalsmith-audio";
export {
  createSamplerAudio,
  createToneSequence,
  createToneTimeline,
  noteToMidi,
  semitoneRate,
  notesInSegment,
} from "./audio-authoring";
/** Project-local registry: independent instances, no process-wide transport or shared mutable context. */
export function createAudioRack(
  generators: Record<string, GeneratedAudioModule>,
): GeneratedAudioModule {
  for (const [id, mod] of Object.entries(generators))
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id) ||
      typeof mod.createAudio !== "function"
    )
      throw Error("Invalid audio module: " + id);
  return {
    generators,
    createAudio() {
      throw Error("Select an audio.json source module");
    },
  };
}
export function createWebAudioGenerator(
  create: (options: GeneratedAudioOptions) => { dispose(): void },
  prepare?: GeneratedAudioModule["prepareSegment"],
): GeneratedAudioModule {
  return { createAudio: create, prepareSegment: prepare };
}
export function createToneAudio(
  build: (
    options: GeneratedAudioOptions & {
      Tone: HostTone;
      toneContext: ToneType.BaseContext;
    },
  ) => { dispose(): void; ready?: Promise<unknown> },
  prepare?: (options: {
    Tone: HostTone;
    toneContext: ToneType.BaseContext;
    context: BaseAudioContext;
    signal?: AbortSignal;
  }) => void | Promise<void>,
): GeneratedAudioModule {
  const contexts = new Map<BaseAudioContext, ToneType.BaseContext>();
  const preparations = new Map<BaseAudioContext, Promise<void>>();
  const controllers = new Map<BaseAudioContext, AbortController>();
  const owned = new Map<BaseAudioContext, Set<{ dispose(): unknown }>>();
  const voices = new Map<BaseAudioContext, Set<() => void>>();
  const prepareContext = async (
    raw: BaseAudioContext,
    signal?: AbortSignal,
  ) => {
    await prepareTone();
    if (!preparations.has(raw)) {
      const toneContext = createToneContext(raw),
        nodes = new Set<{ dispose(): unknown }>(),
        controller = new AbortController();
      controllers.set(raw, controller);
      contexts.set(raw, toneContext);
      owned.set(raw, nodes);
      const pending = Promise.resolve().then(() =>
        prepare?.({
          Tone: createToneFacade(toneContext, nodes),
          toneContext,
          context: raw,
          signal: controller.signal,
        }),
      );
      preparations.set(raw, pending);
      void pending.catch(() => {
        if (preparations.get(raw) === pending) {
          preparations.delete(raw);
          controllers.delete(raw);
          contexts.delete(raw);
          owned.delete(raw);
          for (const node of [...nodes].reverse()) {
            try {
              node.dispose();
            } catch {}
          }
          toneContext.dispose();
        }
      });
    }
    await import("./live-audio-update").then(({ waitAudioReady }) =>
      waitAudioReady(preparations.get(raw)!, signal),
    );
  };
  return {
    async prepareAudio(raw) {
      await prepareContext(raw);
    },
    async prepareSegment({ context, signal }) {
      await prepareContext(context, signal);
    },
    createAudio(options) {
      const abort = new AbortController();
      const raw = options.context,
        toneContext = createToneContext(raw, options.destination),
        nodes = new Set<{ dispose(): unknown }>();
      const active = voices.get(raw) ?? new Set<() => void>();
      voices.set(raw, active);
      let voice: { dispose(): void; ready?: Promise<unknown> } | undefined,
        stopClock = () => {},
        done = false;
      const dispose = () => {
        if (done) return;
        done = true;
        abort.abort();
        stopClock();
        active.delete(dispose);
        try {
          voice?.dispose();
        } finally {
          for (const node of [...nodes].reverse()) {
            try {
              node.dispose();
            } catch {}
          }
          nodes.clear();
          toneContext.dispose();
        }
      };
      active.add(dispose);
      try {
        voice = build({
          ...options,
          Tone: createToneFacade(toneContext, nodes),
          toneContext,
        });
      } catch (e) {
        dispose();
        throw e;
      }
      const ready = Promise.resolve(voice.ready)
        .then(async () => {
          if (done) return;
          if (toneContext.isOffline)
            await renderToneClock(toneContext, abort.signal);
          else
            stopClock = driveToneClock(toneContext, (error) => {
              dispose();
              options.onError?.(error);
            });
        })
        .catch((e) => {
          dispose();
          throw e;
        });
      return { ready, dispose };
    },
    disposeAudio(raw) {
      controllers.get(raw)?.abort();
      controllers.delete(raw);
      for (const dispose of [...(voices.get(raw) ?? [])]) dispose();
      voices.delete(raw);
      for (const node of [...(owned.get(raw) ?? [])].reverse()) {
        try {
          node.dispose();
        } catch {}
      }
      owned.delete(raw);
      contexts.get(raw)?.dispose();
      contexts.delete(raw);
      preparations.delete(raw);
    },
  };
}

export {
  createLiveAudioInput,
  enumerateLiveAudioInputs,
  liveAudioInputSupported,
} from "./live-audio-input";
export type {
  LiveAudioInputHandle,
  LiveAudioInputDevice,
} from "./live-audio-input";
