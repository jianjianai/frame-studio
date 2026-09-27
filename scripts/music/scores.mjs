import { paperWings } from "../../projects/paper-wings/score.mjs";
export { paperWings };
import { sunnyRail } from "../../projects/sunny-rail/score.mjs";
export { sunnyRail };
import { tinySeed } from "../../projects/tiny-seed/score.mjs";
export { tinySeed };
export { midiNote, scoreEvents, scoreMidi } from "../../src/engine/score.mjs";
export const allScores = () => [paperWings(), sunnyRail(), tinySeed()];
