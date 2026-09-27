import type { Score } from "./score.mjs";
import type { StereoPcm } from "./procedural-audio";

export const SCORE_SAMPLE_RATE = 48000;
export const SCORE_CHUNK_FRAMES = 12288;
export const SCORE_CHUNK_SECONDS = SCORE_CHUNK_FRAMES / SCORE_SAMPLE_RATE;
export interface ScoreChunkRange {
  from: number;
  through: number;
}
export type ScoreWorkerRequest =
  | {
      type: "init";
      score: Score;
      bank: ArrayBuffer;
      foley: StereoPcm;
      levels: { music: number; master: number };
    }
  | { type: "render"; ranges: ScoreChunkRange[] };
export type ScoreWorkerResponse =
  | { type: "ready" }
  | { type: "chunk"; index: number; music: StereoPcm; foley: StereoPcm }
  | { type: "error"; message: string };
