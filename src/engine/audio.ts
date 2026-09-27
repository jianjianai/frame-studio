import { Clock } from "./clock";
import { prepareAudio, scheduleAudio, type PreparedAudio } from "./audio-graph";
import { projectAudioTracks, type AnimationProject } from "./types";
export class AudioTransport {
  readonly clock: Clock;
  context?: AudioContext;
  private prepared?: PreparedAudio;
  private recordDestination?: MediaStreamAudioDestinationNode;
  private recordingSilence?: ConstantSourceNode;
  private gain?: GainNode;
  private graph?: { dispose(): void };
  private boundary?: AudioBufferSourceNode;
  private loadPromise?: Promise<void>;
  private closed = false;
  private generation = 0;
  private abort = new AbortController();
  readonly controls = new Map<string, { gain: number; muted: boolean }>();
  volume = 0.65;
  muted = false;
  constructor(private project: AnimationProject) {
    this.clock = new Clock(project.duration, () =>
      this.context ? this.context.currentTime : performance.now() / 1000,
    );
    for (const track of projectAudioTracks(project))
      this.controls.set(track.id, {
        gain: track.gain ?? 1,
        muted: track.muted ?? false,
      });
  }
  async unlock(): Promise<void> {
    if (this.closed) return;
    if (!this.context) {
      const saved = this.clock.time();
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.clock.seek(saved);
      this.applyGain();
    }
    await this.context.resume();
    if (this.closed) return;
    this.loadPromise ??= prepareAudio(
      this.project,
      this.context,
      this.abort.signal,
    )
      .then((prepared) => {
        if (!this.closed) this.prepared = prepared;
      })
      .catch((error) => {
        this.loadPromise = undefined;
        throw error;
      });
    await this.loadPromise;
  }
  async play(): Promise<void> {
    const generation = ++this.generation;
    await this.unlock();
    if (this.closed || generation !== this.generation) return;
    this.clock.play();
    try {
      this.syncSource();
    } catch (error) {
      this.pause();
      throw error;
    }
  }
  pause(): void {
    this.generation++;
    this.clock.pause();
    this.stopSource();
  }
  seek(time: number): void {
    this.clock.seek(time);
    if (this.clock.playing) this.syncSource();
  }
  setRate(rate: number): void {
    this.clock.setRate(rate);
    if (this.clock.playing) this.syncSource();
  }
  setLoop(loop: boolean): void {
    const time = this.clock.time();
    this.clock.loop = loop;
    this.clock.seek(time);
    if (this.clock.playing) this.syncSource();
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
    if (this.clock.playing) this.syncSource();
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
    if (this.boundary) {
      this.boundary.onended = null;
      this.boundary.stop();
      this.boundary.disconnect();
      this.boundary = undefined;
    }
    this.graph?.dispose();
    this.graph = undefined;
  }
  private syncSource(): void {
    this.stopSource();
    if (!this.context || !this.prepared || !this.gain || !this.clock.playing)
      return;
    const offset = this.clock.time(),
      length = this.clock.duration - offset;
    if (length <= 0) return;
    const when = this.context.currentTime;
    this.graph = scheduleAudio(
      this.prepared,
      this.context,
      this.gain,
      this.clock.duration,
      offset,
      length,
      when,
      this.clock.rate,
      this.controls,
    );
    const boundary = this.context.createBufferSource();
    boundary.buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
    boundary.loop = true;
    boundary.connect(this.gain);
    boundary.onended = () => {
      if (!this.closed && this.clock.playing && this.clock.loop)
        this.syncSource();
    };
    boundary.start(when);
    boundary.stop(when + length / this.clock.rate);
    this.boundary = boundary;
  }
  getMediaStream(): MediaStream | undefined {
    if (!this.context || !this.gain) return;
    this.releaseMediaStream();
    this.recordDestination = this.context.createMediaStreamDestination();
    this.gain.connect(this.recordDestination);
    // Keep PCM flowing before playback and across pauses, so short generated clips
    // do not finish before MediaRecorder receives its first audio packet.
    this.recordingSilence = this.context.createConstantSource();
    this.recordingSilence.offset.value = 0;
    this.recordingSilence.connect(this.recordDestination);
    this.recordingSilence.start();
    return this.recordDestination.stream;
  }
  releaseMediaStream(): void {
    this.recordingSilence?.stop();
    this.recordingSilence?.disconnect();
    this.recordingSilence = undefined;
    if (this.recordDestination) {
      this.gain?.disconnect(this.recordDestination);
      this.recordDestination.stream
        .getTracks()
        .forEach((track) => track.stop());
      this.recordDestination = undefined;
    }
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    this.pause();
    this.releaseMediaStream();
    this.prepared = undefined;
    this.gain?.disconnect();
    if (this.context && this.context.state !== "closed")
      await this.context.close();
  }
}
