import type { Player } from "./players";

/** A playing position this far (s) from where playing would have put it was moved by someone. */
const JUMP = 0.35;
/** A standing one that moved more than this (s) was moved (stages and media stand exactly still). */
const NUDGE = 0.01;
/** Playing players further than this (s) from the shared time are put back. */
const DRIFT = 0.25;
/** A player that stopped this close (s) to its end ended by itself; it was not paused. */
const END = 0.08;
/** How long (ms) the echo of our own command is waited for. */
const ECHO_MS = 4000;
/** While a progress bar is dragged the others follow at most this often (ms), and at the end. */
const FOLLOW_MS = 120;

interface Command {
  time?: number;
  playing?: boolean;
  rate?: number;
}
interface Member {
  id: string;
  player: Player;
  /** Its time when the sync began: the shared time is 0 there. */
  base: number;
  last: { time: number; wall: number; playing: boolean; rate: number };
  expect: (Command & { until: number }) | null;
  loop: boolean;
  unsubscribe: () => void;
}

export interface SyncOptions {
  now?: () => number;
  /** Check the players a few times a second (tests drive `tick` themselves). */
  timer?: boolean;
}

/**
 * Several players on one shared timeline. Each one's time when the sync began is its zero; from
 * then on playing, pausing, dragging the progress bar or changing the speed of any of them does
 * the same to the others at the same shared time. One whose shared time falls outside its own
 * length waits at its start or stays at its end; whichever is playing leads, and the others are
 * kept within a fraction of a second of it.
 */
export class TimelineSync {
  private members: Member[];
  private playing: boolean;
  private leader: Member | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private follow?: { from: Member; timer?: ReturnType<typeof setTimeout>; again: boolean };
  private stopped = false;
  private now: () => number;

  constructor(entries: { id: string; player: Player }[], options: SyncOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    const wall = this.now();
    this.members = entries.map(({ id, player }) => ({
      id,
      player,
      base: player.time(),
      last: { time: player.time(), wall, playing: player.playing(), rate: player.rate() },
      expect: null,
      loop: player.loop(),
      unsubscribe: () => {},
    }));
    // A loop would jump back to the start by itself and take the others with it.
    for (const member of this.members) if (member.loop) member.player.setLoop(false);
    const lead = this.members.find((member) => member.player.playing()) ?? null;
    this.playing = Boolean(lead);
    this.leader = lead;
    if (lead) for (const member of this.others(lead)) this.place(member, lead.player.time() - lead.base);
    for (const member of this.members) member.unsubscribe = member.player.subscribe(() => this.changed(member));
    if (options.timer !== false) this.timer = setInterval(() => this.tick(), 200);
  }

  get ids() {
    return this.members.map((member) => member.id);
  }
  /** Each player's time at the shared zero. */
  get bases() {
    return this.members.map((member) => ({ id: member.id, label: member.player.label, base: member.base }));
  }

  /** A player leaves (its editor went out of sight); returns how many are left. */
  remove(id: string) {
    const member = this.members.find((item) => item.id === id);
    if (!member) return this.members.length;
    this.release(member);
    this.members = this.members.filter((item) => item !== member);
    if (this.leader === member) this.leader = null;
    return this.members.length;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.follow?.timer);
    for (const member of this.members) this.release(member);
    this.members = [];
  }

  private release(member: Member) {
    member.unsubscribe();
    if (member.loop) member.player.setLoop(true);
  }

  private others(member: Member) {
    return this.members.filter((item) => item !== member);
  }

  /** Where a player is now, from its last report (stages report a few times a second). */
  private estimate(member: Member) {
    const last = member.last;
    return last.playing && !member.player.buffering() ? last.time + ((this.now() - last.wall) / 1000) * last.rate : last.time;
  }

  private ended(member: Member) {
    return member.player.time() >= member.player.duration() - END;
  }

  private changed(member: Member) {
    if (this.stopped) return;
    const player = member.player;
    const wall = this.now();
    const time = player.time();
    const playing = player.playing();
    const rate = player.rate();
    const last = member.last;
    const expected = last.playing ? last.time + ((wall - last.wall) / 1000) * last.rate : last.time;
    member.last = { time, wall, playing, rate };
    // What our own command asked for, seen arriving: not someone else's doing.
    const echo = member.expect && wall < member.expect.until ? member.expect : null;
    let ours = { time: false, playing: false, rate: false };
    if (echo) {
      ours = {
        time: echo.time !== undefined && Math.abs(time - echo.time) <= (playing ? JUMP : 0.05),
        playing: echo.playing !== undefined && echo.playing === playing,
        rate: echo.rate !== undefined && echo.rate === rate,
      };
      if (ours.time) echo.time = undefined;
      if (ours.playing) echo.playing = undefined;
      if (ours.rate) echo.rate = undefined;
    }
    if (rate !== last.rate && !ours.rate) for (const other of this.others(member)) this.command(other, { rate });
    if (playing !== last.playing) {
      if (ours.playing) return;
      // It reached its end by itself: the others go on.
      if (!playing && this.ended(member)) return this.handOver(member);
      return this.setPlaying(playing, member);
    }
    const moved = Math.abs(time - expected) > (last.playing || playing ? JUMP : NUDGE);
    if (moved && !ours.time) this.moved(member);
  }

  /** Someone played or paused `from`: the others do the same at the same shared time. */
  private setPlaying(playing: boolean, from: Member) {
    this.playing = playing;
    this.leader = playing ? from : null;
    const shared = from.player.time() - from.base;
    for (const other of this.others(from)) this.place(other, shared);
  }

  /** Someone moved `from` (a progress bar, a timeline click): the others follow, a few times a second while it is dragged. */
  private moved(from: Member) {
    if (this.playing) this.leader = from;
    if (this.follow?.timer) {
      this.follow.from = from;
      this.follow.again = true;
      return;
    }
    this.align(from);
    const follow: NonNullable<TimelineSync["follow"]> = { from, again: false };
    follow.timer = setTimeout(() => {
      this.follow = undefined;
      if (follow.again && !this.stopped && this.members.includes(follow.from)) this.align(follow.from);
    }, FOLLOW_MS);
    this.follow = follow;
  }

  private align(from: Member) {
    const shared = from.player.time() - from.base;
    for (const other of this.others(from)) this.place(other, shared);
  }

  /** A player that ended hands the lead to one still playing; when none is, everything has ended. */
  private handOver(member: Member) {
    if (this.leader !== member) return;
    this.leader = this.members.find((item) => item !== member && item.player.playing()) ?? null;
    if (!this.leader) this.playing = false;
  }

  /** Put a player where shared time `shared` puts it: playing (when the others play) only within its length. */
  private place(member: Member, shared: number) {
    const target = member.base + shared;
    const end = member.player.duration();
    const within = target >= 0 && target < end - END;
    const at = Math.max(0, Math.min(target, end));
    const command: Command = {};
    // Standing, frames are compared: exactly there. Playing, a hair off is not worth a seek's hiccup.
    if (Math.abs(member.player.time() - at) > (this.playing ? 0.04 : 0.002)) command.time = at;
    const play = this.playing && within;
    if (member.player.playing() !== play) command.playing = play;
    if (command.time !== undefined || command.playing !== undefined) this.command(member, command);
  }

  private command(member: Member, command: Command) {
    member.expect = { ...command, until: this.now() + ECHO_MS };
    if (command.rate !== undefined) member.player.setRate(command.rate);
    if (command.time !== undefined) member.player.seek(command.time);
    if (command.playing === true) member.player.play();
    else if (command.playing === false) member.player.pause();
  }

  /** While playing: start the ones whose turn came, stop the ones past their end, put back the ones that drifted. */
  tick() {
    if (this.stopped || !this.playing) return;
    if (!this.leader || !this.leader.player.playing()) this.leader = this.members.find((member) => member.player.playing() && !this.ended(member)) ?? null;
    const leader = this.leader;
    if (!leader) {
      this.playing = false;
      return;
    }
    // A player still loading holds everyone's place; they are put right once it plays.
    if (this.members.some((member) => member.player.buffering())) return;
    const shared = this.estimate(leader) - leader.base;
    const wall = this.now();
    for (const other of this.others(leader)) {
      if (other.expect && wall < other.expect.until && (other.expect.time !== undefined || other.expect.playing !== undefined)) continue;
      const target = other.base + shared;
      const end = other.player.duration();
      if (target < 0 || target >= end - END) {
        if (other.player.playing()) this.command(other, { playing: false, time: Math.max(0, Math.min(target, end)) });
        continue;
      }
      if (!other.player.playing()) this.command(other, { time: target, playing: true });
      else if (Math.abs(this.estimate(other) - target) > DRIFT) this.command(other, { time: target });
    }
  }
}
