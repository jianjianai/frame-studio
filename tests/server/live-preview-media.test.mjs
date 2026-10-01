import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LivePreviewMedia } from "../../server/live-preview-media.mjs";
import { liveSourceInventory } from "../../scripts/live-preview-bundle.mjs";
const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const enabled = await exec(ffmpeg, ["-version"]).then(() => true, () => false);

async function fixture(options) {
  const data = await fsp.mkdtemp(path.join(os.tmpdir(), "frame-live-media-")), projectDir = path.join(data, "projects/test-film");
  await fsp.mkdir(path.join(projectDir, "public"), { recursive: true });
  await fsp.writeFile(path.join(projectDir, "project.ts"), "export default {}");
  const media = new LivePreviewMedia({ data, ...options });
  const session = { id: randomUUID(), projectDir, outDir: path.join(data, "session"), mediaFiles: new Map(), mediaBytes: 0, mediaReserved: 0, abort: new AbortController(), mediaJobs: new Set() };
  const asset = async name => ({ ...((await liveSourceInventory(projectDir, "test-film")).assets["films/test-film/" + name]), src: "films/test-film/" + name });
  return { data, projectDir, session, media, asset, close: async () => { await media.close(); await fsp.rm(data, { recursive: true, force: true }); } };
}

test("lazy audio and video renditions are bounded, seekable, cached by source content, and preserve originals", { skip: !enabled, timeout: 60000 }, async () => {
  const f = await fixture();
  let second;
  try {
    const wav = path.join(f.projectDir, "public/voice.wav"), video = path.join(f.projectDir, "public/film.mp4");
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=4", "-ac", "2", "-c:a", "pcm_s16le", wav]);
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=2", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-threads", "2", video]);
    const voice = await f.asset("voice.wav"), film = await f.asset("film.mp4");
    const [preview, same] = await Promise.all([f.media.rendition(f.session, voice, "preview"), f.media.rendition(f.session, voice, "preview")]);
    assert.equal(preview, same);
    assert.ok((await fsp.stat(preview)).size < voice.bytes / 5);
    const economy = await f.media.rendition(f.session, voice, "economy");
    const audio = JSON.parse((await exec(ffprobe, ["-v", "error", "-show_streams", "-of", "json", economy])).stdout).streams[0];
    assert.equal(audio.codec_name, "aac"); assert.equal(audio.channels, 1);
    await exec(ffmpeg, ["-v", "error", "-i", economy, "-f", "null", "-"]);
    const proxy = await f.media.rendition(f.session, film, "economy", "video");
    const stream = JSON.parse((await exec(ffprobe, ["-v", "error", "-show_streams", "-of", "json", proxy])).stdout).streams.find(s => s.codec_type === "video");
    assert.equal(stream.width, 320); assert.equal(stream.codec_name, "h264");
    await exec(ffmpeg, ["-v", "error", "-i", proxy, "-f", "null", "-"]);
    assert.ok((await fsp.stat(proxy)).size < film.bytes);
    const proxyBytes = await fsp.readFile(proxy);
    assert.ok(proxyBytes.indexOf(Buffer.from("moov")) < proxyBytes.indexOf(Buffer.from("mdat")), "MP4 metadata should precede media for range seeking");
    assert.equal((await f.asset("voice.wav")).revision, voice.revision);
    assert.equal((await f.asset("film.mp4")).revision, film.revision);
    const compressed = path.join(f.projectDir, "public/music.mp3");
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-c:a", "libmp3lame", "-b:a", "320k", compressed]);
    const mp3 = await f.asset("music.mp3");
    const economicalMp3 = await f.media.rendition(f.session, mp3, "economy");
    assert.ok((await fsp.stat(economicalMp3)).size < mp3.bytes / 3);
    assert.equal((await f.asset("music.mp3")).revision, mp3.revision);
    const before = (await fsp.stat(preview)).mtimeMs;
    second = new LivePreviewMedia({ data: f.data, transcode: () => { throw Error("Cached source should not be transcoded twice"); } });
    await second.ready;
    assert.ok(second.entries.size >= 3);
    assert.equal(await second.rendition(f.session, voice, "preview"), preview);
    assert.equal((await fsp.stat(preview)).mtimeMs, before);
  } finally { await second?.close(); await f.close(); }
});

test("large image rendition preserves alpha and reuses its immutable source", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const { default: sharp } = await import("sharp");
    const source = path.join(f.projectDir, "public/image.png");
    await sharp({ create: { width: 1600, height: 900, channels: 4, background: { r: 40, g: 80, b: 160, alpha: .5 } } }).png().toFile(source);
    const image = await f.asset("image.png");
    const preview = await f.media.rendition(f.session, image, "economy", "image");
    const info = await sharp(preview).metadata();
    assert.equal(info.width, 480); assert.equal(info.format, "webp"); assert.equal(info.hasAlpha, true);
    assert.equal((await f.asset("image.png")).revision, image.revision);
  } finally { await f.close(); }
});

test("concurrent snapshots reserve their cache budget before copying", async () => {
  const f = await fixture({ maxBytes: 100000 });
  try {
    await fsp.writeFile(path.join(f.projectDir, "public/one.bin"), Buffer.alloc(70000, 1));
    await fsp.writeFile(path.join(f.projectDir, "public/two.bin"), Buffer.alloc(70000, 2));
    const [one, two] = await Promise.all([f.asset("one.bin"), f.asset("two.bin")]);
    const results = await Promise.allSettled([f.media.snapshot(f.session, one), f.media.snapshot(f.session, two)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.ok(f.session.mediaBytes <= 100000); assert.equal(f.session.mediaReserved, 0);
    await assert.rejects(f.media.rendition(f.session, one, "unsupported"), /Invalid/);
  } finally { await f.close(); }
});

test("media conversion permits remain bounded when a new request arrives during a queued handoff", async () => {
  const f = await fixture();
  try {
    await f.media.acquire(); await f.media.acquire();
    let queued = false, newcomer = false;
    const waiting = f.media.acquire().then(() => { queued = true; });
    assert.equal(f.media.running, 2);
    f.media.release();
    const competing = f.media.acquire().then(() => { newcomer = true; });
    await waiting;
    assert.equal(queued, true); assert.equal(newcomer, false);
    assert.equal(f.media.running, 2, "a waking queued request already owns its transferred permit");
    f.media.release(); await competing;
    assert.equal(f.media.running, 2);
    f.media.release(); f.media.release();
    assert.equal(f.media.running, 0);
  } finally { await f.close(); }
});

async function waitUntil(predicate, message) {
  const end = Date.now() + 5000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), message);
}

test("cancelling one rendition reader preserves another session and the completed shared cache", async () => {
  let calls = 0, finish, activeSignal;
  const f = await fixture({ transcode: async (_source, target, _profile, _kind, signal) => {
    calls++; activeSignal = signal;
    await fsp.writeFile(target, "shared proxy");
    await new Promise((resolve, reject) => {
      finish = resolve; signal.addEventListener("abort", () => reject(Error("cancelled converter")), { once: true });
    });
  } });
  try {
    await fsp.writeFile(path.join(f.projectDir, "public/voice.wav"), "owned sample");
    const voice = await f.asset("voice.wav"), first = new AbortController();
    const second = { ...f.session, id: randomUUID(), outDir: path.join(f.data, "second"), mediaFiles: new Map(),
      mediaBytes: 0, mediaReserved: 0, mediaJobs: new Set(), abort: new AbortController() };
    const one = f.media.rendition(f.session, voice, "preview", "audio", { signal: first.signal });
    const cancelled = assert.rejects(one, /cancelled/);
    const two = f.media.rendition(second, voice, "preview");
    await waitUntil(() => finish && [...f.media.jobs.values()][0]?.refs.size === 2, "readers must share one converter");
    first.abort(); await cancelled;
    assert.equal(activeSignal.aborted, false, "one cancelled viewer must not kill the shared converter");
    assert.equal([...f.media.jobs.values()][0].refs.size, 1);
    finish();
    const proxy = await two;
    assert.equal(await fsp.readFile(proxy, "utf8"), "shared proxy");
    assert.equal(calls, 1);
    assert.equal(await f.media.rendition(f.session, voice, "preview"), proxy, "ready cache remains reusable");
    assert.equal(calls, 1);
    assert.equal(f.media.running, 0); assert.equal(f.media.jobs.size, 0);
  } finally { finish?.(); await f.close(); }
});

test("the final cancelled reader aborts conversion, removes temporary output and allows a clean retry", async () => {
  let calls = 0, activeSignal;
  const f = await fixture({ transcode: async (_source, target, _profile, _kind, signal) => {
    calls++; activeSignal = signal;
    await fsp.writeFile(target, "partial proxy");
    if (calls > 1) return;
    await new Promise((_resolve, reject) => {
      if (signal.aborted) reject(Error("cancelled converter"));
      else signal.addEventListener("abort", () => reject(Error("cancelled converter")), { once: true });
    });
  } });
  try {
    await fsp.writeFile(path.join(f.projectDir, "public/voice.wav"), "owned sample");
    const voice = await f.asset("voice.wav"), controller = new AbortController();
    const pending = f.media.rendition(f.session, voice, "preview", "audio", { signal: controller.signal });
    const cancelled = assert.rejects(pending, /cancelled/);
    await waitUntil(() => activeSignal && calls === 1, "conversion must start");
    const job = [...f.media.jobs.values()][0];
    controller.abort(); await cancelled; await job.promise.catch(() => {});
    assert.equal(activeSignal.aborted, true);
    assert.equal(f.media.entries.size, 0); assert.equal(f.media.jobs.size, 0); assert.equal(f.media.running, 0);
    assert.ok(!(await fsp.readdir(f.media.root)).some(name => name.endsWith(".tmp")), "cancelled temporary files are removed");
    const proxy = await f.media.rendition(f.session, voice, "preview");
    assert.equal(await fsp.readFile(proxy, "utf8"), "partial proxy");
    assert.equal(calls, 2);
  } finally { await f.close(); }
});

test("a cancelled queued conversion never starts and releases only its own queue position", async () => {
  let calls = 0;
  const f = await fixture({ transcode: async () => { calls++; } });
  try {
    await fsp.writeFile(path.join(f.projectDir, "public/voice.wav"), "owned sample");
    const voice = await f.asset("voice.wav"), controller = new AbortController();
    await f.media.acquire(); await f.media.acquire();
    const pending = f.media.rendition(f.session, voice, "preview", "audio", { signal: controller.signal });
    const cancelled = assert.rejects(pending, /cancelled/);
    await waitUntil(() => f.media.waiters.length === 1, "conversion must queue behind two active permits");
    const job = [...f.media.jobs.values()][0];
    controller.abort(); await cancelled; await job.promise.catch(() => {});
    assert.equal(calls, 0); assert.equal(f.media.waiters.length, 0); assert.equal(f.media.running, 2);
    f.media.release(); f.media.release();
    assert.equal(f.media.running, 0);
  } finally { await f.close(); }
});

test("the last reader cancellation kills the conversion child and cleans its partial file", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const previous = process.env.FFMPEG_PATH, f = await fixture();
  try {
    const executable = path.join(f.data, "owned-ffmpeg-fixture");
    await fsp.writeFile(executable, "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.argv.at(-1),String(process.pid));setInterval(()=>{},1000);\n", { mode: 0o700 });
    process.env.FFMPEG_PATH = executable;
    await fsp.writeFile(path.join(f.projectDir, "public/voice.wav"), "owned sample");
    const voice = await f.asset("voice.wav"), controller = new AbortController();
    const pending = f.media.rendition(f.session, voice, "preview", "audio", { signal: controller.signal });
    const cancelled = assert.rejects(pending, /cancelled/);
    let partial;
    await waitUntil(() => {
      partial = fs.readdirSync(f.media.root).find(name => name.endsWith(".tmp"));
      return partial && fs.statSync(path.join(f.media.root, partial)).size > 0;
    }, "owned conversion child must be running");
    const pid = Number(await fsp.readFile(path.join(f.media.root, partial), "utf8")), job = [...f.media.jobs.values()][0];
    controller.abort(); await cancelled; await job.promise.catch(() => {});
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "cancelled child must have exited");
    assert.equal(f.media.running, 0); assert.equal(f.media.jobs.size, 0);
    assert.ok(!(await fsp.readdir(f.media.root)).some(name => name.endsWith(".tmp")));
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous;
    await f.close();
  }
});
