import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import { fixture } from "../mcp/helpers.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";

test(
  "portrait preview and embedded export preserve the composition below 320px width",
  { timeout: 120000 },
  async () => {
    const f = fixture({ browser: true });
    const env = {
      FRAME_WORK_PREVIEW: "1",
      FRAME_PROJECT: "test-film",
      VITE_FRAME_PREVIEW_AUDIO: "0",
    };
    const prior = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    let server, browser;
    try {
      const file = f.file("project.ts");
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, "utf8")
          .replace(
            '"id":',
            '"composition": { "width": 900, "height": 2100 },\n  "id":',
          ),
      );
      Object.assign(process.env, env);
      server = await createServer({
        root: f.root,
        configFile: path.join(f.root, "vite.config.ts"),
        server: {
          host: "127.0.0.1",
          port: Number(process.env.FRAME_TEST_PORT || 55310),
          strictPort: true,
        },
        logLevel: "warn",
      });
      await server.listen();
      const url = server.resolvedUrls.local[0];
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.route(url + "review-host", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<script>window.events=[];addEventListener("message",e=>events.push(e.data))</script><iframe src="/"></iframe>',
        }),
      );
      await page.goto(url + "review-host");
      const frame = page.frames().find((frame) => frame !== page.mainFrame());
      await frame.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const size = await frame.evaluate(() =>
        window.__FRAME_STUDIO__.getState(),
      );
      assert.equal(size.width, 548);
      assert.equal(size.height, 1278);
      await page.evaluate(() =>
        document
          .querySelector("iframe")
          .contentWindow.postMessage(
            {
              type: "frame-player-command",
              command: "export-start",
              id: "portrait",
              options: {
                width: 274,
                fps: 12,
                subtitles: true,
                start: 0,
                end: 0.5,
              },
            },
            "*",
          ),
      );
      await page.waitForFunction(
        () =>
          events.some(
            (e) =>
              e.type === "frame-export-state" &&
              ["succeeded", "failed"].includes(e.state),
          ),
        null,
        { timeout: 90000 },
      );
      const result = await page.evaluate(() =>
        events.findLast((e) => e.type === "frame-export-state"),
      );
      assert.equal(result.state, "succeeded", JSON.stringify(result));
      assert.ok(result.bytes > 0, JSON.stringify(result));
      const downloaded = page.waitForEvent("download");
      await page.evaluate(() =>
        document
          .querySelector("iframe")
          .contentWindow.postMessage(
            { type: "frame-player-command", command: "export-download" },
            "*",
          ),
      );
      const target = f.file("exports/portrait.webm");
      await (await downloaded).saveAs(target);
      const media = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            target,
          ],
          { encoding: "utf8", windowsHide: true },
        ),
      );
      assert.deepEqual(media.streams[0], { width: 274, height: 640 });
    } finally {
      await browser?.close();
      await server?.close();
      for (const [key, value] of Object.entries(prior))
        value === undefined
          ? delete process.env[key]
          : (process.env[key] = value);
      f.close();
    }
  },
);
