import { Clock } from "./clock";
import { assetUrl } from "./types";
export class AudioTransport {
  readonly clock: Clock;
  context?: AudioContext;
  private buffer?: AudioBuffer;
  private recordDestination?: MediaStreamAudioDestinationNode;
  private gain?: GainNode;
  private source?: AudioBufferSourceNode;
  private loadPromise?: Promise<void>;
  private closed = false;
  private generation = 0;
  volume = 0.65;
  muted = false;
  constructor(
    duration: number,
    private readonly url?: string,
  ) {
    this.clock = new Clock(duration, () =>
      this.context ? this.context.currentTime : performance.now() / 1000,
    );
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
    if (this.url && !this.buffer) {
      this.loadPromise ??= fetch(assetUrl(this.url))
        .then((r) => {
          if (!r.ok) throw new Error("音轨载入失败：" + r.status);
          return r.arrayBuffer();
        })
        .then((b) => this.context!.decodeAudioData(b))
        .then((b) => {
          if (!this.closed) this.buffer = b;
        })
        .catch((e) => {
          this.loadPromise = undefined;
          throw e;
        });
      await this.loadPromise;
    }
  }
  async play(): Promise<void> {
    const generation = ++this.generation;
    await this.unlock();
    if (this.closed || generation !== this.generation) return;
    this.clock.play();
    this.syncSource();
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
    this.clock.loop = loop;
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
    if (this.source) {
      this.source.stop();
      this.source.disconnect();
      this.source = undefined;
    }
  }
  private syncSource(): void {
    this.stopSource();
    if (!this.context || !this.buffer || !this.gain || !this.clock.playing)
      return;
    const offset = this.clock.time();
    if (offset >= this.clock.duration) return;
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.clock.rate;
    source.loop = this.clock.loop;
    source.loopStart = 0;
    source.loopEnd = this.clock.duration;
    source.connect(this.gain);
    source.start(0, offset);
    this.source = source;
  }
  getMediaStream(): MediaStream | undefined {
    if (!this.context || !this.gain) return;
    this.releaseMediaStream();
    const destination = this.context.createMediaStreamDestination();
    this.recordDestination = destination;
    this.gain.connect(destination);
    return destination.stream;
  }
  releaseMediaStream(): void {
    if (this.recordDestination) {
      this.gain?.disconnect(this.recordDestination);
      this.recordDestination.stream.getTracks().forEach((t) => t.stop());
      this.recordDestination = undefined;
    }
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.pause();
    this.releaseMediaStream();
    if (this.context && this.context.state !== "closed")
      await this.context.close();
  }
}
