import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createLivePreviewBundle, liveSourceInventory } from "../../scripts/live-preview-bundle.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("Docker polling follows repeated atomic AI publication and later edits without a new session", { timeout: 90000 }, async () => {
  const previousPolling = process.env.FRAME_LIVE_PREVIEW_POLLING;
  process.env.FRAME_LIVE_PREVIEW_POLLING = "1";
  const owned = await fs.mkdtemp(path.join(os.tmpdir(), "frame-live-publication-"));
  const projectDir = path.join(owned, "projects/test-film"), outDir = path.join(owned, "bundles");
  const bundles = [], errors = [];
  let worker;
  const accepted = async revision => {
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const bundle = bundles.find(value => value.sourceRevision === revision);
      if (bundle) return bundle;
      await delay(50);
    }
    assert.fail("Persistent preview did not accept the published source: " + errors.map(error => error.message).join("; "));
  };
  const compiledScene = async (bundle, marker) => {
    const code = await Promise.all(bundle.files.filter(file => file.endsWith(".js")).map(file => fs.readFile(path.join(outDir, file), "utf8")));
    assert.ok(code.some(value => value.includes(marker)), "Published chunks must contain the new scene code");
  };
  try {
    await fs.mkdir(path.join(projectDir, "public"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "project.ts"), "export default {id:'test-film',load:()=>import('./scene')};");
    await fs.writeFile(path.join(projectDir, "scene.ts"), "export const value='initial-publication';");
    await fs.writeFile(path.join(projectDir, "public/own.svg"), "<svg/>");
    worker = await createLivePreviewBundle({ root, projectDir, id: "test-film", outDir,
      onBundle: bundle => bundles.push(bundle), onError: error => errors.push(error) });
    const initial = await accepted((await liveSourceInventory(projectDir, "test-film")).sourceRevision);
    const vendors = initial.files.filter(file => /\/vendor(?:-|\.)/.test(file));
    for (let index = 0; index < 2; index++) {
      const stage = projectDir + "-stage", original = projectDir + "-original-" + index;
      const marker = "atomic-publication-" + index;
      await fs.cp(projectDir, stage, { recursive: true });
      await fs.writeFile(path.join(stage, "scene.ts"), "export const value=" + JSON.stringify(marker) + ";");
      await fs.writeFile(path.join(stage, "public/own.svg"), "<svg data-version='" + index + "'/>");
      const expected = await liveSourceInventory(stage, "test-film");
      await fs.rename(projectDir, original);
      await fs.rename(stage, projectDir);
      const next = await accepted(expected.sourceRevision);
      await compiledScene(next, marker);
      assert.deepEqual(next.files.filter(file => /\/vendor(?:-|\.)/.test(file)), vendors);
      assert.equal(next.assets["films/test-film/own.svg"].revision, expected.assets["films/test-film/own.svg"].revision);
    }
    await fs.writeFile(path.join(projectDir, "scene.ts"), "export const value='edit-after-publication';");
    const edited = await accepted((await liveSourceInventory(projectDir, "test-film")).sourceRevision);
    await compiledScene(edited, "edit-after-publication");
    assert.deepEqual(errors, []);
  } finally {
    await worker?.close();
    await fs.rm(owned, { recursive: true, force: true });
    if (previousPolling === undefined) delete process.env.FRAME_LIVE_PREVIEW_POLLING;
    else process.env.FRAME_LIVE_PREVIEW_POLLING = previousPolling;
  }
});
