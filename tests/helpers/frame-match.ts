import { expect } from "@playwright/test";
import sharp from "sharp";

/** Ignore only sparse one-level GPU color rounding, not animation differences. */
export async function expectSameFrame(actual: string, expected: string) {
  if (actual === expected) return;
  const [first, repeated] = await Promise.all(
    [expected, actual].map((image) =>
      sharp(Buffer.from(image.split(",")[1], "base64"))
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ),
  );
  expect(repeated.info).toEqual(first.info);
  let differing = 0,
    maxDelta = 0;
  for (let i = 0; i < first.data.length; i++) {
    const delta = Math.abs(first.data[i] - repeated.data[i]);
    if (delta) differing++;
    maxDelta = Math.max(maxDelta, delta);
  }
  expect(maxDelta, "Reverse seek changed pixel colors").toBeLessThanOrEqual(1);
  expect(
    differing / first.data.length,
    "Reverse seek changed more than 0.01% of channels",
  ).toBeLessThan(0.0001);
}
