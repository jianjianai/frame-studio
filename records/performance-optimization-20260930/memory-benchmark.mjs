import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { projectAssets } from "../../scripts/project-assets.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const owned = path.join(root, ".cache/performance-asset-build", randomUUID());
const project = "asset-perf",
  result = {
    baseline: process.env.FRAME_PERF_BASELINE || "working checkout",
    node: process.version,
    started: new Date().toISOString(),
    fixture:
      "isolated projectAssets hooks; physical media files; warm filesystem; not a full Vite peak",
    measurements: [],
  };
const output =
  process.env.FRAME_ASSET_PERF_OUTPUT ||
  path.join(import.meta.dirname, "asset-memory-results.json");
async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
try {
  const publicDir = path.join(owned, "projects", project, "public");
  await fsp.mkdir(publicDir, { recursive: true });
  await fsp.writeFile(path.join(publicDir, "assets.json"), "[]");
  for (const mib of [512, 1024]) {
    const media = path.join(publicDir, "media.bin"),
      block = Buffer.alloc(1024 * 1024, 37);
    const expected = createHash("sha256");
    const fd = fs.openSync(media, "w");
    try {
      for (let i = 0; i < mib; i++) {
        fs.writeSync(fd, block);
        expected.update(block);
      }
    } finally {
      fs.closeSync(fd);
    }
    const expectedSha256 = expected.digest("hex"),
      outDir = path.join(owned, "projects", project, "exports", "build-" + mib);
    const plugin = projectAssets({ project });
    plugin.configResolved({ root: owned, build: { write: true, outDir } });
    const emitted = [];
    global.gc?.();
    const before = process.memoryUsage();
    const peak = { rss: before.rss, arrayBuffers: before.arrayBuffers };
    const observe = () => {
      const current = process.memoryUsage();
      peak.rss = Math.max(peak.rss, current.rss);
      peak.arrayBuffers = Math.max(peak.arrayBuffers, current.arrayBuffers);
    };
    const timer = setInterval(observe, 2),
      started = performance.now();
    let prepared, prepareMs, copyMs;
    try {
      await plugin.generateBundle.call(
        {
          emitFile(asset) {
            emitted.push(asset);
            return String(emitted.length);
          },
        },
        {},
        {},
      );
      observe();
      prepared = process.memoryUsage();
      prepareMs = performance.now() - started;
      const copyStart = performance.now();
      await plugin.writeBundle({ dir: outDir }, {});
      observe();
      copyMs = performance.now() - copyStart;
    } finally {
      clearInterval(timer);
    }
    const copied = path.join(outDir, "films", project, "media.bin");
    const copiedBytes = (await fsp.stat(copied)).size;
    const copiedSha256 = await hash(copied);
    if (copiedBytes !== mib * 1024 * 1024 || copiedSha256 !== expectedSha256)
      throw Error("Media integrity check failed");
    const measurement = {
      name: "projectAssets real media output " + mib + " MiB",
      sourceBytes: mib * 1024 * 1024,
      copiedBytes,
      sha256: copiedSha256,
      integrityPassed: true,
      prepareMs: +prepareMs.toFixed(2),
      copyMs: +copyMs.toFixed(2),
      emittedBytes: emitted.reduce(
        (sum, asset) => sum + Buffer.byteLength(asset.source),
        0,
      ),
      manifestRssDelta: prepared.rss - before.rss,
      manifestArrayBuffersDelta: prepared.arrayBuffers - before.arrayBuffers,
      peakRssDelta: peak.rss - before.rss,
      peakArrayBuffersDelta: peak.arrayBuffers - before.arrayBuffers,
      reusableBufferBytes: 1024 * 1024,
    };
    result.measurements.push(measurement);
    console.log(JSON.stringify(measurement));
    if (measurement.peakArrayBuffersDelta > 8 * 1024 * 1024)
      throw Error("Asset output exceeded fixed ArrayBuffer budget");
    await fsp.rm(outDir, { recursive: true, force: true });
  }
  result.finished = new Date().toISOString();
} catch (error) {
  result.error = error.stack;
  throw error;
} finally {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.writeFile(output, JSON.stringify(result, null, 2) + "\n");
  await fsp.rm(owned, { recursive: true, force: true });
}
