import { describe, expect, it } from "vitest";
import { StageController } from "../web/workbench/store";

/** A controller whose stage only records what it is asked to do. */
function recorded(name: string, calls: string[]) {
  const stage = new StageController();
  Object.defineProperty(stage, "api", { get: () => ({ play: async () => void calls.push(`${name} play`), pause: () => void calls.push(`${name} pause`) }) });
  return stage;
}

describe("stages playing", () => {
  it("lets stages side by side play together and stops the ones out of sight", async () => {
    const calls: string[] = [];
    const film = recorded("film", calls),
      sample = recorded("sample", calls),
      hidden = recorded("hidden", calls);
    hidden.visible = false;
    await film.play();
    await sample.play();
    expect(calls).toEqual(["hidden pause", "film play", "hidden pause", "sample play"]);
    hidden.dispose();
    calls.length = 0;
    film.visible = false;
    await sample.play();
    expect(calls).toEqual(["film pause", "sample play"]);
  });
});
