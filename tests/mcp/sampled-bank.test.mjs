import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { fixture } from "./helpers.mjs";
import { executeProject } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { sendMedia } from "../../server/media.mjs";
const source = process.env.FRAME_TEST_SF2;
test(
  "built sampled preview loads only used instrument packages in a real sandboxed browser",
  { skip: !source, timeout: 120000 },
  async (t) => {
    const f = fixture({ browser: true }),
      app = Fastify(),
      requested = [];
    let browser;
    try {
      const bytes = fs.readFileSync(source),
        sha = createHash("sha256").update(bytes).digest("hex");
      fs.writeFileSync(f.file("public/bank.sf2"), bytes);
      fs.writeFileSync(
        f.file("project.ts"),
        fs
          .readFileSync(f.file("project.ts"), "utf8")
          .replace('"id": "melody"', '"id": "music"'),
      );
      fs.writeFileSync(
        f.file("audio.ts"),
        `import {createSampledScoreAudio} from '../../src/engine/soundfont-audio';
      const audio=createSampledScoreAudio({bank:'films/test-film/bank.sf2',sha256:'${sha}',score:{id:'fixture',duration:2,bpm:120,meter:4,instruments:[{channel:0,program:73,name:'flute',volume:100,pan:64,reverb:0}],controls:[{t:0,data:[192,73]}],notes:[{channel:0,t:0,end:1.8,pitch:72,velocity:90}],cues:[]},foley:()=>[new Float32Array(96000),new Float32Array(96000)],levels:{master:1,music:1}});export const {prepareAudio,prepareSegment,createAudio,disposeAudio}=audio;`,
      );
      process.env.FRAME_WORK_PREVIEW = "1";
      process.env.FRAME_PREVIEW_AUDIO = "0"; // Exercise the original sampler, not the compressed preview.
      let built;
      try {
        built = await executeProject(f.root, "test-film", "build");
      } finally {
        delete process.env.FRAME_WORK_PREVIEW;
        delete process.env.FRAME_PREVIEW_AUDIO;
      }
      assert.equal(built.status, "passed", JSON.stringify(built));
      app.get("/*", (req, res) => {
        const relative = req.params["*"] || "index.html",
          file = path.join(built.output, relative);
        if (!fs.existsSync(file)) return res.code(404).send();
        if (relative.endsWith(".sf2"))
          requested.push({ path: relative, bytes: fs.statSync(file).size });
        res
          .header(
            "Content-Security-Policy",
            "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:",
          )
          .header("Access-Control-Allow-Origin", "*");
        res.type(
          {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".json": "application/json",
          }[path.extname(file)] || "application/octet-stream",
        );
        return sendMedia(req, res, file, { compress: true });
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(
        "http://127.0.0.1:" + app.server.address().port + "/?ai=1",
      );
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      const started = Date.now();
      await page.getByTestId("play-toggle").click();
      try {
        await page.waitForFunction(
          () => window.__FRAME_STUDIO__.getState().time > 0.2,
          {},
          { timeout: 15000 },
        );
      } catch (error) {
        t.diagnostic(
          JSON.stringify({
            requested,
            diagnostics: await page.evaluate(() => ({
              data: window.__FRAME_STUDIO__.getDiagnostics(),
              secure: window.isSecureContext,
              subtle: !!crypto.subtle,
              text: document.body.innerText,
            })),
          }),
        );
        throw error;
      }
      assert(requested.length > 0);
      assert(
        !requested.some((p) => p.path === "films/test-film/bank.sf2"),
        "complete bank was downloaded",
      );
      assert.deepEqual(
        await page.evaluate(
          () => window.__FRAME_STUDIO__.getDiagnostics().errors,
        ),
        [],
      );
      t.diagnostic(
        JSON.stringify({
          originalBytes: bytes.length,
          requestedBytes: requested.reduce((n, p) => n + p.bytes, 0),
          presetRequests: requested.length,
          firstPlayMs: Date.now() - started,
        }),
      );
    } finally {
      await browser?.close();
      await app.close();
      f.close();
    }
  },
);
