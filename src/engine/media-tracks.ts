import { assetUrl, type AudioTrack } from "./types";
import { trackSegment } from "./audio-graph";
type Control = { gain: number; muted: boolean };
type Entry = {
  track: AudioTrack & { kind: "file" };
  media: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
};

/** Progressive file decoding belongs to the browser media stack. Picture and scheduling
 * still follow the transport clock; waiting on any audible track freezes the whole graph. */
export class MediaTracks {
  private entries = new Map<string, Entry>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = true;
  constructor(
    private tracks: AudioTrack[],
    private context: AudioContext,
    private destination: AudioNode,
    private duration: number,
    private onWaiting: () => void,
    private onError: (error: Error) => void,
  ) {}
  private entry(track: AudioTrack & { kind: "file" }) {
    let entry = this.entries.get(track.id);
    if (!entry) {
      const media = new Audio();
      media.crossOrigin = "anonymous";
      media.preload = "auto";
      media.src = assetUrl(track.src);
      media.preservesPitch = false;
      const source = this.context.createMediaElementSource(media),
        gain = this.context.createGain();
      source.connect(gain);
      gain.connect(this.destination);
      entry = { track, media, source, gain };
      this.entries.set(track.id, entry);
    }
    return entry;
  }
  private async ready(
    entry: Entry,
    position: number,
    rate: number,
    signal?: AbortSignal,
  ) {
    const media = entry.media;
    signal?.throwIfAborted();
    media.playbackRate = rate;
    if (media.readyState >= 1 && position >= media.duration) return;
    const wait = (predicate: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (error?: unknown) => {
          if (done) return;
          done = true;
          clearInterval(timer);
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          error ? reject(error) : resolve();
        };
        const check = () => {
          if (media.error)
            finish(new Error(`音轨 ${entry.track.name} 加载失败，请重试`));
          else if (predicate()) finish();
        };
        const abort = () =>
          finish(signal?.reason || new DOMException("Cancelled", "AbortError"));
        const timer = setInterval(check, 30),
          timeout = setTimeout(
            () =>
              finish(
                new Error(
                  `音轨 ${entry.track.name} 缓冲超时，请检查网络并重试`,
                ),
              ),
            45000,
          );
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else check();
      });
    await wait(() => media.readyState >= 1);
    signal?.throwIfAborted();
    if (position >= media.duration) return;
    if (Math.abs(media.currentTime - position) > 0.035)
      media.currentTime = position;
    await wait(() => !media.seeking && media.readyState >= 3);
  }
  async prepare(
    from: number,
    rate: number,
    controls: Map<string, Control>,
    signal?: AbortSignal,
  ) {
    await Promise.all(
      this.tracks.map(async (track) => {
        const control = controls.get(track.id) || track;
        if (track.kind !== "file" || control.muted || control.gain === 0)
          return;
        const segment = trackSegment(track, this.duration, from, 0.15);
        if (!segment || segment.delay > 0) return;
        await this.ready(this.entry(track), segment.offset, rate*(track.playbackRate??1), signal);
      }),
    );
  }
  start(
    time: () => number,
    rate: number,
    controls: Map<string, Control>,
    when = this.context.currentTime,
  ) {
    this.stop();
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      if (this.context.currentTime < when) return;
      const now = time();
      for (const track of this.tracks) {
        if (track.kind !== "file") continue;
        const control = controls.get(track.id) || {
          gain: track.gain ?? 1,
          muted: track.muted ?? false,
        };
        const segment = trackSegment(track, this.duration, now, 0.02);
        let entry = this.entries.get(track.id);
        if (!segment && !control.muted && control.gain > 0) {
          const upcoming = trackSegment(track, this.duration, now, 6 * rate);
          if (upcoming && upcoming.delay > 0) {
            entry ||= this.entry(track);
            if (
              entry.media.readyState >= 1 &&
              !entry.media.seeking &&
              Math.abs(entry.media.currentTime - upcoming.offset) > 0.035
            )
              entry.media.currentTime = upcoming.offset;
          }
        }
        if (
          !segment ||
          segment.delay > 0 ||
          control.muted ||
          control.gain === 0
        ) {
          entry?.media.pause();
          continue;
        }
        entry ||= this.entry(track);
        const { media, gain } = entry;
        gain.gain.setTargetAtTime(
          control.muted ? 0 : control.gain,
          this.context.currentTime,
          0.012,
        );
        media.playbackRate = rate*(track.playbackRate??1);
        if (media.error) {
          this.onError(new Error(`音轨 ${track.name} 加载失败`));
          return;
        }
        if (media.readyState >= 1 && segment.offset >= media.duration) {
          media.pause();
          continue;
        }
        if (
          media.readyState < 3 ||
          media.seeking ||
          Math.abs(media.currentTime - segment.offset) > 0.15
        ) {
          this.onWaiting();
          return;
        }
        if (media.paused)
          void media.play().catch((error) => {
            if (!this.stopped) this.onError(error);
          });
      }
    };
    this.timer = setInterval(tick, 30);
    tick();
  }
  setTrack(id: string, control: Control) {
    const entry = this.entries.get(id);
    if (entry)
      entry.gain.gain.setTargetAtTime(
        control.muted ? 0 : control.gain,
        this.context.currentTime,
        0.012,
      );
    return !!entry;
  }
  ranges() {
    return Object.fromEntries(
      [...this.entries].map(([id, { media }]) => [
        id,
        Array.from({ length: media.buffered.length }, (_, i) => [
          media.buffered.start(i),
          media.buffered.end(i),
        ]),
      ]),
    );
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const { media } of this.entries.values()) media.pause();
  }
  dispose() {
    this.stop();
    for (const { media, source, gain } of this.entries.values()) {
      media.removeAttribute("src");
      media.load();
      source.disconnect();
      gain.disconnect();
    }
    this.entries.clear();
  }
}
