import {
  assetUrl,
  projectAudioTracks,
  type AnimationProject,
  type AudioTrack,
  type GeneratedAudioModule,
} from "./types";
import { preparePreviewAudio } from "./preview-audio";
export interface PreparedAudio {
  preview?: boolean;
  tracks: AudioTrack[];
  buffers: Map<string, AudioBuffer>;
  generated?: GeneratedAudioModule;
  progressive?: boolean;
}
export async function prepareAudio(
  project: AnimationProject,
  context: BaseAudioContext,
  signal?: AbortSignal,
  progressive = false,
): Promise<PreparedAudio> {
  if (progressive) {
    const preview = await preparePreviewAudio(project, context, signal);
    if (preview) return preview;
  }
  const tracks = projectAudioTracks(project),
    buffers = new Map<string, AudioBuffer>();
  await Promise.all(
    tracks.map(async (track) => {
      if (track.kind !== "file" || progressive) return;
      const response = await fetch(assetUrl(track.src), { signal });
      if (!response.ok)
        throw new Error(`音轨 ${track.name} 载入失败：${response.status}`);
      buffers.set(
        track.id,
        await context.decodeAudioData(await response.arrayBuffer()),
      );
    }),
  );
  const generated = tracks.some((t) => t.kind === "generated")
    ? await project.loadAudio?.()
    : undefined;
  if (tracks.some((t) => t.kind === "generated") && !generated)
    throw new Error("缺少代码音轨生成器");
  const release = () => generated?.disposeAudio?.(context);
  signal?.addEventListener("abort", release, { once: true });
  try {
    signal?.throwIfAborted();
    await generated?.prepareAudio?.(context);
    signal?.throwIfAborted();
  } catch (error) {
    release();
    throw error;
  } finally {
    signal?.removeEventListener("abort", release);
  }
  return { tracks, buffers, generated, progressive };
}
export function trackSegment(
  track: AudioTrack,
  projectDuration: number,
  from: number,
  length: number,
) {
  const start = Math.max(from, track.start ?? 0);
  const end = Math.min(
    from + length,
    projectDuration,
    (track.start ?? 0) + (track.duration ?? projectDuration),
  );
  return end > start
    ? {
        delay: start - from,
        offset: (track.offset ?? 0) + start - (track.start ?? 0),
        duration: end - start,
      }
    : undefined;
}
/** Only generated tracks need a source-time buffer before scheduling. */
export function prepareAudioSegment(
  prepared: PreparedAudio,
  context: BaseAudioContext,
  projectDuration: number,
  from: number,
  length: number,
  rate = 1,
  overrides = new Map<string, { gain: number; muted: boolean }>(),
  signal?: AbortSignal,
): void | Promise<void> {
  signal?.throwIfAborted();
  if (!prepared.generated?.prepareSegment) return;
  return Promise.all(
    prepared.tracks.map(async (track) => {
      const control = overrides.get(track.id) ?? track;
      if (track.kind !== "generated" || control.muted || control.gain === 0)
        return;
      const segment = trackSegment(track, projectDuration, from, length);
      if (!segment) return;
      await prepared.generated!.prepareSegment!({
        trackId: track.id,
        context,
        offset: segment.offset,
        duration: segment.duration,
        rate,
        signal,
      });
    }),
  ).then(() => {});
}
/** One scheduling graph for realtime playback and offline export. */
export function scheduleAudio(
  prepared: PreparedAudio,
  context: BaseAudioContext,
  destination: AudioNode,
  projectDuration: number,
  from: number,
  length: number,
  when: number,
  rate = 1,
  overrides = new Map<string, { gain: number; muted: boolean }>(),
  onError?: (error: Error) => void,
) {
  const cleanups: (() => void)[] = [];
  const gains = new Map<string, GainNode>();
  const dispose = () => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  };
  try {
    for (const track of prepared.tracks) {
      if (track.kind === "file" && prepared.progressive) continue;
      const segment = trackSegment(track, projectDuration, from, length);
      const control = overrides.get(track.id) ?? {
        gain: track.gain ?? 1,
        muted: track.muted ?? false,
      };
      if (!segment || control.muted || control.gain === 0) continue;
      const gain = context.createGain();
      gains.set(track.id, gain);
      gain.gain.value = control.gain;
      gain.connect(destination);
      cleanups.push(() => gain.disconnect());
      const at = when + segment.delay / rate;
      if (track.kind === "file") {
        const buffer = prepared.buffers.get(track.id)!;
        const duration = Math.min(
          segment.duration,
          buffer.duration - segment.offset,
        );
        if (duration <= 0) continue;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        source.connect(gain);
        cleanups.push(() => {
          source.stop();
          source.disconnect();
        });
        source.start(at, segment.offset, duration);
      } else {
        const voice = prepared.generated!.createAudio({
          trackId: track.id,
          context,
          destination: gain,
          when: at,
          offset: segment.offset,
          duration: segment.duration,
          rate,
          onError,
        });
        cleanups.push(() => voice.dispose());
      }
    }
    return {
      dispose,
      setTrack(id: string, control: { gain: number; muted: boolean }) {
        const gain = gains.get(id);
        if (gain)
          gain.gain.setTargetAtTime(
            control.muted ? 0 : control.gain,
            context.currentTime,
            0.012,
          );
        return !!gain;
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
/** Bounded chunks prevent film-sized WAV transfers through the browser bridge. */
export class OfflineAudioRenderer {
  private prepared?: Promise<PreparedAudio>;
  private sessionContext?: OfflineAudioContext;
  private abort = new AbortController();
  constructor(
    private project: AnimationProject,
    private controls = new Map<string, { gain: number; muted: boolean }>(),
    private volume = 1,
  ) {}
  dispose() {
    this.abort.abort();
    const context = this.sessionContext;
    if (context)
      void this.prepared
        ?.then((prepared) => prepared.generated?.disposeAudio?.(context))
        .catch(() => {});
    this.prepared = undefined;
    this.sessionContext = undefined;
  }
  async render(start: number, duration: number): Promise<AudioBuffer> {
    this.abort.signal.throwIfAborted();
    if (
      !Number.isFinite(start) ||
      start < 0 ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 10
    )
      throw new Error("Audio chunks must be between 0 and 10 seconds");
    const context = new OfflineAudioContext(
      2,
      Math.round(duration * 48000),
      48000,
    );
    if (!this.prepared) this.sessionContext = context;
    this.prepared ??= prepareAudio(
      this.project,
      context,
      this.abort.signal,
    ).catch((error) => {
      this.prepared = undefined;
      throw error;
    });
    const prepared = await this.prepared;
    this.abort.signal.throwIfAborted();
    await prepareAudioSegment(
      prepared,
      context,
      this.project.duration,
      start,
      duration,
      1,
      this.controls,
      this.abort.signal,
    );
    this.abort.signal.throwIfAborted();
    const master = context.createGain();
    master.gain.value = this.volume;
    master.connect(context.destination);
    let graph: { dispose(): void } | undefined;
    try {
      graph = scheduleAudio(
        prepared,
        context,
        master,
        this.project.duration,
        start,
        duration,
        0,
        1,
        this.controls,
      );
      const buffer = await context.startRendering();
      this.abort.signal.throwIfAborted();
      for (let channel = 0; channel < buffer.numberOfChannels; channel++)
        for (const sample of buffer.getChannelData(channel))
          if (!Number.isFinite(sample)) throw new Error("音轨包含无效采样");
      return buffer;
    } finally {
      graph?.dispose();
      master.disconnect();
    }
  }
  async pcm(start: number, duration: number): Promise<string> {
    const buffer = await this.render(start, duration);
    const bytes = new Uint8Array(buffer.length * 4),
      view = new DataView(bytes.buffer);
    for (let channel = 0; channel < 2; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        if (!Number.isFinite(sample)) throw new Error("音轨包含无效采样");
        view.setInt16(
          (i * 2 + channel) * 2,
          Math.round(
            Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767),
          ),
          true,
        );
      }
    }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  }
}
