import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createLivePreviewBundle } from "../../scripts/live-preview-bundle.mjs";
import { assertLiveBundleBudget } from "../../scripts/live-preview-budget.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
test("persistent live graph watches imported production, tests and hidden source modules and reuses vendor chunks", { timeout: 90000 }, async t => {
  const owned = await fsp.mkdtemp(path.join(os.tmpdir(), "frame-live-watch-"));
  const projectDir = path.join(owned, "projects/test-film"), outDir = path.join(owned, "bundles");
  for (const folder of ["production", "tests", ".cache"]) await fsp.mkdir(path.join(projectDir, folder), { recursive: true });
  await fsp.writeFile(path.join(projectDir, "project.ts"), "export default {id:'test-film',load:()=>import('./scene')};");
  await fsp.writeFile(path.join(projectDir, "scene.ts"), "import {Color} from 'three';import {color} from './production/palette';export const result=new Color(color);export function createWorker(){return new Worker(new URL('./production/background.ts',import.meta.url));}");
  await fsp.writeFile(path.join(projectDir, "production/background.ts"), "import {value} from '../tests/worker-helper';self.postMessage(value);");
  await fsp.writeFile(path.join(projectDir, "tests/worker-helper.ts"), "export {value} from '../.cache/worker-runtime';");
  const workerDependency = path.join(projectDir, ".cache/worker-runtime.ts");
  await fsp.writeFile(workerDependency, "export const value=1;");
  await fsp.writeFile(path.join(projectDir, "production/palette.ts"), "export {color} from '../tests/helpers';");
  await fsp.writeFile(path.join(projectDir, "tests/helpers.ts"), "export {color} from '../.cache/runtime';");
  const dependency = path.join(projectDir, ".cache/runtime.ts");
  await fsp.writeFile(dependency, "export const color='red';");
  const bundles = [], errors = [];
  let worker;
  const waitBundle = async count => {
    const deadline = Date.now() + 30000;
    while (bundles.length < count && Date.now() < deadline) {
      if (errors.length) throw errors[0];
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(bundles.length >= count, "watch must publish the edited imported module");
    return bundles.at(-1);
  };
  try {
    worker = await createLivePreviewBundle({ root, projectDir, id: "test-film", outDir,
      onBundle: bundle => bundles.push(bundle), onError: error => errors.push(error) });
    const first = await waitBundle(1);
    assert.ok(first.sourceFiles.some(file => file.path === ".cache/runtime.ts"));
    assert.ok(first.sourceFiles.some(file => file.path === "tests/helpers.ts"));
    assert.ok(first.sourceFiles.some(file => file.path === "production/palette.ts"));
    assert.ok(first.preloads.includes(first.projectUrl));
    assert.ok(first.sourceFiles.some(file => file.path === "production/background.ts"));
    assert.ok(first.sourceFiles.some(file => file.path === "tests/worker-helper.ts"));
    assert.ok(first.sourceFiles.some(file => file.path === ".cache/worker-runtime.ts"));
    const vendor = first.files.filter(file => /\/vendor(?:-|\.)/.test(file));
    assert.ok(first.preloads.some(file => /scene-/.test(file)), "declared scene load root must be preloaded");
    assert.ok(first.preloads.some(file => /vendor-three-/.test(file)), "actual scene framework static dependency must be preloaded");
    assert.ok(!first.preloads.some(file => /vendor-(?:babylon|pixi|lottie|tone|mediabunny|spessasynth|remotion)-/.test(file)),
      "unused framework, synth and export dynamics must remain lazy: " + JSON.stringify(Object.fromEntries(first.preloads.map(file => [file, first.moduleGraph[file]]))));
    const warm = [], warmBytes = [];
    for (const [index, color] of ["blue", "green", "orange"].entries()) {
      const count = bundles.length + 1;
      await fsp.writeFile(dependency, "export const color=" + JSON.stringify(color) + ";");
      const next = await waitBundle(count);
      assert.notEqual(next.sourceRevision, index === 0 ? first.sourceRevision : bundles.at(-2).sourceRevision);
      assert.deepEqual(next.files.filter(file => /\/vendor(?:-|\.)/.test(file)), vendor);
      const previous = index === 0 ? first : bundles.at(-2);
      const changed = next.files.filter(file => file.endsWith(".js") && !previous.files.includes(file));
      const transferred = (await Promise.all(changed.map(async file => gzipSync(await fsp.readFile(path.join(outDir, file))).byteLength))).reduce((sum, bytes) => sum + bytes, 0);
      assert.ok(transferred < 64 * 1024, "a visual edit must reuse stable vendor files and transfer a small project delta");
      warmBytes.push(transferred); warm.push(next.buildMs);
    }
    const beforeWorker = bundles.at(-1), count = bundles.length + 1;
    await fsp.writeFile(workerDependency, "export const value=2;");
    const nextWorker = await waitBundle(count);
    assert.notEqual(nextWorker.sourceRevision, beforeWorker.sourceRevision);
    assert.notDeepEqual(nextWorker.files.filter(file => /background/.test(file)), beforeWorker.files.filter(file => /background/.test(file)));
    t.diagnostic(JSON.stringify({ coldMs: first.buildMs, warmMs: warm, warmGzipBytes: warmBytes, workerMs: nextWorker.buildMs, stableVendorChunks: vendor.length, preloads: first.preloads }));
  } finally { await worker?.close(); await fsp.rm(owned, { recursive: true, force: true }); }
});

test("extensionless imports cannot follow ignored-directory links or read private environment files", { timeout: 45000 }, async () => {
  const owned = await fsp.mkdtemp(path.join(os.tmpdir(), "frame-live-import-scope-"));
  const projectDir = path.join(owned, "projects/test-film");
  await fsp.mkdir(path.join(projectDir, "production"), { recursive: true });
  const external = path.join(owned, "private.ts");
  await fsp.writeFile(external, "export default 'owned private fixture';");
  await fsp.symlink(external, path.join(projectDir, "production/evil.ts"));
  await fsp.writeFile(path.join(projectDir, "production/.env"), "OWNED_FIXTURE=value");
  let worker;
  try {
    for (const [index, source] of ["import value from './production/evil';export default {id:'test-film',value};",
      "import value from './production/.env?raw';export default {id:'test-film',value};",
      "const worker=new Worker(new URL('./production/worker.ts',import.meta.url));export default {id:'test-film',worker};"].entries()) {
      if (index === 2) await fsp.writeFile(path.join(projectDir, "production/worker.ts"), "import value from './evil';self.postMessage(value);");
      await fsp.writeFile(path.join(projectDir, "project.ts"), source);
      let failure;
      const bundles = [];
      try {
        worker = await createLivePreviewBundle({ root, projectDir, id: "test-film", outDir: path.join(owned, "out-" + index),
          onBundle: bundle => bundles.push(bundle), onError: error => { failure = error; } });
        const deadline = Date.now() + 12000;
        while (!failure && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        assert.ok(failure, "unsafe source must be rejected before publication");
        assert.match(String(failure.message || failure), /(?:escapes|private environment|links or special)/);
        assert.equal(bundles.length, 0);
      } finally { await worker?.close(); worker = null; }
    }
  } finally { await fsp.rm(owned, { recursive: true, force: true }); }
});


test("output budget counts coalesced orphan chunks and reserves compression without touching retained files", async () => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "frame-live-budget-"));
  try {
    await fsp.mkdir(path.join(outDir, "assets"));
    await fsp.writeFile(path.join(outDir, "assets/shared.js"), Buffer.alloc(1000));
    await fsp.writeFile(path.join(outDir, "assets/shared.js.br"), Buffer.alloc(150));
    await fsp.writeFile(path.join(outDir, "assets/shared.js.gz"), Buffer.alloc(200));
    await fsp.writeFile(path.join(outDir, "assets/coalesced-orphan.js"), Buffer.alloc(700));
    await fsp.writeFile(path.join(outDir, "assets/discarded.js.gz"), Buffer.alloc(100));
    const candidate = {
      "assets/shared.js": { type: "chunk", code: "x".repeat(1000) },
      "assets/new.js": { type: "chunk", code: "x".repeat(500) },
    };
    assert.equal(await assertLiveBundleBudget(outDir, candidate, 6700), 6700);
    for (let index = 0; index < 3; index++)
      await assert.rejects(assertLiveBundleBudget(outDir, candidate, 6699), /revision cache is full/);
    assert.equal((await fsp.stat(path.join(outDir, "assets/shared.js"))).size, 1000);
    assert.equal((await fsp.stat(path.join(outDir, "assets/coalesced-orphan.js"))).size, 700);
    assert.equal((await fsp.readdir(path.join(outDir, "assets"))).length, 5);
  } finally { await fsp.rm(outDir, { recursive: true, force: true }); }
});

test("real main and nested worker builds enforce the output budget before writing files", { timeout: 45000 }, async () => {
  const owned = await fsp.mkdtemp(path.join(os.tmpdir(), "frame-live-budget-build-"));
  const projectDir = path.join(owned, "projects/test-film"), outDir = path.join(owned, "out");
  await fsp.mkdir(projectDir, { recursive: true });
  await fsp.mkdir(path.join(outDir, "assets"), { recursive: true });
  await fsp.writeFile(path.join(outDir, "assets/coalesced-orphan.js"), Buffer.alloc(2048));
  await fsp.writeFile(path.join(projectDir, "project.ts"), "export default {id:'test-film',load:()=>import('./scene')};");
  await fsp.writeFile(path.join(projectDir, "scene.ts"), "export function createWorker(){return new Worker(new URL('./background.ts',import.meta.url));}");
  await fsp.writeFile(path.join(projectDir, "background.ts"), "self.postMessage('ready');");
  const errors = [], bundles = [];
  let worker;
  try {
    worker = await createLivePreviewBundle({ root, projectDir, id: "test-film", outDir, maxBundleBytes: 1024,
      onBundle: bundle => bundles.push(bundle), onError: error => errors.push(error) });
    const deadline = Date.now() + 15000;
    while (!errors.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(errors.length);
    assert.match(String(errors[0].message || errors[0]), /revision cache is full/);
    assert.equal(bundles.length, 0);
    assert.deepEqual(await fsp.readdir(path.join(outDir, "assets")), ["coalesced-orphan.js"]);
  } finally { await worker?.close(); await fsp.rm(owned, { recursive: true, force: true }); }
});
