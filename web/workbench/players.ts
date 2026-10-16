import { Observable, type StageController } from "./store";

/**
 * What can play in an editor (the film's preview, a sample, a video or audio file), as the
 * timeline sync drives it. `playing` counts a start that is still buffering.
 */
export interface Player {
  label: string;
  time(): number;
  /** Infinity while not known. */
  duration(): number;
  playing(): boolean;
  buffering(): boolean;
  rate(): number;
  play(): void;
  pause(): void;
  seek(time: number): void;
  setRate(rate: number): void;
  loop(): boolean;
  setLoop(loop: boolean): void;
  /** Called on every change of position, playing, rate. */
  subscribe(listener: () => void): () => void;
}

export function stagePlayer(stage: StageController, label: string): Player {
  const now = () => stage.playback.get();
  return {
    label,
    time: () => now().time,
    duration: () => stage.duration || Infinity,
    playing: () => now().playing || now().buffering,
    buffering: () => now().buffering,
    rate: () => now().rate,
    play: () => void stage.play(),
    pause: () => stage.pause(),
    seek: (time) => void stage.seek(time),
    setRate: (rate) => stage.api?.setRate?.(rate),
    loop: () => now().loop,
    setLoop: (loop) => stage.api?.setLoop?.(loop),
    subscribe: (listener) => stage.playback.subscribe(listener),
  };
}

const MEDIA_EVENTS = ["play", "pause", "playing", "waiting", "seeking", "seeked", "timeupdate", "ratechange", "ended"];

export function mediaPlayer(element: HTMLMediaElement, label: string): Player {
  return {
    label,
    time: () => element.currentTime,
    duration: () => (Number.isFinite(element.duration) ? element.duration : Infinity),
    playing: () => !element.paused && !element.ended,
    buffering: () => !element.paused && element.readyState < 3,
    rate: () => element.playbackRate,
    play: () =>
      void element.play().catch((error: Error) => {
        // Sound the browser holds back (no click on this page yet): play silently rather than not at all.
        if (error.name !== "NotAllowedError") return;
        element.muted = true;
        void element.play().catch(() => {});
      }),
    pause: () => element.pause(),
    seek: (time) => void (element.currentTime = time),
    setRate: (rate) => void (element.playbackRate = rate),
    loop: () => element.loop,
    setLoop: (loop) => void (element.loop = loop),
    subscribe: (listener) => {
      for (const type of MEDIA_EVENTS) element.addEventListener(type, listener);
      return () => {
        for (const type of MEDIA_EVENTS) element.removeEventListener(type, listener);
      };
    },
  };
}

/** The players of the open editors, by id: a document key for stages, an editor id for media files. */
export const players = new Observable<ReadonlyMap<string, Player>>(new Map());

/** Make a player known while its editor is mounted; returns the way to forget it. */
export function registerPlayer(id: string, player: Player) {
  players.set(new Map(players.get()).set(id, player));
  return () => {
    if (players.get().get(id) !== player) return;
    const next = new Map(players.get());
    next.delete(id);
    players.set(next);
  };
}
