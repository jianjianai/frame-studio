export interface Score {
  id: string;
  duration: number;
  bpm: number;
  meter: number;
  notes: {
    channel: number;
    t: number;
    end: number;
    pitch: number;
    velocity: number;
  }[];
  controls: { t: number; data: number[] }[];
  instruments: {
    channel: number;
    program: number;
    name: string;
    volume: number;
    pan: number;
    reverb: number;
  }[];
  cues: { at: number; label: string }[];
}
export function midiNote(value: string | number): number;
export function scoreEvents(
  score: Score,
): { t: number; data: number[]; priority: number }[];
export function scoreMidi(score: Score): Uint8Array;
