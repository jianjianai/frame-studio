import { test, expect } from "@playwright/test";

test("opaque server preview plays sampled audio without same-origin permission", async ({
  page,
  baseURL,
}) => {
  page.on("console", (m) => {
    if (m.type() === "error") console.log(m.text());
  });
  page.on("pageerror", (e) => console.log("PAGE_ERROR", e.message));
  // Match the capability preview's CORS responses while retaining opaque iframe origin.
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "access-control-allow-origin": "*" },
    });
  });
  await page.goto("/");
  await page.evaluate((url) => {
    const frame = document.createElement("iframe");
    frame.id = "server-preview";
    frame.sandbox.add("allow-scripts");
    frame.src = url + "/?debug=1#/film/tiny-seed";
    frame.style.cssText = "width:1400px;height:950px";
    document.body.replaceChildren(frame);
  }, baseURL!);
  const element = await page.locator("#server-preview").elementHandle();
  const frame = (await element!.contentFrame())!;
  await frame.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
  expect(await frame.evaluate(() => window.origin)).toBe("null");
  await frame.getByTestId("play-toggle").click();
  await frame.waitForFunction(
    () =>
      window.__FRAME_STUDIO__!.getState().time > 0.5 ||
      document.body.innerText.includes("播放未能开始"),
  );
  console.log(
    await frame.evaluate(() => ({
      state: window.__FRAME_STUDIO__?.getState(),
      error: document.querySelector("[role=alert]")?.textContent,
    })),
  );
  expect(
    await frame.evaluate(() => window.__FRAME_STUDIO__!.getState().time),
  ).toBeGreaterThan(0.5);
  expect(
    await frame.evaluate(() => window.__FRAME_STUDIO__!.getState().audioState),
  ).toBe("running");
  await frame.evaluate(() => window.__FRAME_STUDIO__!.pause());
  expect(
    await frame.evaluate(
      () => window.__FRAME_STUDIO__!.getDiagnostics!().errors,
    ),
  ).toEqual([]);
});
