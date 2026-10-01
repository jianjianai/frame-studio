import { SignalsmithPcmCache } from "./signalsmith-pcm";
import {
  projectAudioTracks,
  type AnimationProject,
  type AudioTrack,
  type GeneratedAudioModule,
} from "./types";
import { preparePreviewAudio } from "./preview-audio";
import {
  audioTrackSourceSignature,
  smoothAudioParam,
  waitAudioReady,
} from "./live-audio-update";
import {
  PreviewBuffering,
  LIVE_BUFFER_SECONDS,
  LIVE_LOOKAHEAD_SECONDS,
} from "./media-buffering";
import { audioSegments } from "./audio-document.mjs";
import { prepareSignalsmith } from "./signalsmith-audio";
import { prepareTone } from "./tone-runtime";
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
  sourceKeys?: Map<string, string>;
  project?: AnimationProject;
  moduleRefs?: boolean;
  disposed?: boolean;
  live?: boolean;
}
type ModuleSession = { users: number; ready: Promise<void>; settled: boolean };
const moduleSessions = new WeakMap<
  BaseAudioContext,
  Map<GeneratedAudioModule, ModuleSession>
>();
function retainGenerator(mod: GeneratedAudioModule, context: BaseAudioContext) {
  let sessions = moduleSessions.get(context);
  if (!sessions) {
    sessions = new Map();
    moduleSessions.set(context, sessions);
  }
  let session = sessions.get(mod);
  if (!session) {
    const owned: ModuleSession = {
      users: 0,
      settled: false,
      ready: Promise.resolve().then(() => mod.prepareAudio?.(context)),
    };
    session = owned;
    sessions.set(mod, owned);
    void owned.ready
      .finally(() => {
        owned.settled = true;
        if (owned.users === 0 && sessions!.get(mod) === owned) {
          sessions!.delete(mod);
          mod.disposeAudio?.(context);
        }
      })
      .catch(() => {});
  }
  session.users++;
  return session.ready;
}
function releaseGenerator(
  mod: GeneratedAudioModule,
  context: BaseAudioContext,
) {
  const sessions = moduleSessions.get(context),
    session = sessions?.get(mod);
  if (!session) return;
  if (--session.users === 0 && session.settled) {
    sessions!.delete(mod);
    mod.disposeAudio?.(context);
  }
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
  previous?: PreparedAudio,
): Promise<PreparedAudio> {
  if (progressive && !project.audioDocument && !project.livePreview) {
    const preview = await preparePreviewAudio(project, context, signal);
    if (preview) return preview;
  }
  const tracks = projectAudioTracks(project),
    generated = tracks.some((t) => t.kind === "generated")
      ? previous?.generated &&
        project.previewAudioGeneratorRevision &&
        project.previewAudioGeneratorRevision ===
          previous.project?.previewAudioGeneratorRevision
        ? previous.generated
        : await project.loadAudio?.()
      : undefined;
  const prepared: PreparedAudio = {
    tracks,
    buffers: new Map(),
    generated,
    progressive: progressive && !project.audioDocument && !project.livePreview,
    files: previous?.files ?? new AudioSourcePool(),
    sourceKeys: new Map(),
    live: progressive && project.livePreview,
    project,
    document: project.audioDocument as AudioMixDocument | undefined,
    modules: new Map(),
    moduleRefs: true,
  };
  try {
    prepared.files!.setActiveSources(
      new Set(
        tracks
          .filter((t) => t.kind === "file")
          .map((t) => (t.kind === "file" ? t.src : "")),
      ).size,
    );
    adaptAudioSourceRenditions(prepared);
    for (const track of tracks)
      if (track.kind === "generated") {
        const { mod } = generator(prepared, track),
          key = track.module ?? "__legacy__";
        if (!prepared.modules!.has(key)) {
          prepared.modules!.set(key, mod);
          signal?.throwIfAborted();
          await waitAudioReady(retainGenerator(mod, context), signal);
        }
      }
    signal?.throwIfAborted();
    return prepared;
  } catch (e) {
    disposePreparedAudio(prepared, context, previous);
    throw e;
  }
}
/** Rebuffering can lower compressed source bandwidth without changing the
 * frozen original media used by export or invalidating unrelated PCM windows. */
export function adaptAudioSourceRenditions(prepared: PreparedAudio) {
  for (const track of prepared.tracks)
    if (track.kind === "file") {
      const source = prepared.project?.previewAudioSources?.[track.src];
      const mode = typeof window !== "undefined" ? window.__FRAME_PREVIEW_MEDIA_MODE__ : undefined;
      const original = !prepared.live || mode === "original" || mode === "cached" ||
        (typeof window !== "undefined" && (window.__FRAME_PREVIEW_READERS__ ?? 0) > 0);
      prepared.sourceKeys?.set(
        track.src,
        prepared.files!.bind(
          track.src,
          original
            ? source?.originalUrl ? { revision: source.revision, url: source.originalUrl } : undefined
            : source,
        ),
      );
    }
}
export function disposePreparedAudio(
  prepared: PreparedAudio,
  context: BaseAudioContext,
  retain?: PreparedAudio,
) {
  if (prepared.disposed) return;
  prepared.disposed = true;
  if (prepared.files !== retain?.files) prepared.files?.dispose();
  for (const mod of new Set(
    prepared.modules?.values() ??
      (prepared.generated ? [prepared.generated] : []),
  ))
    if (prepared.moduleRefs) releaseGenerator(mod, context);
    else if (!retain?.modules || ![...retain.modules.values()].includes(mod))
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
  const processors = prepared.document ? [prepared.document.master, ...prepared.document.tracks, ...prepared.document.buses].flatMap(c => c.processors) : [];
  if (processors.some(p => p.type === "tone" && !p.bypass)) await prepareTone();
  if (prepared.tracks.some(t => t.pitch || t.preservePitch || t.stretch)) await prepareSignalsmith();
  const began = performance.now();
  const activeSources = new Set(
    prepared.tracks
      .filter(
        (t) =>
          t.kind === "file" &&
          !(overrides.get(t.id) ?? t).muted &&
          (overrides.get(t.id) ?? t).gain !== 0,
      )
      .map((t) => (t.kind === "file" ? t.src : "")),
  ).size;
  prepared.files?.setActiveSources(activeSources);
  const bufferSeconds =
    prepared.files?.bufferSeconds(rate, true) ?? LIVE_BUFFER_SECONDS;
  if (prepared.preview && !offline) {
    await Promise.all(
      prepared.tracks.map(async (track) => {
        const control = overrides.get(track.id) ?? track;
        if (control.muted || control.gain === 0) return;
        await prepared.generated?.prepareSegment?.({
          trackId: track.id,
          context,
          offset: from,
          duration: length,
          rate,
          signal,
        });
      }),
    );
    return;
  }
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
        Math.min(length, bufferSeconds * rate),
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
  await Promise.all(
    prepared.tracks.map(async (track) => {
      const control = overrides.get(track.id) ?? track;
      if (
        control.muted ||
        control.gain === 0 ||
        (track.kind === "file" && prepared.progressive)
      )
        return;
      const countLength = offline
        ? length
        : Math.min(length, bufferSeconds * rate);
      for (const segment of audioSegments(
        track,
        projectDuration,
        from,
        countLength,
      )) {
        signal?.throwIfAborted();
        if (track.kind === "file") {
          if (track.pitch || track.preservePitch || track.stretch) await prepared.files!.prepareStretched(
            prepared.sourceKeys?.get(track.src) ?? track.src,
            { rate: rate * (track.playbackRate ?? 1), pitch: track.pitch, preservePitch: track.preservePitch, stretch: track.stretch,
              ...(track.loop ? { loopEnd: (track.offset ?? 0) + track.loop } : {}) }, signal);
          if (offline) continue;
          await prepared.files!.prepare(
            prepared.sourceKeys?.get(track.src) ?? track.src,
            Math.max(0, segment.offset - (track.pitch || track.preservePitch || track.stretch ? 0.5 : 0)),
            segment.duration + (track.pitch || track.preservePitch || track.stretch ? 1 : 0),
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
            pitch: track.pitch, preservePitch: track.preservePitch, stretch: track.stretch,
            signal,
          });
        }
      }
    }),
  );
  if (!offline)
    prepared.files?.buffering.observePreparation(
      (performance.now() - began) / 1000,
    );
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
  const offline = "startRendering" in context;
  let mix = buildMixGraph(
    context,
    destination,
    prepared.document,
    from,
    when,
    rate,
  );
  type Instance = {
    track: AudioTrack;
    owner: PreparedAudio;
    gain: GainNode;
    envelope: GainNode;
    pan: StereoPannerNode;
    ready: Promise<unknown>;
    dispose(): void;
  };
  const instances = new Map<string, Instance>();
  let closed = false;
  const retired = new Map<
    ReturnType<typeof buildMixGraph>,
    ReturnType<typeof setTimeout>
  >();
  function createTrack(
    track: AudioTrack,
    owner: PreparedAudio,
    from: number,
    length: number,
    when: number,
    overrides: Map<string, { gain: number; muted: boolean }>,
    destinationMix = mix,
  ): Instance | undefined {
    if (track.kind === "file" && owner.progressive) return;
    const cleanups: (() => void)[] = [],
      pending: Promise<void>[] = [];
    try {
      const control = overrides.get(track.id) ?? {
        gain: track.gain ?? 1,
        muted: track.muted ?? false,
      };
      if (
        control.muted ||
        control.gain === 0 ||
        !trackSegment(track, projectDuration, from, length)
      )
        return undefined;
      const gain = context.createGain(),
        envelope = context.createGain(),
        pan = context.createStereoPanner();

      gain.gain.value = control.gain;
      pan.pan.value = track.pan ?? 0;
      gain.connect(envelope);
      envelope.connect(pan);
      pan.connect(destinationMix.destination(track));
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
          throw new PreviewBuffering("正在缓冲音频");
        const options = {
          context,
          destination: gain,
          when: at,
          offset: segment.offset,
          duration: segment.duration,
          rate: rate * (track.playbackRate ?? 1),
          pitch: track.pitch, preservePitch: track.preservePitch, stretch: track.stretch,
          ...(track.loop ? { loopStart: track.offset ?? 0, loopEnd: (track.offset ?? 0) + track.loop } : {}),
          onError,
        };
        let voice: { dispose(): void; ready?: Promise<void> };
        if (track.kind === "file")
          voice = owner.files!.play(
            owner.sourceKeys?.get(track.src) ?? track.src,
            options,
          );
        else {
          const { mod, id } = generator(owner, track);
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
            const remaining =
              at + segment.duration / options.rate - context.currentTime;
            if (remaining > 0) {
              timer = setTimeout(finish, remaining * 1000 + 100);
              timeouts.add(timer);
            } else {
              voices.delete(voice);
              voice.dispose();
            }
          };
          let timer = setTimeout(
            finish,
            Math.max(
              0,
              (at + segment.duration / options.rate - context.currentTime) *
                1000,
            ) + 100,
          );
          timeouts.add(timer);
        }
      };
      const timeouts = new Set<ReturnType<typeof setTimeout>>();
      // Non-looping generators schedule their own future chunks. Files use the same bounded source reader.
      const transformedFile = track.kind === "file" && !!(track.pitch || track.preservePitch || track.stretch);
      const selfScheduled = (track.kind === "generated" && !track.loop) || transformedFile;
      const limit =
        offline || selfScheduled
          ? trackEnd
          : Math.min(
              trackEnd,
              from +
                Math.min(
                  LIVE_BUFFER_SECONDS,
                  owner.files?.bufferSeconds(rate, true) ?? LIVE_BUFFER_SECONDS,
                ) *
                  rate,
            );
      if (transformedFile) {
        const s = trackSegment(track, projectDuration, from, limit - from);
        if (s) schedule(s, from);
      } else for (const s of audioSegments(track, projectDuration, from, limit - from)) schedule(s, from);
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
            from +
              Math.max(0, context.currentTime - when) * rate +
              (owner.files?.bufferSeconds(rate) ?? LIVE_LOOKAHEAD_SECONDS) *
                rate,
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
              await owner.files!.prepare(
                owner.sourceKeys?.get(track.src) ?? track.src,
                s.offset,
                s.duration,
                abort.signal,
              );
            else {
              const { mod, id } = generator(owner, track);
              await mod.prepareSegment?.({
                trackId: id,
                context,
                offset: s.offset,
                duration: s.duration,
                rate: rate * (track.playbackRate ?? 1),
                pitch: track.pitch, preservePitch: track.preservePitch, stretch: track.stretch,
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

      return {
        track,
        owner,
        gain,
        envelope,
        pan,
        ready: Promise.all(pending),
        dispose() {
          for (const f of cleanups.splice(0).reverse()) f();
        },
      };
    } catch (error) {
      for (const f of cleanups.splice(0).reverse()) f();
      throw error;
    }
  }
  const dispose = () => {
    if (closed) return;
    closed = true;
    for (const voice of instances.values()) voice.dispose();
    instances.clear();
    mix.dispose();
    for (const [old, timer] of retired) {
      clearTimeout(timer);
      old.dispose();
    }
    retired.clear();
  };
  try {
    for (const track of prepared.tracks) {
      const instance = createTrack(
        track,
        prepared,
        from,
        length,
        when,
        overrides,
      );
      if (instance) instances.set(track.id, instance);
    }
    return {
      dispose,
      ready: Promise.all([mix.ready, ...[...instances.values()].map((v) => v.ready)]),
      setTrack(id: string, control: { gain: number; muted: boolean }) {
        const voice = instances.get(id);
        if (voice)
          smoothAudioParam(
            voice.gain.gain,
            control.muted ? 0 : control.gain,
            context,
          );
        return !!voice;
      },
      async update(
        next: PreparedAudio,
        at: number,
        nextDuration: number,
        anchor: number,
        controls: Map<string, { gain: number; muted: boolean }>,
        signal?: AbortSignal,
        onCommit?: () => void,
        onAccepted?: () => void,
      ) {
        if (closed) throw Error("Audio graph disposed");
        signal?.throwIfAborted();
        const replacements = new Map<string, Instance>();
        const retained = new Set<string>();
        const oldMix = mix;
        // Parameter updates commit only after new voices have become ready. A
        // topology candidate is built independently so failures preserve old DSP.
        const canKeepMix = mix.canUpdateDocument(next.document);
        let candidateMix = canKeepMix
          ? mix
          : buildMixGraph(
              context,
              destination,
              next.document,
              at,
              anchor,
              rate,
            );
        if (candidateMix !== oldMix) candidateMix.setOutput(0, true);
        const oldConnections: { pan: StereoPannerNode; target: AudioNode }[] =
          [];
        try {
          for (const track of next.tracks) {
            const old = instances.get(track.id);
            const sameGenerator =
              track.kind !== "generated" ||
              (old?.track.kind === "generated" &&
                generator(old.owner, old.track).mod ===
                  generator(next, track).mod);
            if (
              old &&
              sameGenerator &&
              nextDuration === projectDuration &&
              audioTrackSourceSignature(old.track, old.owner.project) ===
                audioTrackSourceSignature(track, next.project) &&
              (track.kind !== "file" ||
                (old.track.kind === "file" &&
                  old.owner.sourceKeys?.get(old.track.src) ===
                    next.sourceKeys?.get(track.src)))
            ) {
              retained.add(track.id);
              continue;
            }
            const replacement = createTrack(
              track,
              next,
              at,
              nextDuration - at,
              anchor,
              controls,
              candidateMix,
            );
            if (replacement) replacements.set(track.id, replacement);
          }
          await waitAudioReady(
            Promise.all([candidateMix.ready, ...[...replacements.values()].map((v) => v.ready)]),
            signal,
          );
          signal?.throwIfAborted();
          if (closed) throw Error("Audio graph disposed");
          // Pair the prepared picture and metadata with this audio revision in
          // one synchronous task. Callback failure precedes every DSP mutation.
          onCommit?.();
          if (candidateMix === oldMix) oldMix.updateDocument(next.document);
          else if (oldMix.updateDocument(next.document)) {
            for (const voice of replacements.values()) {
              voice.pan.disconnect();
              voice.pan.connect(oldMix.destination(voice.track));
            }
            candidateMix.dispose();
            candidateMix = oldMix;
          }
          for (const [id, voice] of instances) {
            if (!retained.has(id)) {
              voice.dispose();
              instances.delete(id);
            }
          }
          for (const track of next.tracks) {
            const voice = replacements.get(track.id) ?? instances.get(track.id);
            if (!voice) continue;
            if (retained.has(track.id)) {
              if (candidateMix !== oldMix) {
                oldConnections.push({
                  pan: voice.pan,
                  target: oldMix.destination(voice.track),
                });
                voice.pan.connect(candidateMix.destination(track));
              }
              const control = controls.get(track.id) ?? {
                gain: track.gain ?? 1,
                muted: track.muted ?? false,
              };
              smoothAudioParam(
                voice.gain.gain,
                control.muted ? 0 : control.gain,
                context,
              );
              smoothAudioParam(voice.pan.pan, track.pan ?? 0, context);
              // Do not reset the envelope on a plain gain/pan edit.
              const envelope = (v: AudioTrack) =>
                JSON.stringify([
                  v.automation,
                  v.fadeIn,
                  v.fadeOut,
                  v.fadeOffset,
                  v.fadeDuration,
                ]);
              if (envelope(voice.track) !== envelope(track)) {
                voice.envelope.gain.cancelScheduledValues(context.currentTime);
                scheduleClipEnvelope(
                  voice.envelope.gain,
                  track,
                  at,
                  nextDuration - at,
                  context.currentTime,
                  rate,
                );
              }
              voice.track = track;
            }
            instances.set(track.id, voice);
          }
          mix = candidateMix;
          if (mix !== oldMix) {
            mix.setOutput(1);
            oldMix.setOutput(0);
            const deadline = context.currentTime + 0.08;
            const finish = () => {
              if (closed) return;
              const remaining = deadline - context.currentTime;
              if (remaining > 0) {
                retired.set(oldMix, setTimeout(finish, remaining * 1000 + 10));
                return;
              }
              for (const connection of oldConnections)
                try {
                  connection.pan.disconnect(connection.target);
                } catch {}
              oldMix.dispose();
              retired.delete(oldMix);
            };
            retired.set(oldMix, setTimeout(finish, 90));
          }
          prepared = next;
          projectDuration = nextDuration;
        } catch (error) {
          for (const voice of replacements.values()) voice.dispose();
          if (candidateMix !== oldMix) candidateMix.dispose();
          throw error;
        }
        // Ownership has transferred. Acceptance notifications cannot roll the
        // working graph back if a consumer callback throws.
        onAccepted?.();
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
export class OfflineAudioRenderer {
  private prepared?: Promise<PreparedAudio>;
  private sessionContext?: OfflineAudioContext;
  private abort = new AbortController();
  private rendering: Promise<unknown> = Promise.resolve();
  private effectPcm = new SignalsmithPcmCache();
  constructor(
    private project: AnimationProject,
    private controls = new Map<string, { gain: number; muted: boolean }>(),
    private volume = 1,
  ) {}
  dispose() {
    this.abort.abort(); this.effectPcm.clear();
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
  private async renderChunk(start: number, duration: number): Promise<AudioBuffer> {
    this.abort.signal.throwIfAborted();
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 10)
      throw Error("Audio chunks must be between 0 and 10 seconds");
    const doc = this.project.audioDocument as AudioMixDocument | undefined;
    const processors = [...doc?.master.processors ?? [], ...[...doc?.tracks ?? [], ...doc?.buses ?? []].flatMap(channel => channel.processors)];
    if (!processors.some(processor => processor.type === "tone" && !processor.bypass)) return this.renderGraphChunk(start, duration);
    // Native variable-delay/filter DSP has a sample-block state that depends on context origin.
    // Use fixed source windows so arbitrary export requests share exactly the same PCM/state.
    const sampleRate = 48000, firstFrame = Math.round(start * sampleRate), frames = Math.round(duration * sampleRate);
    const output = new AudioBuffer({ numberOfChannels: 2, length: frames, sampleRate });
    const a = firstFrame / sampleRate, b = (firstFrame + frames) / sampleRate;
    for (let index = Math.max(0, Math.floor((a - 0.01) / 2)); index * 2 - 0.01 < b - 1e-8; index++) {
      const origin = index * 2, windowStart = Math.max(0, origin - 0.01), windowFrames = Math.round((origin + 2.01 - windowStart) * sampleRate);
      const buffer = await this.effectPcm.get(String(index), windowFrames * 8, () => this.renderGraphChunk(windowStart, windowFrames / sampleRate));
      this.abort.signal.throwIfAborted();
      const windowFrame = Math.round(windowStart * sampleRate), begin = Math.max(firstFrame, windowFrame), end = Math.min(firstFrame + frames, windowFrame + buffer.length);
      for (let c = 0; c < 2; c++) {
        const input = buffer.getChannelData(c), samples = output.getChannelData(c);
        for (let frame = begin; frame < end; frame++) {
          const time = frame / sampleRate;
          const weight = index > 0 && time < origin + 0.01 ? Math.sin(Math.max(0, Math.min(1, (time - origin + 0.01) / 0.02)) * Math.PI / 2) ** 2 :
            time > origin + 1.99 ? Math.cos(Math.max(0, Math.min(1, (time - origin - 1.99) / 0.02)) * Math.PI / 2) ** 2 : 1;
          samples[frame - firstFrame] += input[frame - windowFrame] * weight;
        }
      }
    }
    return output;
  }
  private async renderGraphChunk(
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
      mixPreroll(this.project.audioDocument as AudioMixDocument | undefined) +
        (projectAudioTracks(this.project).some(t => t.pitch || t.preservePitch || t.stretch) ? 0.5 : 0),
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
      if (context !== this.sessionContext) for (const mod of new Set(prepared.modules?.values() ?? [])) mod.disposeAudio?.(context);
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
