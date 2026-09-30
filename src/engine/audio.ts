import { Clock } from "./clock";
import { MediaTracks } from "./media-tracks";
import { PreviewBuffering } from "./preview-audio";
import {
  prepareAudio,
  disposePreparedAudio,
  prepareAudioSegment,
  scheduleAudio,
  type PreparedAudio,
} from "./audio-graph";
import { projectAudioTracks, type AnimationProject } from "./types";
export class AudioTransport {
  readonly clock: Clock;
  context?: AudioContext;
  private prepared?: PreparedAudio;
  private gain?: GainNode;
  private graph?: {
    dispose(): void;
    setTrack?(id: string, control: { gain: number; muted: boolean }): boolean;
  };
  private media?: MediaTracks;
  private boundary?: AudioBufferSourceNode;
  private loadPromise?: Promise<void>;
  private closed = false;
  private generation = 0;
  private requestedPlay = false;
  private abort = new AbortController();
  private preparation?: AbortController;
  private scheduling: Promise<void> = Promise.resolve();
  private preloadEnabled = false;
  readonly controls = new Map<string, { gain: number; muted: boolean }>();
  buffering = false;
  volume = 0.65;
  muted = false;
  prepareMs = 0;
  private visualBuffering = false;
  private visualWaiters = new Set<() => void>();
  setVisualBuffering(waiting: boolean) {
    this.visualBuffering=waiting;
    if (!waiting) { for(const resolve of this.visualWaiters)resolve();this.visualWaiters.clear(); }
    else if(this.requestedPlay && !this.buffering)this.restart();
  }
  private async waitForVisual(signal: AbortSignal) {
    signal.throwIfAborted();
    if(!this.visualBuffering)return;
    await new Promise<void>((resolve,reject)=>{
      const done=()=>{signal.removeEventListener('abort',abort);this.visualWaiters.delete(done);resolve();};
      const abort=()=>{this.visualWaiters.delete(done);reject(signal.reason);};
      this.visualWaiters.add(done);signal.addEventListener('abort',abort,{once:true});
    });
  }
  async preparePosition(signal?: AbortSignal): Promise<void> {
    const began = performance.now();
    await this.load();
    signal?.throwIfAborted();
    if (this.prepared && this.context)
      await prepareAudioSegment(
        this.prepared,
        this.context,
        this.clock.duration,
        this.clock.time(),
        this.clock.duration - this.clock.time(),
        this.clock.rate,
        this.controls,
        signal,
      );
    await this.media?.prepare(
      this.clock.time(),
      this.clock.rate,
      this.controls,
      signal,
    );
    this.prepareMs = performance.now() - began;
  }
  constructor(
    private project: AnimationProject,
    private onError?: (error: Error) => void,
  ) {
    this.clock = new Clock(project.duration, () =>
      this.context ? this.context.currentTime : performance.now() / 1000,
    );
    for (const track of projectAudioTracks(project))
      this.controls.set(track.id, {
        gain: track.gain ?? 1,
        muted: track.muted ?? false,
      });
  }
  private createContext(): void {
    if (!this.context) {
      const saved = this.clock.time();
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.clock.seek(saved);
      this.applyGain();
      this.media = this.project.audioDocument ? undefined : new MediaTracks(
        projectAudioTracks(this.project),
        this.context,
        this.gain,
        this.project.duration,
        () => {
          if (this.requestedPlay && !this.buffering) this.restart();
        },
        (error) => this.report(error, this.generation),
      );
    }
  }
  private async load(): Promise<void> {
    if (this.closed) return;
    this.createContext();
    this.loadPromise ??= prepareAudio(
      this.project,
      this.context!,
      this.abort.signal,
      true,
    )
      .then((prepared) => {
        if (!this.closed) {
          this.prepared = prepared;
          if (prepared.preview) {
            this.media?.dispose();
            this.media = undefined;
          }
        }
      })
      .catch((error) => {
        this.loadPromise = undefined;
        throw error;
      });
    await this.loadPromise;
  }
  async unlock(): Promise<void> {
    if (this.closed) return;
    this.createContext();
    await this.context!.resume();
    await this.load();
  }
  /** Prepare the selected position while paused; never resume the audio context. */
  preload(): void {
    this.preloadEnabled = true;
    if (this.closed || this.requestedPlay || !this.controls.size) return;
    this.preparation?.abort();
    const request = (this.preparation = new AbortController());
    const offset = this.clock.time();
    void this.load()
      .then(() => {
        if (
          this.closed ||
          request.signal.aborted ||
          this.requestedPlay ||
          !this.prepared
        )
          return;
        return Promise.all([
          this.media?.prepare(
            offset,
            this.clock.rate,
            this.controls,
            request.signal,
          ),
          prepareAudioSegment(
            this.prepared,
            this.context!,
            this.clock.duration,
            offset,
            this.clock.duration - offset,
            this.clock.rate,
            this.controls,
            request.signal,
          ),
        ]);
      })
      .catch(() => {
        // Playback will retry initialization and report actionable errors itself.
      });
  }
  async play(): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    this.preparation?.abort();
    this.requestedPlay = true;
    this.buffering = true;
    this.clock.pause();
    if (this.clock.time() >= this.clock.duration) this.clock.seek(0);
    this.stopSource();
    try {
      await this.unlock();
      if (this.closed || generation !== this.generation) return;
      await this.startSource(generation);
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      this.pause();
      throw error;
    }
  }
  pause(): void {
    this.generation++;
    this.preparation?.abort();
    this.requestedPlay = false;
    this.buffering = false;
    this.clock.pause();
    this.stopSource();
  }
  seek(time: number): void {
    this.clock.seek(time);
    if (this.requestedPlay) this.restart();
    else if (this.preloadEnabled) this.preload();
  }
  setRate(rate: number): void {
    this.clock.setRate(rate);
    if (this.requestedPlay) this.restart();
  }
  setLoop(loop: boolean): void {
    const time = this.clock.time();
    this.clock.loop = loop;
    this.clock.seek(time);
    if (this.requestedPlay) this.restart();
  }
  setTrack(
    id: string,
    change: Partial<{ gain: number; muted: boolean }>,
  ): void {
    const previous = this.controls.get(id);
    if (!previous) throw new Error("未知音轨: " + id);
    const control = { ...previous, ...change };
    if (!Number.isFinite(control.gain) || control.gain < 0 || control.gain > 4)
      throw new Error("无效音轨音量");
    this.controls.set(id, control);
    const mediaAdjusted = this.media?.setTrack(id, control);
    const adjusted = this.graph?.setTrack?.(id, control) || mediaAdjusted;
    if (this.requestedPlay && !adjusted && !control.muted && control.gain > 0)
      this.restart();
  }
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.applyGain();
  }
  setMuted(v: boolean): void {
    this.muted = v;
    this.applyGain();
  }
  private applyGain(): void {
    if (this.gain && this.context)
      this.gain.gain.setTargetAtTime(
        this.muted ? 0 : this.volume,
        this.context.currentTime,
        0.012,
      );
  }
  private stopSource(): void {
    this.media?.stop();
    if (this.boundary) {
      this.boundary.onended = null;
      this.boundary.stop();
      this.boundary.disconnect();
      this.boundary = undefined;
    }
    this.graph?.dispose();
    this.graph = undefined;
  }
  private report(error: unknown, generation: number): void {
    if (this.closed || generation !== this.generation) return;
    if (error instanceof PreviewBuffering && this.requestedPlay) {
      // Defer until scheduleAudio has assigned the graph so restart can dispose it.
      queueMicrotask(() => {
        if (generation === this.generation) this.restart();
      });
      return;
    }
    this.pause();
    this.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
  private restart(): void {
    const generation = ++this.generation;
    this.preparation?.abort();
    this.clock.pause();
    this.stopSource();
    if (this.clock.time() >= this.clock.duration) {
      if (this.clock.loop) this.clock.seek(0);
      else {
        this.pause();
        return;
      }
    }
    if (!this.prepared) {
      const pending = this.play();
      // play() only rejects for the current request and already pauses on failure.
      void pending.catch((error) => {
        if (!this.closed)
          this.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
      });
      return;
    }
    try {
      const pending = this.startSource(generation);
      if (pending)
        void pending.catch((error) => this.report(error, generation));
    } catch (error) {
      this.report(error, generation);
    }
  }
  private async startSource(generation: number): Promise<void> {
    if (!this.context || !this.prepared || !this.gain) return;
    const request = (this.preparation = new AbortController());
    const context = this.context, prepared = this.prepared, gain = this.gain;
    const current = () => !this.closed && generation === this.generation &&
      this.requestedPlay && !request.signal.aborted;
    const offset = this.clock.time(), length = this.clock.duration - offset;
    this.buffering = true;
    await Promise.all([
      this.waitForVisual(request.signal),
      this.media?.prepare(offset, this.clock.rate, this.controls, request.signal),
      prepareAudioSegment(prepared, context, this.clock.duration, offset, length,
        this.clock.rate, this.controls, request.signal),
    ]);
    // Serialize context transitions across seeks/rate changes. A stale request never
    // resumes or replaces a newer graph, and pause aborts an unfinished ready promise.
    const scheduled = this.scheduling.catch(() => {}).then(async () => {
      if (!current()) return;
      await context.suspend();
      if (!current()) return;
      // Freeze the shared audio clock while synchronous generators create buffers.
      // Every track and the picture receive the same future anchor after readiness.
      const lead = 0.04, when = context.currentTime + lead;
      const graph = scheduleAudio(prepared, context, gain, this.clock.duration,
        offset, length, when, this.clock.rate, this.controls,
        (error) => this.report(error, generation));
      this.graph = graph;
      let cancel: (() => void) | undefined;
      try {
        const aborted = new Promise<never>((_, reject) => {
          cancel = () => reject(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
          request.signal.addEventListener("abort", cancel, { once: true });
          if (request.signal.aborted) cancel();
        });
        await Promise.race([graph.ready, aborted]);
        if (!current()) return;
        const boundary = context.createBufferSource();
        boundary.buffer = context.createBuffer(1, 1, context.sampleRate);
        boundary.loop = true;
        boundary.connect(gain);
        boundary.onended = () => {
          if (!current()) return;
          if (this.clock.loop) this.restart();
          else {
            this.pause();
            this.clock.seek(this.clock.duration);
          }
        };
        boundary.start(when);
        boundary.stop(when + length / this.clock.rate);
        this.boundary = boundary;
        this.clock.play(lead);
        this.media?.start(() => this.clock.time(), this.clock.rate, this.controls, when);
        await context.resume();
        if (current()) this.buffering = false;
      } finally {
        if (cancel) request.signal.removeEventListener("abort", cancel);
        if (!current()) {
          graph.dispose();
          if (this.graph === graph) this.graph = undefined;
        }
      }
    });
    this.scheduling = scheduled;
    await scheduled;
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.pause();
    this.abort.abort();
    this.media?.dispose();
    if (this.context && this.prepared) disposePreparedAudio(this.prepared,this.context);
    this.prepared = undefined;
    this.gain?.disconnect();
    if (this.context && this.context.state !== "closed")
      await this.context.close();
  }
  diagnostics(){return {files:this.prepared?.files?.diagnostics()??null,mode:this.project.audioDocument?"direct":this.prepared?.preview?"proxy":"legacy"};}
  bufferedRanges() {
    return this.media?.ranges() || {};
  }
}
