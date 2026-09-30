import { clamp } from "./math";
/** Pure, deterministic transport. The driver supplies one clock for both sound and picture. */
export class Clock {
  private anchorTime = 0;
  private anchorNow = 0;
  playing = false;
  rate = 1;
  loop = false;
  constructor(
    public duration: number,
    private readonly now: () => number,
  ) {
    if (!(duration > 0) || !Number.isFinite(duration))
      throw new Error("Invalid duration");
  }
  time(): number {
    const raw =
      this.anchorTime +
      (this.playing ? Math.max(0, this.now() - this.anchorNow) * this.rate : 0);
    return this.loop && this.playing
      ? ((raw % this.duration) + this.duration) % this.duration
      : clamp(raw, 0, this.duration);
  }
  play(delay = 0): void {
    if (this.playing) return;
    if (this.anchorTime >= this.duration) this.anchorTime = 0;
    this.anchorNow = this.now() + delay;
    this.playing = true;
  }
  pause(): void {
    this.anchorTime = this.time();
    this.playing = false;
  }
  seek(t: number): void {
    this.anchorTime = clamp(t, 0, this.duration);
    this.anchorNow = this.now();
  }
  setDuration(duration: number): void {
    if (!(duration > 0) || !Number.isFinite(duration))
      throw new Error("Invalid duration");
    const time = this.time();
    this.duration = duration;
    this.seek(time);
  }
  setRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("Invalid rate");
    this.anchorTime = this.time();
    this.anchorNow = this.now();
    this.rate = rate;
  }
}
