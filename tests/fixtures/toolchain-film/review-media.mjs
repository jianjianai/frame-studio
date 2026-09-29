import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createRenderSession,
  framePng,
} from "../../../scripts/render-session.mjs";
import { projectPath } from "../../../scripts/project-paths.mjs";
import {
  probeMedia,
  analyzeAudio,
} from "../../../scripts/production-media.mjs";

const root = process.cwd(),
  project = process.argv[2],
  output = projectPath(root, project, "exports/toolchain-media");
fs.mkdirSync(output, { recursive: true });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const session = await createRenderSession({ root, width: 640 });
const stats = (buffer) => {
  let squares = 0,
    peak = 0;
  for (let i = 0; i < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i) / 32768;
    squares += sample ** 2;
    peak = Math.max(peak, Math.abs(sample));
  }
  return {
    samples: buffer.length / 2,
    rms: Math.sqrt(squares / (buffer.length / 2)),
    peak,
  };
};
try {
  const page = await session.page(project);
  const first = await framePng(page, 13, true);
  await framePng(page, 22, true);
  const reverse = await framePng(page, 13, true);
  assert.equal(digest(first), digest(reverse));
  fs.writeFileSync(path.join(output, "frame-13.png"), first);
  const withoutSubtitles = await framePng(page, 13, false);
  assert.notEqual(digest(first), digest(withoutSubtitles));
  fs.writeFileSync(
    path.join(output, "frame-13-no-subtitles.png"),
    withoutSubtitles,
  );
  const pcm = async (start, duration, track) =>
    Buffer.from(
      await page.evaluate(
        ({ start, duration, track }) =>
          window.__FRAME_STUDIO__.audioChunk(start, duration, track),
        { start, duration, track },
      ),
      "base64",
    );
  const long = await pcm(12, 4),
    short = await pcm(13, 1),
    pulse = await pcm(13, 1, "pulse"),
    harmony = await pcm(13, 1, "harmony");
  const slice = long.subarray(48000 * 4, 48000 * 8);
  assert.equal(short.length, 48000 * 4);
  assert.equal(slice.length, short.length);
  let segmentMaxDifference = 0,
    mixMaxDifference = 0;
  for (let i = 0; i < short.length; i += 2) {
    segmentMaxDifference = Math.max(
      segmentMaxDifference,
      Math.abs(short.readInt16LE(i) - slice.readInt16LE(i)),
    );
    mixMaxDifference = Math.max(
      mixMaxDifference,
      Math.abs(
        short.readInt16LE(i) - pulse.readInt16LE(i) - harmony.readInt16LE(i),
      ),
    );
  }
  assert(
    segmentMaxDifference <= 2,
    `audio segment mismatch: ${segmentMaxDifference}`,
  );
  assert(mixMaxDifference <= 2, `audio mixing mismatch: ${mixMaxDifference}`);
  const audio = {
    mixed: stats(short),
    pulse: stats(pulse),
    harmony: stats(harmony),
    segmentMaxDifference,
    mixMaxDifference,
    unit: "16-bit PCM LSB",
  };
  for (const key of ["mixed", "pulse", "harmony"]) {
    assert(audio[key].rms > 0.001);
    assert(audio[key].peak < 0.99);
  }
  assert.deepEqual(page.frameDiagnostics().errors, []);
  const media = [];
  for (const [file, width, height, frames, duration] of [
    ["exports/signal-journey.mp4", 1280, 720, 720, 24],
    ["exports/toolchain-browser/browser-clip.webm", 640, 360, 60, 2],
  ]) {
    const full = projectPath(root, project, file),
      probe = await probeMedia(full);
    const video = probe.streams.find((stream) => stream.codec_type === "video"),
      sound = probe.streams.find((stream) => stream.codec_type === "audio");
    assert(video);
    assert(sound);
    assert.equal(video.width, width);
    assert.equal(video.height, height);
    assert.equal(Number(video.nb_read_frames), frames);
    assert.equal(sound.channels, 2);
    assert.equal(Number(sound.sample_rate), 48000);
    assert(
      Math.abs(Number(video.duration ?? probe.format.duration) - duration) <
        0.1,
    );
    const loudness = await analyzeAudio(full);
    assert(Number(loudness.truePeakDb) < 0);
    assert(Number(loudness.integratedLufs) > -40);
    media.push({
      file,
      bytes: fs.statSync(full).size,
      sha256: digest(fs.readFileSync(full)),
      video: {
        codec: video.codec_name,
        width,
        height,
        frames,
        fps: video.avg_frame_rate,
        duration: video.duration ?? probe.format.duration,
      },
      audio: {
        codec: sound.codec_name,
        channels: sound.channels,
        sampleRate: sound.sample_rate,
        integratedLufs: loudness.integratedLufs,
        truePeakDb: loudness.truePeakDb,
        silence: loudness.silence,
      },
    });
  }
  const report = {
    schemaVersion: 1,
    passed: true,
    project,
    checks: {
      deterministicFrames: true,
      subtitlesToggleChangesPixels: true,
      independentTracksNonSilent: true,
      noPcmClipping: true,
      segmentMatchesFullMix: true,
      trackSumMatchesMix: true,
      fullMp4Decoded: true,
      browserWebmDecoded: true,
    },
    audio,
    media,
    frameSha256: digest(first),
    visualReview: "inspect_saved_frames_separately",
    listening: "not_confirmed_by_human",
  };
  fs.writeFileSync(
    path.join(output, "review.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await session.close();
}
