import {
  projectAudioTracks,
  type AnimationProject,
  type AudioTrack,
  type GeneratedAudioModule,
} from "./types";
import { preparePreviewAudio } from "./preview-audio";
import { audioSegments } from "./audio-document.mjs";
import { AudioSourcePool } from "./audio-source-pool";
import {
  buildMixGraph,
  scheduleClipEnvelope,
  mixPreroll,
  type AudioMixDocument,
} from "./audio-processors";
export interface PreparedAudio {
  preview?: boolean;
  tracks: AudioTrack[];
  buffers: Map<string, AudioBuffer>;
  generated?: GeneratedAudioModule;
  progressive?: boolean;
  files?: AudioSourcePool;
  document?: AudioMixDocument;
  modules?: Map<string, GeneratedAudioModule>;
}
function generator(prepared: PreparedAudio, track: AudioTrack) {
  if (track.kind !== "generated") throw Error("Not a generated track");
  const mod =
    track.module && track.module !== "legacy"
      ? prepared.generated?.generators?.[track.module]
      : prepared.generated;
  if (!mod) throw Error("未注册的声音生成器：" + (track.module ?? track.id));
  return { mod, id: track.sourceTrackId ?? track.id };
}
export async function prepareAudio(
  project: AnimationProject,
  context: BaseAudioContext,
  signal?: AbortSignal,
  progressive = false,
): Promise<PreparedAudio> {
  if (progressive && !project.audioDocument) {
    const preview = await preparePreviewAudio(project, context, signal);
    if (preview) return preview;
  }
  const tracks = projectAudioTracks(project),
    generated = tracks.some((t) => t.kind === "generated")
      ? await project.loadAudio?.()
      : undefined;
  const prepared: PreparedAudio = {
    tracks,
    buffers: new Map(),
    generated,
    progressive: progressive && !project.audioDocument,
    files: new AudioSourcePool(),
    document: project.audioDocument as AudioMixDocument | undefined,
    modules: new Map(),
  };
  try {
    for (const track of tracks)
      if (track.kind === "generated") {
        const { mod } = generator(prepared, track),
          key = track.module ?? "__legacy__";
        if (!prepared.modules!.has(key)) {
          prepared.modules!.set(key, mod);
          signal?.throwIfAborted();
          await mod.prepareAudio?.(context);
        }
      }
    signal?.throwIfAborted();
    return prepared;
  } catch (e) {
    disposePreparedAudio(prepared, context);
    throw e;
  }
}
export function disposePreparedAudio(
  prepared: PreparedAudio,
  context: BaseAudioContext,
) {
  prepared.files?.dispose();
  for (const mod of new Set(
    prepared.modules?.values() ??
      (prepared.generated ? [prepared.generated] : []),
  ))
    mod.disposeAudio?.(context);
  prepared.buffers.clear();
}
export function trackSegment(
  track: AudioTrack,
  projectDuration: number,
  from: number,
  length: number,
) {
  const start = Math.max(from, track.start ?? 0),
    end = Math.min(
      from + length,
      projectDuration,
      (track.start ?? 0) + (track.duration ?? projectDuration),
    );
  if (end <= start) return;
  const t =
    (start - (track.start ?? 0)) * (track.playbackRate ?? 1) +
    (track.phase ?? 0);
  return {
    delay: start - from,
    offset: (track.offset ?? 0) + (track.loop ? t % track.loop : t),
    duration: (end - start) * (track.playbackRate ?? 1),
  };
}
export async function prepareAudioSegment(
  prepared: PreparedAudio,
  context: BaseAudioContext,
  projectDuration: number,
  from: number,
  length: number,
  rate = 1,
  overrides = new Map<string, { gain: number; muted: boolean }>(),
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const offline = "startRendering" in context;
  if (!offline && prepared.files && !prepared.progressive) {
    const needed = new Set<string>(),
      budget = prepared.files.diagnostics().budgetBytes;
    for (const track of prepared.tracks) {
      const control = overrides.get(track.id) ?? track;
      if (track.kind !== "file" || control.muted || control.gain === 0)
        continue;
      for (const segment of audioSegments(
        track,
        projectDuration,
        from,
        Math.min(length, 1.5 * rate),
      )) {
        for (
          let i = Math.floor(segment.offset * 2);
          i < Math.ceil((segment.offset + segment.duration) * 2 - 1e-8);
          i++
        ) {
          needed.add(track.src + ":" + i);
          if (needed.size * 192000 > budget)
            throw Error(
              "当前音频预缓冲超出 128 MiB 预算，请降低播放速度、减少重叠片段，或先导出分轨素材",
            );
        }
      }
    }
  }
  // Only the audible interval is decoded. Source pooling deduplicates repeated clips.
  for (const track of prepared.tracks) {
    const control = overrides.get(track.id) ?? track;
    if (
      control.muted ||
      control.gain === 0 ||
      (track.kind === "file" && prepared.progressive)
    )
      continue;
    const countLength = offline ? length : Math.min(length, 1.5 * rate);
    for (const segment of audioSegments(
      track,
      projectDuration,
      from,
      countLength,
    )) {
      signal?.throwIfAborted();
      if (track.kind === "file") {
        if (offline) continue;
        await prepared.files!.prepare(
          track.src,
          segment.offset,
          segment.duration,
          signal,
        );
      } else {
        const { mod, id } = generator(prepared, track);
        await mod.prepareSegment?.({
          trackId: id,
          context,
          offset: segment.offset,
          duration: segment.duration,
          rate: rate * (track.playbackRate ?? 1),
          signal,
        });
      }
    }
  }
}
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
  const pending: Promise<void>[] = [],
    cleanups: (() => void)[] = [],
    gains = new Map<string, GainNode>();
  const offline = "startRendering" in context;
  const mix = buildMixGraph(
    context,
    destination,
    prepared.document,
    from,
    when,
    rate,
  );
  cleanups.push(() => mix.dispose());
  const dispose = () => {
    for (const f of cleanups.splice(0).reverse()) f();
  };
  try {
    for (const track of prepared.tracks) {
      if (track.kind === "file" && prepared.progressive) continue;
      const control = overrides.get(track.id) ?? {
        gain: track.gain ?? 1,
        muted: track.muted ?? false,
      };
      if (
        control.muted ||
        control.gain === 0 ||
        !trackSegment(track, projectDuration, from, length)
      )
        continue;
      const gain = context.createGain(),
        envelope = context.createGain(),
        pan = context.createStereoPanner();
      gains.set(track.id, gain);
      gain.gain.value = control.gain;
      pan.pan.value = track.pan ?? 0;
      gain.connect(envelope);
      envelope.connect(pan);
      pan.connect(mix.destination(track));
      scheduleClipEnvelope(envelope.gain, track, from, length, when, rate);
      cleanups.push(() => {
        gain.disconnect();
        envelope.disconnect();
        pan.disconnect();
      });
      const trackEnd = Math.min(
        from + length,
        (track.start ?? 0) + (track.duration ?? projectDuration),
      );
      let disposed = false,
        pumping = false,
        cursor = from;
      const abort = new AbortController(),
        voices = new Set<{ dispose(): void }>();
      const schedule = (
        segment: { delay: number; offset: number; duration: number },
        base: number,
      ) => {
        const at = when + (base - from + segment.delay) / rate;
        if (!offline && at < context.currentTime - 0.04)
          throw Error("音频准备超时，已暂停");
        const options = {
          context,
          destination: gain,
          when: at,
          offset: segment.offset,
          duration: segment.duration,
          rate: rate * (track.playbackRate ?? 1),
          onError,
        };
        let voice: { dispose(): void; ready?: Promise<void> };
        if (track.kind === "file")
          voice = prepared.files!.play(track.src, options);
        else {
          const { mod, id } = generator(prepared, track);
          voice = mod.createAudio({ ...options, trackId: id });
        }
        voices.add(voice);
        if (voice.ready) {
          pending.push(voice.ready);
          void voice.ready.catch(() => {});
        }
        // Wall timers may fire while the owned context is suspended for preparation.
        // Recheck audio time before disposing a voice so a slow ready promise cannot
        // consume its playback interval before the transport actually starts.
        if (!offline) {
          const finish = () => {
            timeouts.delete(timer);
            if (disposed) return;
            const remaining = at + segment.duration / options.rate - context.currentTime;
            if (remaining > 0) {
              timer = setTimeout(finish, remaining * 1000 + 100);
              timeouts.add(timer);
            } else {
              voices.delete(voice);
              voice.dispose();
            }
          };
          let timer = setTimeout(finish, Math.max(0,
            (at + segment.duration / options.rate - context.currentTime) * 1000) + 100);
          timeouts.add(timer);
        }
      };
      const timeouts = new Set<ReturnType<typeof setTimeout>>();
      // Non-looping generators schedule their own future chunks. Files use the same bounded source reader.
      const selfScheduled = track.kind === "generated" && !track.loop;
      const limit =
        offline || selfScheduled
          ? trackEnd
          : Math.min(trackEnd, from + 1.5 * rate);
      for (const s of audioSegments(track, projectDuration, from, limit - from))
        schedule(s, from);
      cursor = limit;
      const pump = async () => {
        if (disposed || pumping) return;
        if (cursor >= trackEnd) {
          clearInterval(timer);
          return;
        }
        pumping = true;
        try {
          const until = Math.min(
            trackEnd,
            from + Math.max(0, context.currentTime - when) * rate + 1.5 * rate,
          );
          if (until <= cursor + 1e-7) return;
          // Fixed scheduling windows preserve loops while keeping node counts bounded.
          const stop = Math.min(trackEnd, cursor + Math.max(0.25, rate * 0.5));
          if (cursor >= until) return;
          for (const s of audioSegments(
            track,
            projectDuration,
            cursor,
            stop - cursor,
          )) {
            if (track.kind === "file")
              await prepared.files!.prepare(
                track.src,
                s.offset,
                s.duration,
                abort.signal,
              );
            else {
              const { mod, id } = generator(prepared, track);
              await mod.prepareSegment?.({
                trackId: id,
                context,
                offset: s.offset,
                duration: s.duration,
                rate: rate * (track.playbackRate ?? 1),
                signal: abort.signal,
              });
            }
            if (disposed) return;
            schedule(s, cursor);
          }
          cursor = stop;
        } catch (e) {
          if (!disposed) {
            disposed = true;
            onError?.(e instanceof Error ? e : Error(String(e)));
          }
        } finally {
          pumping = false;
        }
      };
      const timer =
        offline || selfScheduled
          ? undefined
          : setInterval(() => void pump(), 100);
      cleanups.push(() => {
        disposed = true;
        abort.abort();
        clearInterval(timer);
        for (const t of timeouts) clearTimeout(t);
        for (const v of voices) v.dispose();
        voices.clear();
      });
    }
    return {
      dispose,
      ready: Promise.all(pending),
      setTrack(id: string, control: { gain: number; muted: boolean }) {
        const g = gains.get(id);
        if (g)
          g.gain.setTargetAtTime(
            control.muted ? 0 : control.gain,
            context.currentTime,
            0.012,
          );
        return !!g;
      },
    };
  } catch (e) {
    dispose();
    throw e;
  }
}
export class OfflineAudioRenderer {
  private prepared?: Promise<PreparedAudio>;
  private sessionContext?: OfflineAudioContext;
  private abort = new AbortController();
  private rendering: Promise<unknown> = Promise.resolve();
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
        ?.then((p) => disposePreparedAudio(p, context))
        .catch(() => {});
    this.prepared = undefined;
    this.sessionContext = undefined;
  }
  render(start: number, duration: number): Promise<AudioBuffer> {
    const request = this.rendering
      .catch(() => {})
      .then(() => this.renderChunk(start, duration));
    this.rendering = request;
    return request;
  }
  private async renderChunk(
    start: number,
    duration: number,
  ): Promise<AudioBuffer> {
    this.abort.signal.throwIfAborted();
    if (
      !Number.isFinite(start) ||
      start < 0 ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 10
    )
      throw Error("Audio chunks must be between 0 and 10 seconds");
    const preroll = Math.min(
      start,
      mixPreroll(this.project.audioDocument as AudioMixDocument | undefined),
    );
    if (preroll > 120)
      throw Error(
        "效果链尾音超过 120 秒离线预滚动预算，请降低反馈或先将效果导出为素材",
      );
    const begin = Math.round((start - preroll) * 48000) / 48000,
      warmup = Math.round((start - begin) * 48000),
      frames = Math.round(duration * 48000);
    const context = new OfflineAudioContext(2, warmup + frames, 48000);
    if (!this.prepared) this.sessionContext = context;
    this.prepared ??= prepareAudio(
      this.project,
      context,
      this.abort.signal,
    ).catch((e) => {
      this.prepared = undefined;
      throw e;
    });
    const prepared = await this.prepared;
    await prepareAudioSegment(
      prepared,
      context,
      this.project.duration,
      begin,
      (warmup + frames) / 48000,
      1,
      this.controls,
      this.abort.signal,
    );
    const master = context.createGain();
    master.gain.value = this.volume;
    master.connect(context.destination);
    let graph: { dispose(): void; ready: Promise<unknown> } | undefined;
    try {
      graph = scheduleAudio(
        prepared,
        context,
        master,
        this.project.duration,
        begin,
        (warmup + frames) / 48000,
        0,
        1,
        this.controls,
      );
      await graph.ready;
      const all = await context.startRendering();
      this.abort.signal.throwIfAborted();
      const result = new AudioBuffer({
        numberOfChannels: 2,
        length: frames,
        sampleRate: 48000,
      });
      for (let ch = 0; ch < 2; ch++) {
        const samples = all
          .getChannelData(ch)
          .subarray(warmup, warmup + frames);
        for (const s of samples)
          if (!Number.isFinite(s)) throw Error("音轨包含无效采样");
        result.copyToChannel(samples, ch);
      }
      return result;
    } finally {
      graph?.dispose();
      master.disconnect();
    }
  }
  async pcm(
    start: number,
    duration: number,
    format: "pcm16" | "float32" = "pcm16",
  ): Promise<string> {
    const buffer = await this.render(start, duration),
      bytes = new Uint8Array(buffer.length * (format === "float32" ? 8 : 4)),
      view = new DataView(bytes.buffer);
    for (let ch = 0; ch < 2; ch++) {
      const samples = buffer.getChannelData(ch);
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        if (format === "float32")
          view.setFloat32((i * 2 + ch) * 4, sample, true);
        else
          view.setInt16(
            (i * 2 + ch) * 2,
            Math.round(
              Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767),
            ),
            true,
          );
      }
    }
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }
}
