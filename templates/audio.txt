import type { GeneratedAudioOptions } from "../../src/engine/types";

// Minimal deterministic example. Replace with the film's own instruments/events.
// This runs in the browser and OfflineAudioContext, without writing audio files.
export function createAudio({ trackId, context, destination, when, offset, duration, rate }: GeneratedAudioOptions) {
  const sampleRate = context.sampleRate;
  const buffer = context.createBuffer(1, Math.ceil(duration * sampleRate), sampleRate);
  const samples = buffer.getChannelData(0);
  const notes = trackId === "pulse" ? [110, 110, 146.83, 130.81] : [440, 523.25, 659.25, 587.33];
  for (let i = 0; i < samples.length; i++) {
    const time = offset + i / sampleRate;
    const beat = Math.floor(time), local = time - beat;
    const envelope = Math.min(1, local / 0.02) * Math.max(0, 1 - local / 0.8);
    samples[i] = Math.sin(2 * Math.PI * notes[beat % notes.length] * local) * envelope * 0.12;
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  source.connect(destination);
  source.start(when, 0, duration);
  let disposed = false;
  return { dispose() {
    if (disposed) return;
    disposed = true;
    source.stop(); source.disconnect(); source.buffer = null;
  } };
}
