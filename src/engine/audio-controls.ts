import type { AudioTrack } from "./types";

/** Preserve user mixer overrides while adopting newly authored defaults. */
export function nextAudioControls(
  previous: AudioTrack[],
  next: AudioTrack[],
  controls: Map<string, { gain: number; muted: boolean }>,
) {
  const authored = new Map(previous.map((t) => [t.id, t]));
  return new Map(
    next.map((t) => {
      const old = authored.get(t.id),
        control = controls.get(t.id);
      return [
        t.id,
        {
          gain:
            control && old && control.gain !== (old.gain ?? 1)
              ? control.gain
              : (t.gain ?? 1),
          muted:
            control && old && control.muted !== (old.muted ?? false)
              ? control.muted
              : (t.muted ?? false),
        },
      ];
    }),
  );
}

export function audioTrackSourceSignature(track: AudioTrack) {
  const {
    gain: _gain,
    muted: _muted,
    pan: _pan,
    name: _name,
    automation: _automation,
    fadeIn: _fadeIn,
    fadeOut: _fadeOut,
    fadeOffset: _fadeOffset,
    fadeDuration: _fadeDuration,
    ...source
  } = track;
  return JSON.stringify(source);
}

/** Cancel existing ramps before setting a smooth target; a parameter edit never clicks. */
export function smoothAudioParam(
  param: AudioParam,
  value: number,
  context: BaseAudioContext,
) {
  const at = context.currentTime;
  if (typeof param.cancelAndHoldAtTime === "function")
    param.cancelAndHoldAtTime(at);
  else {
    param.cancelScheduledValues(at);
    param.setValueAtTime(param.value, at);
  }
  param.setTargetAtTime(value, at, 0.012);
}

export function waitAudioReady<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
