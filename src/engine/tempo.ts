/**
 * The work's musical grid (project.ts `tempo`). The stage, the render page and the resource
 * preview set it when they load a work, so material library code can follow the beat of any
 * work it is used in. Read it while drawing, not at import time: a module evaluated once
 * would keep the grid of the moment it was first imported.
 */
export interface Tempo {
  bpm: number;
  /** Work time (seconds) of the first beat, the downbeat of bar 0. */
  firstBeat: number;
  beatsPerBar: number;
}

const DEFAULT_TEMPO: Tempo = { bpm: 120, firstBeat: 0, beatsPerBar: 4 };
const holder = globalThis as { __FRAME_TEMPO__?: Tempo };

export function setTempo(tempo?: Partial<Tempo>) {
  holder.__FRAME_TEMPO__ = { ...DEFAULT_TEMPO, ...tempo };
}
/** The current grid; 120 BPM from 0 s in 4/4 when the work has none. */
export const tempo = (): Tempo => holder.__FRAME_TEMPO__ ?? DEFAULT_TEMPO;
/** Seconds per beat. */
export const beatLength = () => 60 / tempo().bpm;
/** Time of beat k (fractions allowed: beatAt(2.5) is the off-beat after beat 2). */
export const beatAt = (k: number) => tempo().firstBeat + k * beatLength();
/** Time of the downbeat of bar n. */
export const barAt = (n: number) => beatAt(n * tempo().beatsPerBar);
/** Beats since the first beat, fractional. */
export const beatIndex = (time: number) => (time - tempo().firstBeat) / beatLength();
/** Seconds since the most recent beat. */
export const sinceBeat = (time: number) => time - beatAt(Math.floor(beatIndex(time)));
/** 1 on every beat, decaying quickly. */
export const pulse = (time: number, decay = 7) => Math.exp(-decay * sinceBeat(time));
