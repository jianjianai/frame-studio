import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { build, createServer } from "vite";
import { BasicSoundBank } from "spessasynth_core";
import { projectAssets } from "../../scripts/project-assets.mjs";
import {
  copyProjectAsset,
  scanProjectAssets,
  writeSoundfontParts,
} from "../../scripts/project-asset-output.mjs";
import { splitSoundfont } from "../../scripts/soundfont-parts.mjs";

async function fixture(t) {
  const root = path.resolve(".cache/project-assets-tests", randomUUID());
  const publicDir = path.join(root, "projects/demo/public");
  await fsp.mkdir(publicDir, { recursive: true });
  await fsp.writeFile(
    path.join(root, "index.html"),
    "<!doctype html><html><body>asset fixture</body></html>",
  );
  await fsp.writeFile(
    path.join(publicDir, "assets.json"),
    JSON.stringify([{ id: "fixture" }]),
  );
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return { root, publicDir };
}
function config(root, write = true) {
  return {
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [projectAssets({ project: "demo" })],
    build: { outDir: "dist", write },
    cacheDir: path.join(root, ".cache/vite"),
  };
}

test("normal Vite output copies project media and catalog without retaining media in Rollup", async (t) => {
  const { root, publicDir } = await fixture(t);
  await fsp.mkdir(path.join(publicDir, "nested"));
  const binary = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  await fsp.writeFile(path.join(publicDir, "nested/media.bin"), binary);
  await fsp.writeFile(path.join(publicDir, "empty.bin"), "");
  const result = await build(config(root));
  assert(!result.output.some((item) => item.fileName.startsWith("films/")));
  assert.deepEqual(
    await fsp.readFile(path.join(root, "dist/films/demo/nested/media.bin")),
    binary,
  );
  assert.equal(
    (await fsp.stat(path.join(root, "dist/films/demo/empty.bin"))).size,
    0,
  );
  assert.deepEqual(
    JSON.parse(await fsp.readFile(path.join(root, "dist/assets.json"), "utf8")),
    [{ id: "fixture" }],
  );
});

test("write:false preserves the requested in-memory asset output and writes no dist", async (t) => {
  const { root, publicDir } = await fixture(t);
  await fsp.writeFile(path.join(publicDir, "media.bin"), "in-memory");
  const result = await build(config(root, false));
  assert.equal(
    Buffer.from(
      result.output.find((item) => item.fileName === "films/demo/media.bin")
        .source,
    ).toString(),
    "in-memory",
  );
  assert(!fs.existsSync(path.join(root, "dist")));
});

test("asset identity checks reject changes before publishing and clean partial outputs", async (t) => {
  const { root, publicDir } = await fixture(t);
  const file = path.join(publicDir, "media.bin");
  await fsp.writeFile(file, "initial bytes");
  const assets = await scanProjectAssets(root, ["demo"]);
  const asset = assets.find((a) => a.file === file);
  const output = path.join(root, "dist");
  await fsp.mkdir(path.join(output, "films/demo"), { recursive: true });
  await fsp.writeFile(path.join(output, asset.name), "previous output");
  await fsp.writeFile(file, "changed bytes");
  await assert.rejects(copyProjectAsset(asset, output), /changed during build/);
  assert.equal(
    await fsp.readFile(path.join(output, asset.name), "utf8"),
    "previous output",
  );
  assert.deepEqual(
    (await fsp.readdir(path.join(output, "films/demo"))).filter((n) =>
      n.startsWith(".frame-asset-"),
    ),
    [],
  );
});

test("asset enumeration and publication reject source and destination symlink escapes", async (t) => {
  const { root, publicDir } = await fixture(t);
  const outside = path.join(root, "outside");
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, "sentinel.bin"), "outside");
  await fsp.symlink(
    path.join(outside, "sentinel.bin"),
    path.join(publicDir, "link.bin"),
  );
  await assert.rejects(scanProjectAssets(root, ["demo"]), /symlink/);
  await fsp.unlink(path.join(publicDir, "link.bin"));
  await fsp.writeFile(path.join(publicDir, "media.bin"), "media");
  const asset = (await scanProjectAssets(root, ["demo"])).find((a) =>
    a.name.endsWith("media.bin"),
  );
  const output = path.join(root, "dist");
  await fsp.mkdir(output);
  await fsp.symlink(outside, path.join(output, "films"));
  await assert.rejects(copyProjectAsset(asset, output), /symlink/);
  assert.equal(
    await fsp.readFile(path.join(outside, "sentinel.bin"), "utf8"),
    "outside",
  );
  await fsp.rename(publicDir, publicDir + "-original");
  await fsp.symlink(publicDir + "-original", publicDir);
  await assert.rejects(scanProjectAssets(root, ["demo"]), /symlink/);
});

test("asset filenames cannot collide with generated application output", async (t) => {
  const { root, publicDir } = await fixture(t);
  await fsp.writeFile(path.join(publicDir, "media.bin"), "media");
  const plugin = projectAssets({ project: "demo" });
  plugin.configResolved({ root, build: { write: true } });
  await assert.rejects(
    plugin.generateBundle.call(
      { emitFile() {} },
      {},
      { "films/demo/media.bin": {} },
    ),
    /conflicts/,
  );
});

test("project dev assets preserve Range, HEAD and project boundaries", async (t) => {
  const { root, publicDir } = await fixture(t);
  await fsp.writeFile(path.join(publicDir, "media.mp4"), "0123456789");
  const server = await createServer({
    ...config(root),
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    const url = "http://127.0.0.1:" + server.httpServer.address().port;
    const partial = await fetch(url + "/films/demo/media.mp4", {
      headers: { Range: "bytes=2-5" },
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await partial.text(), "2345");
    const head = await fetch(url + "/films/demo/media.mp4", { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), "10");
    assert.equal(await head.text(), "");
    const forbidden = await fetch(url + "/films/another/media.mp4");
    assert.equal(forbidden.status, 403);
    await forbidden.text();
    const invalidRange = await fetch(url + "/films/demo/media.mp4", {
      headers: { Range: "bytes=10-" },
    });
    assert.equal(invalidRange.status, 416);
    await invalidRange.text();
  } finally {
    // Stop the optimizer/watchers before fixture cleanup removes their cache.
    await server.close();
  }
});

test("worker soundfont splitting emits the same lossless content-addressed manifest and files", async (t) => {
  const { root } = await fixture(t);
  const bytes = Buffer.from(BasicSoundBank.getSampleSoundBankFile());
  const source = path.join(root, "sample.sf2"),
    directory = source + ".parts";
  await fsp.writeFile(source, bytes);
  const expected = splitSoundfont(bytes),
    actual = await writeSoundfontParts(source, directory);
  assert.deepEqual(actual, expected.manifest);
  assert.deepEqual(
    JSON.parse(await fsp.readFile(path.join(directory, "index.json"), "utf8")),
    expected.manifest,
  );
  for (const part of actual.parts) {
    const binary = await fsp.readFile(path.join(directory, part.file));
    assert.equal(binary.length, part.bytes);
    assert.equal(
      createHash("sha256").update(binary).digest("hex"),
      part.sha256,
    );
  }
  assert(
    !(await fsp.readdir(root)).some((name) =>
      name.startsWith("sample.sf2.parts.frame-"),
    ),
  );
});

test("hardlink assets are rejected both during enumeration and after a manifest was captured", async (t) => {
  const { root, publicDir } = await fixture(t);
  const outside = path.join(root, "outside.bin"),
    media = path.join(publicDir, "media.bin");
  await fsp.writeFile(outside, "outside bytes");
  await fsp.link(outside, media);
  await assert.rejects(scanProjectAssets(root, ["demo"]), /hardlinks/);
  await fsp.unlink(media);
  await fsp.writeFile(media, "owned media");
  const asset = (await scanProjectAssets(root, ["demo"])).find((a) =>
    a.name.endsWith("media.bin"),
  );
  await fsp.link(media, path.join(root, "later-link.bin"));
  await assert.rejects(
    copyProjectAsset(asset, path.join(root, "dist")),
    /changed during build/,
  );
  assert(!fs.existsSync(path.join(root, "dist", asset.name)));
});

test("valid large SF2 files are copied and split through the normal Vite output hook", async (t) => {
  const { root, publicDir } = await fixture(t);
  const bank = Buffer.from(BasicSoundBank.getSampleSoundBankFile());
  const junk = Buffer.alloc(1024 * 1024 + 8);
  junk.write("JUNK");
  junk.writeUInt32LE(junk.length - 8, 4);
  const bytes = Buffer.concat([bank, junk]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  await fsp.writeFile(path.join(publicDir, "large.sf2"), bytes);
  const expected = splitSoundfont(bytes);
  await build(config(root));
  const output = path.join(root, "dist/films/demo/large.sf2");
  assert.deepEqual(await fsp.readFile(output), bytes);
  assert.deepEqual(
    JSON.parse(await fsp.readFile(output + ".parts/index.json", "utf8")),
    expected.manifest,
  );
});
