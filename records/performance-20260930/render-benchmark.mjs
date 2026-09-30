import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { fixture } from "../../tests/mcp/helpers.mjs";
import {
  createRenderSession,
  framePng,
} from "../../scripts/render-session.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const result = {
  baseline: "5a9d970",
  node: process.version,
  time: new Date().toISOString(),
  limits: { cpus: 2, memoryGiB: 3 },
  render: [],
  frontend: null,
};
try {
  for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME"])
    if (process.env[key]) fs.mkdirSync(process.env[key], { recursive: true });
  for (const renderer of process.argv.includes("--build-only")
    ? []
    : ["canvas", "remotion"]) {
    const f = fixture({ browser: true, renderer });
    try {
      for (let pass = 1; pass <= 2; pass++) {
        let page;
        const session = await createRenderSession({ root: f.root, width: 320 });
        const start = performance.now();
        try {
          page = await session.page("test-film");
          const ready = performance.now();
          const imageA = await framePng(page, 0),
            timeA = performance.now();
          const imageB = await framePng(page, 0.5),
            timeB = performance.now();
          const row = {
            renderer,
            pass,
            initializeMs: +(ready - start).toFixed(2),
            firstFrameMs: +(timeA - ready).toFixed(2),
            nextFrameMs: +(timeB - timeA).toFixed(2),
            pngBytes: [imageA.length, imageB.length],
          };
          result.render.push(row);
          console.log(JSON.stringify(row));
        } finally {
          await page?.close();
          await session.close();
        }
      }
    } finally {
      f.close();
    }
  }
  const start = performance.now();
  await build({
    configFile: path.join(root, "studio/vite.config.mjs"),
    configLoader: "native",
    logLevel: "error",
    build: { manifest: true },
  });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "studio-dist/.vite/manifest.json"), "utf8"),
  );
  const dir = path.join(root, "studio-dist"),
    chunks = [];
  for (const name of fs.readdirSync(path.join(dir, "assets"))) {
    const b = fs.readFileSync(path.join(dir, "assets", name));
    chunks.push({ name, bytes: b.length, gzipBytes: gzipSync(b).length });
  }
  const entry = Object.values(manifest).find((v) => v.isEntry);
  result.frontend = {
    buildMs: +(performance.now() - start).toFixed(2),
    entry,
    largest: chunks.sort((a, b) => b.bytes - a.bytes).slice(0, 8),
    totalBytes: chunks.reduce((s, v) => s + v.bytes, 0),
  };
} catch (e) {
  result.error = e.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(
    path.join(
      root,
      "records/performance-20260930",
      process.argv.includes("--build-only")
        ? "frontend-results.json"
        : "render-results.json",
    ),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({ frontend: result.frontend, error: result.error }),
  );
}
