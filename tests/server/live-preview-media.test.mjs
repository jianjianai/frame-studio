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
  const session = { id: randomUUID(), projectDir, outDir: path.join(data, "session"), mediaFiles: new Map(), mediaBytes: 0, mediaReserved: 0 };
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
    const proxy = await f.media.rendition(f.session, film, "economy", "video");
    const stream = JSON.parse((await exec(ffprobe, ["-v", "error", "-show_streams", "-of", "json", proxy])).stdout).streams.find(s => s.codec_type === "video");
    assert.equal(stream.width, 320); assert.equal(stream.codec_name, "h264");
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
