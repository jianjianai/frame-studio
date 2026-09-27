import { createSampledScoreAudio } from "../../src/engine/soundfont-audio";
import { paperWings } from "./music/score.mjs";
import { foley } from "./music/foley.mjs";

const score = paperWings();
const audio = createSampledScoreAudio({
  score,
  foley: () => foley(score),
  bank: "films/paper-wings/music/GeneralUser-GS.sf2",
  sha256: "9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe",
});
export const prepareAudio = audio.prepareAudio;
export const createAudio = audio.createAudio;
