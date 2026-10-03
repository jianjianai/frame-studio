import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import { launchBrowser } from "../../scripts/browser.mjs";
import { repo as root } from "../mcp/helpers.mjs";

test(
  "V8 real Range video: canceled and superseded seeks retain the decoder, shared owners and aggregate cache remain bounded under weak network",
  { timeout: 180000 },
  async (t) => {
    const owned = path.join(root, ".cache/v8-media-browser", randomUUID());
    fs.mkdirSync(owned, { recursive: true });
    const movie = path.join(owned, "fixture.mp4");
    execFileSync(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=12:duration=24",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=437:sample_rate=48000:duration=24",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-b:v",
        "120k",
        "-maxrate",
        "160k",
        "-bufsize",
        "320k",
        "-g",
        "24",
        "-c:a",
        "aac",
        "-b:a",
        "48k",
        "-movflags",
        "+faststart",
        "-y",
        movie,
      ],
      { timeout: 45000, windowsHide: true },
    );
    let server, browser;
    const httpRanges = [];
    try {
      server = await createServer({
        configFile: false,
        root,
        cacheDir: path.join(owned, "vite"),
        appType: "custom",
        logLevel: "error",
        optimizeDeps: { include: ["mediabunny", "zod"] },
        server: { host: "127.0.0.1", port: 0, watch: null },
        plugins: [
          {
            name: "v8-owned-video-fixture",
            configureServer(vite) {
              vite.middlewares.use((request, response, next) => {
                if (request.url === "/__v8-media") {
                  response.setHeader("Content-Type", "text/html");
                  response.end(
                    '<!doctype html><html><body><canvas id="output"></canvas><script type="module">import * as media from "/src/engine/media-source.ts";window.media=media;</script></body></html>',
                  );
                } else if (request.url?.startsWith("/__v8-video.mp4")) {
                  const bytes = fs.statSync(movie).size;
                  response.setHeader("Content-Type", "video/mp4");
                  response.setHeader("Accept-Ranges", "bytes");
                  response.setHeader(
                    "Cache-Control",
                    "public,max-age=31536000,immutable",
                  );
                  const range = /^bytes=(\d+)-(\d*)$/.exec(
                    request.headers.range || "",
                  );
                  const start = range ? Number(range[1]) : 0,
                    end =
                      range && range[2]
                        ? Math.min(Number(range[2]), bytes - 1)
                        : bytes - 1;
                  httpRanges.push({ start, end });
                  response.statusCode = range ? 206 : 200;
                  if (range)
                    response.setHeader(
                      "Content-Range",
                      `bytes ${start}-${end}/${bytes}`,
                    );
                  response.setHeader("Content-Length", end - start + 1);
                  const stream = fs.createReadStream(movie, { start, end });
                  response.on("close", () => stream.destroy());
                  stream.pipe(response);
                } else next();
              });
            },
          },
        ],
      });
      await server.listen();
      const address = server.httpServer.address(),
        origin = "http://127.0.0.1:" + address.port;
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(origin + "/__v8-media");
      await page.waitForFunction(() => window.media?.openVideoSource);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 600,
        downloadThroughput: 96 * 1024,
        uploadThroughput: 48 * 1024,
        connectionType: "cellular3g",
      });
      const started = Date.now();
      const result = await page.evaluate(async () => {
        const {
          openVideoSource,
          videoSourceDiagnostics,
          clearVideoSourceCache,
        } = window.media;
        const source = await openVideoSource("__v8-video.mp4?v=fixture", 160);
        const first = await source.frame(0);
        const copy = (frame) => {
          const canvas = document.createElement("canvas");
          canvas.width = frame.width;
          canvas.height = frame.height;
          canvas.getContext("2d").drawImage(frame.image, 0, 0);
          const bytes = canvas
            .getContext("2d")
            .getImageData(0, 0, frame.width, frame.height).data;
          let checksum = 0;
          for (let i = 0; i < bytes.length; i += 97)
            checksum = (checksum * 31 + bytes[i]) >>> 0;
          return { width: frame.width, height: frame.height, checksum };
        };
        const start = copy(first);
        const cancellation = new AbortController();
        const obsolete = source.frame(16, cancellation.signal).then(
          () => ({ ok: true }),
          (error) => ({ ok: false, name: error.name }),
        );
        cancellation.abort(new DOMException("superseded seek", "AbortError"));
        const aborted = await obsolete;
        const later = copy(await source.frame(11));
        const other = await openVideoSource("__v8-video.mp4?v=fixture", 160);
        const shared = videoSourceDiagnostics();
        const identical = await Promise.all([other.frame(12), other.frame(12)]);
        const equal =
          copy(identical[0]).checksum === copy(identical[1]).checksum;
        // A burst of obsolete seeks cannot destroy the shared decoder or leave all
        // future requests waiting behind a queue of uncancelled decode work.
        const obsoleteSeeks = [];
        for (let i = 0; i < 30; i++) {
          const abort = new AbortController();
          obsoleteSeeks.push(
            source.frame((i % 20) + 0.125, abort.signal).then(
              () => null,
              (error) => error.name,
            ),
          );
          abort.abort(new DOMException("newer selected frame", "AbortError"));
        }
        const names = await Promise.all(obsoleteSeeks);
        const selected = copy(await source.frame(20));
        source.dispose();
        const remaining = copy(await other.frame(4));
        const singleOwner = videoSourceDiagnostics();
        other.dispose();
        clearVideoSourceCache();
        // Decoder iterator cleanup is asynchronous; reservations remain until in-flight decoding releases them.
        for (
          let i = 0;
          i < 100 && videoSourceDiagnostics().reservedDecodedBytes;
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 50));
        const disposed = videoSourceDiagnostics();
        return {
          start,
          later,
          aborted,
          equal,
          names,
          selected,
          remaining,
          shared,
          singleOwner,
          disposed,
        };
      });
      assert.deepEqual(result.aborted, { ok: false, name: "AbortError" });
      assert.equal(result.start.width, 160);
      assert.equal(result.start.height, 90);
      assert.notEqual(
        result.start.checksum,
        result.later.checksum,
        "actual different video time produces different pixels",
      );
      assert.equal(
        result.equal,
        true,
        "duplicate frame requests produce a consistent frame",
      );
      assert.ok(result.names.every((name) => name === "AbortError"));
      assert.equal(
        result.shared.sources,
        1,
        "two scene leases share one immutable video input",
      );
      assert.equal(result.shared.owners, 2);
      assert.equal(
        result.singleOwner.owners,
        1,
        "disposing one owner keeps another decoder lease usable",
      );
      assert.ok(
        result.shared.reservedCacheBytes <= result.shared.cacheBudgetBytes,
      );
      assert.ok(
        result.shared.reservedDecodedBytes <= result.shared.decodedBudgetBytes,
      );
      assert.ok(result.shared.network.active <= result.shared.network.limit);
      assert.equal(result.disposed.sources, 0);
      assert.equal(result.disposed.owners, 0);
      assert.equal(result.disposed.reservedCacheBytes, 0);
      assert.equal(result.disposed.reservedDecodedBytes, 0);
      assert.ok(
        httpRanges.every(
          (range) => range.start >= 0 && range.end >= range.start,
        ),
      );
      assert.ok(
        httpRanges.length < 35,
        "rapid canceled seeks do not fan out into unbounded Range downloads",
      );
      t.diagnostic(
        JSON.stringify({
          elapsedMs: Date.now() - started,
          movieBytes: fs.statSync(movie).size,
          httpRanges: httpRanges.length,
          diagnostics: result.shared,
        }),
      );
    } finally {
      await browser?.close();
      await server?.close();
      fs.rmSync(owned, { recursive: true, force: true });
    }
  },
);
