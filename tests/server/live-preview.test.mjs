import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import Fastify from "fastify";
import { LivePreviewSessions } from "../../server/live-preview.mjs";
import { installLivePreview } from "../../server/live-preview-routes.mjs";
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

test("AI draft selection validates work ownership, source readiness and cleanup", async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    f.tasks.set(id, { id, repo: randomUUID(), project: f.work.project, kind: "agent", state: "running" });
    await assert.rejects(f.manager.start({ work: f.work, task: id }), /does not belong/);
    f.tasks.set(id, { id, repo: f.work.repo, project: f.work.project, kind: "agent", state: "queued" });
    await assert.rejects(f.manager.start({ work: f.work, task: id }), /not started/);
    f.tasks.get(id).state = "running";
    const draft = path.join(f.data, "runs", id, "projects", f.work.project);
    await fsp.mkdir(draft, { recursive: true }); await fsp.writeFile(path.join(draft, "project.ts"), "export default {}");
    const selected = await f.manager.start({ work: f.work, task: id, ai: true });
    assert.equal(selected.source, "task"); assert.match(selected.url, /\?ai=1$/);
  } finally { await f.close(); }
});

test("content revisions survive copied files and sessions stop after viewers detach", async () => {
  const f = await fixture({ idleMs: 100 });
  try {
    await f.publish();
    const first = await liveSourceInventory(f.projectDir, "test-film");
    const copy = path.join(f.data, "copied");
    await fsp.cp(f.projectDir, copy, { recursive: true });
    const second = await liveSourceInventory(copy, "test-film");
    assert.equal(second.sourceRevision, first.sourceRevision);
    assert.equal(second.assets["films/test-film/image.bin"].revision, first.assets["films/test-film/image.bin"].revision);
    const detach = f.manager.attach(f.session, () => {});
    f.session.lastUsed = Date.now() - 1000; await f.manager.sweep();
    assert.equal(f.manager.sessions.size, 1);
    detach(); f.session.lastUsed = Date.now() - 1000; await f.manager.sweep();
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
    const first = f.session.manifest.sourceRevision;
    const frozen = await f.manager.freezeReference({ sessionId: f.session.id, sourceRevision: first, repo: f.work.repo, project: f.work.project });
    assert.equal(await fsp.readFile(path.join(frozen.dir, ".cache/runtime.ts"), "utf8"), "export const value=1");
    assert.equal(fs.existsSync(path.join(frozen.dir, "exports/unrelated.mov")), false);
    await fsp.writeFile(dependency, "export const value=2");
    await f.publish([dependency]);
    assert.notEqual(f.session.manifest.sourceRevision, first);
    await fsp.writeFile(path.join(frozen.dir, ".cache/runtime.ts"), "tampered");
    await assert.rejects(f.manager.freezeReference({ sessionId: f.session.id, sourceRevision: first, repo: f.work.repo, project: f.work.project }), /modified/);
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
