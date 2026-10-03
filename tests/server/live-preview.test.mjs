import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import Fastify from "fastify";
import { LivePreviewSessions } from "../../server/live-preview.mjs";
import { installLivePreview, livePreviewOperations } from "../../server/live-preview-routes.mjs";
import { livePreviewManifestSchema } from "../../src/contracts/live-preview.mjs";
import { liveSourceInventory } from "../../scripts/live-preview-bundle.mjs";

async function fixture(options = {}) {
  const data = await fsp.mkdtemp(path.join(os.tmpdir(), "frame-live-backend-"));
  const projectDir = path.join(data, "projects/test-film");
  await fsp.mkdir(path.join(projectDir, "public"), { recursive: true });
  await fsp.writeFile(path.join(projectDir, "project.ts"), "export default {id:'test-film'}");
  await fsp.writeFile(path.join(projectDir, "scene.ts"), "export const color='red'");
  await fsp.writeFile(path.join(projectDir, "public/image.bin"), Buffer.from("old frozen image"));
  const work = { id: randomUUID(), repo: randomUUID(), project: "test-film", deleted: false };
  const factories = [], tasks = new Map();
  const db = { one: async (_sql, args) => tasks.get(args[0]) || { deleted: false } };
  const manager = new LivePreviewSessions({
    db, data, repos: { project: async () => ({ dir: projectDir }) },
    bundleFactory: async args => { factories.push(args); return { close: async () => {} }; }, ...options,
  });
  const link = await manager.start({ work });
  const session = manager.sessions.get(link.sessionId);
  const publish = async (dependencies = []) => {
    const args = factories.find(item => item.projectDir === session.projectDir);
    await fsp.mkdir(path.join(args.outDir, "assets"), { recursive: true });
    await fsp.writeFile(path.join(args.outDir, "assets/player-one.js"), "export const ready=true;");
    await fsp.writeFile(path.join(args.outDir, "assets/project-one.js"), "export default {value:1};" + "/*" + "a".repeat(3000) + "*/");
    await args.onBundle({
      ...await liveSourceInventory(projectDir, "test-film", { dependencies }), projectUrl: "assets/project-one.js",
      playerUrl: "assets/player-one.js", styles: [], files: ["assets/player-one.js", "assets/project-one.js"],
      audioGeneratorRevision: "a".repeat(64), buildMs: 2,
    });
  };
  return { data, projectDir, work, db, tasks, factories, manager, link, session, publish,
    close: async () => { await manager.close(); await fsp.rm(data, { recursive: true, force: true }); } };
}

test("live sessions reuse a capability, retain last-good errors and freeze the displayed source revision", async () => {
  const f = await fixture();
  try {
    assert.equal(f.link.state, "starting");
    await f.publish();
    const first = f.manager.snapshot(f.session);
    assert.equal(first.revision, 1);
    assert.equal((await f.manager.start({ work: f.work })).url, f.link.url);
    const firstSource = first.sourceRevision;
    await fsp.writeFile(path.join(f.projectDir, "scene.ts"), "export const color='blue'");
    await fsp.writeFile(path.join(f.projectDir, "public/image.bin"), Buffer.from("new source image"));
    await f.publish();
    const frozen = await f.manager.freezeReference({ sessionId: f.session.id, sourceRevision: firstSource, repo: f.work.repo, project: f.work.project });
    assert.equal(await fsp.readFile(path.join(frozen.dir, "scene.ts"), "utf8"), "export const color='red'");
    assert.equal(await fsp.readFile(path.join(frozen.dir, "public/image.bin"), "utf8"), "old frozen image");
    assert.equal(frozen.revision, 1);
    assert.equal(f.manager.snapshot(f.session).changes.audio, false);
    await assert.rejects(f.manager.freezeReference({ sessionId: f.session.id, sourceRevision: firstSource, repo: randomUUID(), project: f.work.project }), /does not belong/);
  } finally { await f.close(); }
});

test("capability resource routes never expose source, other projects, dependencies, or expired resources", async () => {
  const f = await fixture(), app = Fastify();
  try {
    await f.publish();
    installLivePreview(app, f.manager);
    const base = f.link.url.slice(0, -"index.html".length);
    for (const target of ["project.ts", "src/engine/types.ts", "node_modules/react/index.js", "films/another-work/image.bin", "live-assets.watch.json"])
      assert.equal((await app.inject(base + target)).statusCode, 404, target);
    assert.equal((await app.inject("/preview-live/unknown/manifest.json")).statusCode, 401);
    const code = await app.inject({ url: base + "assets/project-one.js", headers: { "accept-encoding": "br,gzip" } });
    assert.equal(code.statusCode, 200); assert.equal(code.headers["content-encoding"], "br");
    const csp = code.headers["content-security-policy"];
    assert.match(csp, /(?:^|;)\s*media-src 'self' data: blob:(?:;|$)/, "Remotion shared silent audio can load inline media");
    assert.match(csp, /(?:^|;)\s*sandbox allow-scripts allow-downloads(?:;|$)/, "preview retains an opaque origin");
    assert.match(csp, /(?:^|;)\s*connect-src 'self' blob:(?:;|$)/, "verified cache workers can fetch local blobs without external network access");
    assert.doesNotMatch(csp, /connect-src[^;]*(?:https?:|\*)/, "cached media does not allow external network origins");
    assert.doesNotMatch(csp, /script-src[^;]*data:/, "inline media does not authorize data scripts");
    assert.match(code.headers["cache-control"], /immutable/);
    assert.match(brotliDecompressSync(code.rawPayload).toString(), /value:1/);
    const conditional = await app.inject({ url: base + "assets/project-one.js", headers: { "if-none-match": code.headers.etag } });
    assert.equal(conditional.statusCode, 304);
    const src = "films/test-film/image.bin", hash = f.session.manifest.assetRevisions[src];
    const range = await app.inject({ url: base + src + "?v=" + hash, headers: { range: "bytes=0-2" } });
    assert.equal(range.statusCode, 206); assert.equal(range.body, "old");
    assert.equal(range.headers["access-control-allow-origin"], "*");
    f.session.expires = Date.now() - 1;
    assert.equal((await app.inject(base + "assets/project-one.js")).statusCode, 401);
  } finally { await app.close(); await f.close(); }
});

test("Live preview rejects isolated AI drafts and additional native workspaces", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.manager.start({ work: f.work, task: randomUUID() }), /唯一工作区/);
    await assert.rejects(f.manager.start({ work: f.work, source: "paseo" }), /唯一工作区/);
    await assert.rejects(f.manager.start({ work: f.work, paseoAgent: "other-agent" }), /唯一工作区/);
    const selected = await f.manager.start({ work: f.work, ai: true });
    assert.equal(selected.source, "work"); assert.equal(selected.sessionId, f.link.sessionId);
  } finally { await f.close(); }
});

test("content revisions survive copied files and sessions stop after viewers detach", async () => {
  const f = await fixture({ idleMs: 1000 });
  try {
    await f.publish();
    const first = await liveSourceInventory(f.projectDir, "test-film");
    const copy = path.join(f.data, "copied");
    await fsp.cp(f.projectDir, copy, { recursive: true });
    const second = await liveSourceInventory(copy, "test-film");
    assert.equal(second.sourceRevision, first.sourceRevision);
    assert.equal(second.assets["films/test-film/image.bin"].revision, first.assets["films/test-film/image.bin"].revision);
    const detach = f.manager.attach(f.session, () => {});
    f.session.lastUsed = Date.now() - 10000; await f.manager.sweep();
    assert.equal(f.manager.sessions.size, 1);
    detach(); f.session.lastUsed = Date.now() - 10000; await f.manager.sweep();
    assert.equal(f.manager.sessions.size, 0);
    assert.equal(fs.existsSync(f.session.outDir), false);
  } finally { await f.close(); }
});

test("imported runtime modules in artifact directories participate in revisions and immutable review copies", async () => {
  const f = await fixture();
  try {
    const dependency = path.join(f.projectDir, ".cache/runtime.ts");
    const ignoredOutput = path.join(f.projectDir, "exports/unrelated.mov");
    await fsp.mkdir(path.dirname(dependency), { recursive: true });
    await fsp.mkdir(path.dirname(ignoredOutput), { recursive: true });
    await fsp.writeFile(dependency, "export const value=1");
    await fsp.writeFile(ignoredOutput, "unrelated exported movie");
    await f.publish([dependency]);
    const first = f.session.manifest.sourceRevision, compiledRevision = f.session.manifest.compiledRevision;
    const frozen = await f.manager.freezeReference({ sessionId: f.session.id, sourceRevision: first, repo: f.work.repo, project: f.work.project });
    assert.equal(await fsp.readFile(path.join(frozen.dir, ".cache/runtime.ts"), "utf8"), "export const value=1");
    assert.equal(fs.existsSync(path.join(frozen.dir, "exports/unrelated.mov")), false);
    await fsp.writeFile(dependency, "export const value=2");
    await f.publish([dependency]);
    assert.equal(f.session.manifest.sourceRevision, first);
    assert.notEqual(f.session.manifest.compiledRevision, compiledRevision);
    await assert.rejects(f.manager.freezeReference({ sessionId: f.session.id, sourceRevision: first, repo: f.work.repo, project: f.work.project }), /多个已显示编译版本/);
    await fsp.writeFile(path.join(frozen.dir, ".cache/runtime.ts"), "tampered");
    await assert.rejects(f.manager.freezeReference({ sessionId: f.session.id, sourceRevision: first, compiledRevision, repo: f.work.repo, project: f.work.project }), /modified/);
  } finally { await f.close(); }
});

test("large compressed audio starts from the original and exposes only a lazy economy rendition", async () => {
  const f = await fixture(), app = Fastify();
  try {
    await fsp.writeFile(path.join(f.projectDir, "public/music.mp3"), Buffer.alloc(300000, 1));
    await f.publish();
    const descriptor = f.session.manifest.audioSources["films/test-film/music.mp3"];
    assert.equal(descriptor.url, descriptor.originalUrl);
    assert.equal(descriptor.renditions.preview, undefined);
    assert.match(descriptor.renditions.economy, /audio\/[a-f0-9]{64}\/economy$/);
    assert.equal(f.manager.media.entries.size, 0, "publication does not encode compressed audio");
    let requested;
    f.manager.media.rendition = async (_session, asset, profile) => { requested = { src: asset.src, profile }; return f.session.mediaFiles.get(asset.revision).file; };
    installLivePreview(app, f.manager);
    assert.equal((await app.inject(descriptor.renditions.economy)).statusCode, 200);
    assert.deepEqual(requested, { src: "films/test-film/music.mp3", profile: "economy" });
  } finally { await app.close(); await f.close(); }
});

test("a rejected cache-full candidate removes its unregistered outputs and code snapshot", async () => {
  const f = await fixture({ maxBundleBytes: 1000 });
  try {
    await f.publish();
    assert.equal(f.session.state, "error");
    assert.match(f.session.error.message, /cache is full/);
    assert.equal(f.session.manifest, null);
    assert.equal(fs.existsSync(path.join(f.session.outDir, "assets/project-one.js")), false);
    assert.equal(fs.existsSync(path.join(f.session.outDir, "assets/player-one.js")), false);
    assert.equal(fs.existsSync(path.join(f.session.outDir, "source-snapshots")), false);
    assert.equal(f.session.mediaBytes, 0, "unpublished candidate media must not consume cache quota");
    assert.equal(f.session.mediaFiles.size, 0);
  } finally { await f.close(); }
});

test("worker receives the disk budget and repeated rejected candidates retain the published runtime files", async () => {
  const budget = 12000, f = await fixture({ maxBundleBytes: budget });
  try {
    assert.equal(f.factories[0].maxBundleBytes, budget, "the pre-write worker guard uses the session cache limit");
    await f.publish();
    const displayed = f.session.manifest;
    assert.ok(displayed);
    for (let revision = 0; revision < 3; revision++) {
      const file = "assets/rejected-" + revision + ".js";
      await fsp.writeFile(path.join(f.session.outDir, file), "export default '" + "x".repeat(4000) + "';");
      await f.factories[0].onBundle({
        ...await liveSourceInventory(f.projectDir, "test-film"),
        sourceRevision: String(revision).repeat(64),
        projectUrl: file, playerUrl: "assets/player-one.js", styles: [],
        files: ["assets/player-one.js", file], buildMs: 1,
      });
      assert.equal(f.session.manifest, displayed, "cache rejection keeps the last published manifest");
      assert.match(f.session.error.message, /cache is full/);
      assert.equal(fs.existsSync(path.join(f.session.outDir, file)), false);
      assert.equal(fs.existsSync(path.join(f.session.outDir, "assets/player-one.js")), true);
      assert.equal(fs.existsSync(path.join(f.session.outDir, "assets/project-one.js")), true);
      assert.equal(fs.existsSync(path.join(f.session.outDir, "assets/project-one.js.br")), true);
    }
  } finally { await f.close(); }
});

test("all playback resources have verified immutable identities, including dynamic samples, workers and platform decoders", async () => {
  const runtime = await fsp.mkdtemp(path.join(os.tmpdir(), "frame-live-runtime-"));
  await fsp.mkdir(path.join(runtime, "public/vendor/decoder"), { recursive: true });
  await fsp.mkdir(path.join(runtime, "public/fonts"), { recursive: true });
  await fsp.writeFile(path.join(runtime, "public/vendor/decoder/runtime.wasm"), Buffer.from("owned wasm fixture"));
  await fsp.writeFile(path.join(runtime, "public/fonts/custom.woff2"), Buffer.from("owned font fixture"));
  const f = await fixture({ root: runtime }), app = Fastify();
  try {
    for (const [name, content] of [["music/bank.sf2", "bank"], ["music/bank.sf2.parts/index.json", "{}"],
      ["music/bank.sf2.parts/preset-0.sf2", "preset"], ["models/model.bin", "model binary"]]) {
      const file = path.join(f.projectDir, "public", name);
      await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, content);
    }
    await f.publish();
    const manifest = livePreviewManifestSchema.parse(f.session.manifest);
    assert.equal(manifest.workId, f.work.id); assert.equal(manifest.projectId, f.work.project);
    assert.equal(manifest.defaultMediaMode, "compressed");
    assert.deepEqual(manifest.mediaModes, ["original", "compressed", "cached"]);
    const paths = manifest.resources.map(resource => resource.path);
    for (const required of ["assets/player-one.js", "assets/project-one.js", "films/test-film/music/bank.sf2",
      "films/test-film/music/bank.sf2.parts/index.json", "films/test-film/music/bank.sf2.parts/preset-0.sf2",
      "films/test-film/models/model.bin", "vendor/decoder/runtime.wasm", "fonts/custom.woff2"])
      assert.ok(paths.includes(required), required + " must be available before cache completion");
    assert.ok(!paths.some(value => /project.ts|scene.ts|production|node_modules/.test(value)));
    installLivePreview(app, f.manager);
    for (const resource of manifest.resources) {
      assert.equal(resource.url, resource.originalUrl);
      assert.ok(resource.url.endsWith("?v=" + resource.sha256));
      const response = await app.inject(resource.url);
      assert.equal(response.statusCode, 200, resource.path);
      assert.equal(response.rawPayload.length, resource.bytes, resource.path);
      assert.equal(createHash("sha256").update(response.rawPayload).digest("hex"), resource.sha256, resource.path);
      assert.equal(resource.sha256, resource.revision);
      assert.equal(response.headers["content-type"].split(";")[0], resource.type);
    }
    const decoder = manifest.resources.find(resource => resource.path === "vendor/decoder/runtime.wasm");
    await fsp.writeFile(path.join(runtime, "public/vendor/decoder/runtime.wasm"), "changed decoder bytes");
    assert.equal((await app.inject(decoder.url)).body, "owned wasm fixture", "a deployment edit cannot alter a content URL");
    await fsp.writeFile(path.join(f.projectDir, "scene.ts"), "export const color='new-runtime'");
    await f.publish();
    const updated = f.session.manifest.resources.find(resource => resource.path === decoder.path);
    assert.notEqual(updated.revision, decoder.revision);
    assert.equal((await app.inject(updated.url)).body, "changed decoder bytes");
    assert.equal((await app.inject(decoder.url)).body, "owned wasm fixture");
    assert.equal((await app.inject(f.link.url.replace("index.html", "vendor/unknown/private.wasm"))).statusCode, 404);
  } finally { await app.close(); await f.close(); await fsp.rm(runtime, { recursive: true, force: true }); }
});

test("original and cached viewers share compilation, keep raw media bytes and never trigger conversion", async () => {
  const f = await fixture(), app = Fastify();
  try {
    await fsp.writeFile(path.join(f.projectDir, "public/voice.wav"), Buffer.alloc(300000, 7));
    await f.publish();
    let conversions = 0;
    f.manager.media.rendition = async () => { conversions++; throw Error("Original mode must never transcode"); };
    installLivePreview(app, f.manager);
    for (const mediaMode of ["original", "cached"]) {
      const link = await f.manager.start({ work: f.work, mediaMode });
      assert.equal(link.sessionId, f.link.sessionId);
      assert.match(link.url, new RegExp("mediaMode=" + mediaMode));
      const index = await app.inject(link.url);
      assert.equal(index.statusCode, 200); assert.ok(index.body.includes('"mediaMode":"' + mediaMode + '"'));
      const raw = f.session.manifest.resources.find(resource => resource.path === "films/test-film/voice.wav");
      assert.equal((await app.inject(raw.url)).rawPayload.length, 300000);
      const proxy = f.session.manifest.audioSources[raw.path].url;
      assert.equal((await app.inject(proxy + "?mediaMode=" + mediaMode)).statusCode, 400);
    }
    assert.equal(conversions, 0);
    assert.equal(f.factories.length, 1, "changing media policy reuses the persistent compile graph");
    await assert.rejects(f.manager.start({ work: f.work, mediaMode: "invalid" }), /Invalid preview media mode/);
    assert.equal((await app.inject(f.link.url + "?mediaMode=invalid")).statusCode, 400);
  } finally { await app.close(); await f.close(); }
});

test("live preview operation exposes all three media modes to AI callers", async () => {
  let operation, input;
  livePreviewOperations({
    add: (name, description, schema, handler) => { operation = { name, description, schema, handler }; },
    works: { get: async id => ({ id }) }, livePreview: { start: async value => { input = value; return value; } },
  });
  assert.equal(operation.name, "works_live_preview");
  assert.match(operation.description, /original.*compressed.*cached/);
  const id = randomUUID();
  for (const mediaMode of ["original", "compressed", "cached"]) {
    await operation.handler({ id, ai: true, mediaMode });
    assert.equal(input.mediaMode, mediaMode); assert.equal(input.work.id, id);
  }
});

test("closing the input-owning session cancels its reader while a shared converter keeps its input until the other viewer finishes", async () => {
  const f = await fixture();
  let finish, inputFile;
  try {
    await fsp.writeFile(path.join(f.projectDir, "public/voice.wav"), "owned shared sample");
    await f.publish();
    f.manager.media.transcode = async (source, target, _profile, _kind, signal) => {
      inputFile = source; await fsp.writeFile(target, "shared complete proxy");
      await new Promise((resolve, reject) => {
        finish = resolve; signal.addEventListener("abort", () => reject(Error("cancelled converter")), { once: true });
      });
      assert.equal(await fsp.readFile(source, "utf8"), "owned shared sample", "a shared converter input stays alive");
    };
    const voice = [...f.session.assets.values()].find(asset => asset.src.endsWith("/voice.wav"));
    const first = f.manager.media.rendition(f.session, voice, "preview");
    const cancelled = assert.rejects(first, /cancelled/);
    // Ensure the first session owns the conversion input before a second session joins.
    const end = Date.now() + 5000;
    while (!finish && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(finish);
    const link = await f.manager.start({ work: { ...f.work, id: randomUUID() } });
    const second = f.manager.sessions.get(link.sessionId);
    const other = f.manager.media.rendition(second, voice, "preview");
    while ([...f.manager.media.jobs.values()][0]?.refs.size !== 2 && Date.now() < end)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal([...f.manager.media.jobs.values()][0].refs.size, 2);
    let stopped = false;
    const stop = f.manager.stop(f.session.id).then(() => { stopped = true; });
    await cancelled;
    assert.equal(stopped, false); assert.equal(fs.existsSync(inputFile), true);
    finish();
    assert.equal(await fsp.readFile(await other, "utf8"), "shared complete proxy");
    await stop;
    assert.equal(fs.existsSync(f.session.outDir), false);
    assert.equal(second.closed, false); assert.equal(f.manager.media.entries.size, 1);
  } finally { finish?.(); await f.close(); }
});

test("a failed snapshot batch waits for sibling copies before removing every unpublished media byte", async () => {
  const f = await fixture();
  let release, failed = false;
  try {
    await fsp.writeFile(path.join(f.projectDir, "public/failing.bin"), "owned failing fixture");
    const original = f.manager.media.snapshot.bind(f.manager.media);
    f.manager.media.snapshot = async (session, asset) => {
      if (asset.src.endsWith("/failing.bin")) { failed = true; throw Error("owned candidate failure"); }
      await new Promise(resolve => { release = resolve; });
      return original(session, asset);
    };
    let completed = false;
    const publishing = f.publish().then(() => { completed = true; });
    const end = Date.now() + 5000;
    while ((!release || !failed) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(release && failed);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false, "rollback must wait for an in-flight sibling snapshot");
    release(); await publishing;
    assert.equal(f.session.state, "error"); assert.equal(f.session.manifest, null);
    assert.equal(f.session.mediaFiles.size, 0); assert.equal(f.session.mediaBytes, 0); assert.equal(f.session.mediaReserved, 0);
    assert.equal((await fsp.readdir(path.join(f.session.outDir, "media"))).length, 0);
  } finally { release?.(); await f.close(); }
});
