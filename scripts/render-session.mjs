import { createServer } from "vite";
import { launchBrowser } from "./browser.mjs";

/** One owned browser/server per invocation. Never reuse an unknown running service. */
export async function createRenderSession({
  root = process.cwd(),
  width = 1280,
} = {}) {
  let server, browser;
  const close = async () => {
    try {
      await browser?.close();
    } finally {
      await server?.close();
    }
  };
  try {
    server = await createServer({
      root,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
    });
    await server.listen();
    const origin = "http://127.0.0.1:" + server.httpServer.address().port;
    browser = await launchBrowser();
    return {
      close,
      async page(id) {
        const page = await browser.newPage({
          viewport: { width, height: (width * 9) / 16 },
          deviceScaleFactor: 1,
        });
        try {
          page.on("pageerror", (error) =>
            console.error("[browser]", error.message),
          );
          await page.goto(
            origin + "/?render=" + encodeURIComponent(id) + "&width=" + width,
            { waitUntil: "networkidle" },
          );
          await page.waitForFunction(
            () =>
              window.__FRAME_STUDIO__?.ready ||
              document.querySelector('[role="alert"]'),
            {},
            { timeout: 60000 },
          );
          if (!(await page.evaluate(() => window.__FRAME_STUDIO__?.ready)))
            throw new Error(await page.locator('[role="alert"]').innerText());
          return page;
        } catch (error) {
          await page.close();
          throw error;
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function framePng(page, time, subtitles = true) {
  const data = await page.evaluate(
    ({ time, subtitles }) => {
      window.__FRAME_STUDIO__.frame(time, subtitles);
      return window.__FRAME_STUDIO__.dataURL().split(",")[1];
    },
    { time, subtitles },
  );
  return Buffer.from(data, "base64");
}
