import { createSampledScoreAudio } from "../../src/engine/soundfont-audio";
import { sunnyRail } from "./music/score.mjs";
import { foley } from "./music/foley.mjs";
import levels from "./music/mix.json";

const score = sunnyRail();
const audio = createSampledScoreAudio({
  score,
  levels,
  foley: () => foley(score),
  bank: "films/sunny-rail/music/GeneralUser-GS.sf2",
  sha256: "9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe",
});
export const prepareAudio = audio.prepareAudio;
export const prepareSegment = audio.prepareSegment;
export const createAudio = audio.createAudio;
export const disposeAudio = audio.disposeAudio;
