import type { GeneratedAudioModule, GeneratedAudioOptions } from "./types";
import type * as ToneType from "tone";
import type * as ToneClasses from "tone/build/esm/classes.js";
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
      Tone: typeof ToneClasses;
      toneContext: ToneType.BaseContext;
    },
  ) => { dispose(): void },
): GeneratedAudioModule {
  let Tone: typeof ToneClasses | undefined;
  const contexts = new Map<BaseAudioContext, ToneType.BaseContext>();
  const users = new Map<BaseAudioContext, number>();
  const get = (raw: BaseAudioContext) => {
    let context = contexts.get(raw);
    if (!context) {
      if (!Tone) throw Error("Call prepareAudio before Tone scheduling");
      class BorrowedContext extends Tone.Context {
        async close() {
          /* The host owns this AudioContext. */
        }
      }
      context =
        "startRendering" in raw
          ? new Tone.OfflineContext(raw as OfflineAudioContext)
          : new BorrowedContext({
              context: raw as AudioContext,
              clockSource: "offline",
              lookAhead: 0,
            });
      contexts.set(raw, context);
    }
    return context;
  };
  return {
    async prepareAudio(raw) {
      // The public index eagerly creates its global Transport/Destination and
      // native AudioContext. Class modules remain idle until a voice is built.
      Tone ??= await import("tone/build/esm/classes.js");
      get(raw);
    },
    async prepareSegment({ context }) {
      Tone ??= await import("tone/build/esm/classes.js");
      get(context);
    },
    createAudio(options) {
      const raw = options.context;
      users.set(raw, (users.get(raw) ?? 0) + 1);
      let voice: { dispose(): void };
      try {
        voice = build({ ...options, Tone: Tone!, toneContext: get(raw) });
      } catch (e) {
        users.set(raw, users.get(raw)! - 1);
        if (!users.get(raw)) {
          contexts.get(raw)?.dispose();
          contexts.delete(raw);
          users.delete(raw);
        }
        throw e;
      }
      let done = false;
      return {
        dispose() {
          if (done) return;
          done = true;
          try {
            voice.dispose();
          } finally {
            users.set(raw, (users.get(raw) ?? 1) - 1);
            if (!users.get(raw)) {
              contexts.get(raw)?.dispose();
              contexts.delete(raw);
              users.delete(raw);
            }
          }
        },
      };
    },
    disposeAudio(raw) {
      contexts.get(raw)?.dispose();
      contexts.delete(raw);
      users.delete(raw);
    },
  };
}
