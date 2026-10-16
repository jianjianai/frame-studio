import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Player } from "../web/workbench/players";
import { TimelineSync } from "../web/workbench/timelineSync";

/** Players on a fake clock: they move only when the test lets time pass. */
function world() {
  let now = 0;
  const all: Fake[] = [];
  class Fake implements Player {
    position: number;
    on = false;
    speed = 1;
    looping = false;
    listeners = new Set<() => void>();
    constructor(
      public label: string,
      public length: number,
      at = 0,
    ) {
      this.position = at;
      all.push(this);
    }
    time = () => this.position;
    duration = () => this.length;
    playing = () => this.on;
    buffering = () => false;
    rate = () => this.speed;
    loop = () => this.looping;
    setLoop = (loop: boolean) => void (this.looping = loop);
    play = () => {
      this.on = true;
      this.emit();
    };
    pause = () => {
      this.on = false;
      this.emit();
    };
    seek = (time: number) => {
      this.position = Math.max(0, Math.min(time, this.length));
      this.emit();
    };
    setRate = (rate: number) => {
      this.speed = rate;
      this.emit();
    };
    subscribe = (listener: () => void) => {
      this.listeners.add(listener);
      return () => void this.listeners.delete(listener);
    };
    emit() {
      for (const listener of [...this.listeners]) listener();
    }
    step(ms: number) {
      if (!this.on) return;
      this.position += (ms / 1000) * this.speed;
      if (this.position >= this.length) {
        this.position = this.length;
        this.on = false;
      }
      this.emit();
    }
  }
  let sync: TimelineSync | undefined;
  return {
    Fake,
    clock: () => now,
    start(players: Fake[]) {
      sync = new TimelineSync(
        players.map((player, index) => ({ id: String(index), player })),
        { now: () => now, timer: false },
      );
      return sync;
    },
    /** Let `ms` pass: players move and report, the sync checks them, 100 ms at a time. */
    pass(ms: number) {
      for (let done = 0; done < ms; done += 100) {
        now += 100;
        for (const player of all) player.step(100);
        sync?.tick();
        vi.advanceTimersByTime(100);
      }
    },
  };
}

const round = (value: number) => Math.round(value * 100) / 100;

describe("timeline sync", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("plays, pauses and moves the others from where each one was when it began", () => {
    const { Fake, start, pass } = world();
    const film = new Fake("成片", 30, 5);
    const sample = new Fake("样片", 4, 0);
    const sync = start([film, sample]);
    film.play();
    expect(sample.on).toBe(true);
    pass(1000);
    expect([round(film.position), round(sample.position)]).toEqual([6, 1]);
    // Dragging the sample's bar moves the film to the same shared time.
    sample.seek(2.5);
    expect(round(film.position)).toBe(7.5);
    expect([film.on, sample.on]).toEqual([true, true]);
    // Pausing either pauses both, at the same shared time.
    pass(300);
    film.pause();
    expect([film.on, sample.on]).toEqual([false, false]);
    expect(round(sample.position - film.position)).toBe(-5);
    // Moving one while paused moves the other, by a single frame too (the arrow keys).
    film.seek(5.5);
    expect(round(sample.position)).toBe(0.5);
    vi.advanceTimersByTime(150);
    film.seek(5.5 + 1 / 30);
    expect(round(sample.position * 30)).toBe(16);
    // Speed follows too.
    film.setRate(0.5);
    expect(sample.speed).toBe(0.5);
    sync.stop();
    film.play();
    expect(sample.on).toBe(false);
  });

  it("lets one wait for its start and stop at its end while the others go on", () => {
    const { Fake, start, pass } = world();
    const film = new Fake("成片", 30, 5);
    const sample = new Fake("样片", 2, 0);
    start([film, sample]);
    // Before the sample's start on the shared timeline: it waits at 0.
    film.seek(3);
    expect([sample.position, sample.on]).toEqual([0, false]);
    film.play();
    expect(sample.on).toBe(false);
    pass(1500);
    expect(sample.on).toBe(false);
    pass(700);
    expect(sample.on).toBe(true);
    expect(round(sample.position)).toBeCloseTo(round(film.position - 5), 1);
    // The sample ends on its own; the film keeps playing.
    pass(2500);
    expect([sample.on, round(sample.position)]).toEqual([false, 2]);
    expect(film.on).toBe(true);
    // Back to before the end: the sample plays again from the same shared time.
    film.seek(6);
    expect([round(sample.position), sample.on]).toEqual([1, true]);
  });

  it("starts the paused ones when one already plays, puts back a drifting one, keeps loops off until it stops", () => {
    const { Fake, start, pass } = world();
    const film = new Fake("成片", 30, 10);
    const video = new Fake("视频", 20, 3);
    video.looping = true;
    film.on = true;
    const sync = start([film, video]);
    expect([video.on, video.looping]).toEqual([true, false]);
    pass(500);
    // The video falls behind without saying so (a slow decoder): the next check puts it back.
    video.position -= 0.6;
    pass(200);
    expect(round(video.position - film.position)).toBe(-7);
    // Its editor went out of sight: it leaves, gets its loop back, and is not driven any more.
    expect(sync.remove("1")).toBe(1);
    expect(video.looping).toBe(true);
    film.pause();
    expect(video.on).toBe(true);
  });

  it("follows a dragged progress bar a few times a second, ending where the drag ended", () => {
    const { Fake, start } = world();
    const film = new Fake("成片", 30, 0);
    const sample = new Fake("样片", 10, 0);
    start([film, sample]);
    const seeks = vi.spyOn(sample, "seek");
    for (let i = 1; i <= 10; i++) film.seek(i * 0.5);
    expect(seeks).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(150);
    expect(seeks).toHaveBeenCalledTimes(2);
    expect(sample.position).toBe(5);
  });
});
