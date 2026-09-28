import { test, expect } from "@playwright/test";
import { expectSameFrame } from "../helpers/frame-match";
const demos = [
  {
    id: "paper-wings",
    duration: 32,
    times: [0.8, 7.5, 17.8, 27.7, 28.5, 29.2, 31.9],
  },
  {
    id: "sunny-rail",
    duration: 36,
    times: [1.25, 4.45, 10.5, 19, 28.6, 33.2, 35.9],
  },
  {
    id: "tiny-seed",
    duration: 36,
    times: [5.8, 8.2, 14, 20.28, 26.4, 30.8, 35.9],
  },
];
for (const demo of demos)
  test(`${demo.id}: phrase-boundary reverse seeks and complete scored playback`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?debug=1#/film/" + demo.id);
    await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
    await expect(page.getByRole("alert")).toHaveCount(0);
    for (const t of demo.times) {
      const a = await page.evaluate((time) => {
        const api = window.__FRAME_STUDIO__!;
        api.frame(time, false);
        return api.dataURL();
      }, t);
      await page.evaluate(() =>
        window.__FRAME_STUDIO__!.frame(
          window.__FRAME_STUDIO__!.duration,
          false,
        ),
      );
      const again = await page.evaluate((time) => {
        const api = window.__FRAME_STUDIO__!;
        api.frame(time, false);
        return api.dataURL();
      }, t);
      await expectSameFrame(again, a);
      expect(a.length).toBeGreaterThan(8000);
    }
    await page.evaluate(() => window.__FRAME_STUDIO__!.seek(0));
    await page.getByTestId("play-toggle").click();
    await page.waitForFunction(
      () => window.__FRAME_STUDIO__!.getState().time > 0.5,
    );
    expect(
      await page.evaluate(() => window.__FRAME_STUDIO__!.getState().audioState),
    ).toBe("running");
    await page.waitForFunction(
      (duration) => {
        const state = window.__FRAME_STUDIO__!.getState();
        return !state.playing && state.time >= duration - 0.04;
      },
      demo.duration,
      { timeout: (demo.duration + 15) * 1000 },
    );
    const final = await page.evaluate(() => window.__FRAME_STUDIO__!.dataURL());
    await page.waitForTimeout(220);
    expect(await page.evaluate(() => window.__FRAME_STUDIO__!.dataURL())).toBe(
      final,
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
