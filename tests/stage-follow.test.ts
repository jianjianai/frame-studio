import { describe, expect, it } from "vitest";
import { StageController } from "../web/workbench/store";

const snapshot = (playing: boolean) => ({ time: 0, playing, buffering: false, rate: 1, loop: false, volume: 1, muted: false });

/** A controller whose stage only records what it is asked to do. */
function recorded(name: string, calls: string[]) {
  const stage = new StageController();
  Object.defineProperty(stage, "api", { get: () => ({ play: async () => void calls.push(`${name} play`), pause: () => void calls.push(`${name} pause`) }) });
  return stage;
}

describe("stages playing together", () => {
  it("plays a sample compared beside the film along with it, and one stage at a time otherwise", async () => {
    const calls: string[] = [];
    const film = recorded("film", calls),
      sample = recorded("sample", calls),
      tab = recorded("tab", calls);
    sample.follow(film);
    await tab.play();
    await film.play();
    expect(calls).toEqual(["tab play", "tab pause", "film play"]);
    // However the film started (button, keys, timeline), its sample starts too, and the film plays on.
    calls.length = 0;
    film.playback.set(snapshot(true));
    await Promise.resolve();
    expect(calls).toEqual(["tab pause", "sample play"]);
    calls.length = 0;
    film.playback.set(snapshot(false));
    expect(calls).toEqual(["sample pause"]);
    // Another stage playing stops both.
    calls.length = 0;
    await tab.play();
    expect(calls).toEqual(expect.arrayContaining(["film pause", "sample pause", "tab play"]));
    // A closed comparison follows no more.
    sample.dispose();
    calls.length = 0;
    film.playback.set(snapshot(true));
    await Promise.resolve();
    expect(calls).toEqual([]);
  });
});
