import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ProjectService } from "./project-service.mjs";
import { checkedProcess, probeMedia } from "./production-media.mjs";
import {
  readSpeechConfig,
  resolveSpeech,
  synthesizeSpeech,
  SPEECH_CONFIG,
} from "./speech-providers.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const validId = (value) =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const finite = (value, max = 3600) =>
  Number.isFinite(value) && value >= 0 && value <= max;
const stamp = (time) => {
  const ms = Math.round(time * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
/** CLI takes a project lock; Jobs already holds it for its verified child process. */
export async function produceNarration(root, id, configPath, options = {}) {
  const workspace = new ProjectService(root, { projects: [id] });
  workspace.project(id);
  const operation = workspace.operation(id);
  const lockRecord =
    process.env.FRAME_TASK_ID && operation?.busy
      ? JSON.parse(
          fs.readFileSync(
            workspace.file(id, ".cache/mcp/operation.lock", true),
            "utf8",
          ),
        )
      : null;
  const ownedJob =
    lockRecord &&
    lockRecord.jobId === process.env.FRAME_TASK_ID &&
    lockRecord.childPid === process.pid &&
    !operation.transactions;
  const release = ownedJob ? () => {} : workspace.lock(id, "narrate");
  try {
    return await produce(workspace, id, configPath, options);
  } finally {
    release();
  }
}
async function produce(
  workspace,
  id,
  configPath,
  { plan, signal, onProgress = () => {} } = {},
) {
  signal?.throwIfAborted();
  let config = plan;
  if (!config) {
    const file = workspace.file(id, configPath);
    if (fs.statSync(file).size > 1024 * 1024)
      throw new Error("Narration plan exceeds 1 MiB");
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  if (
    !config ||
    !Array.isArray(config.sentences) ||
    !config.sentences.length ||
    config.sentences.length > 200
  )
    throw new Error("Use 1..200 narration sentences");
  const mode = config.mode ?? "absolute";
  if (!["absolute", "sequential"].includes(mode))
    throw new Error("Narration mode must be absolute or sequential");
  if (
    config.duration !== undefined &&
    (!finite(config.duration) || !config.duration)
  )
    throw new Error("Invalid narration duration");
  if (!finite(config.start ?? 0) || !finite(config.gap ?? 0.2, 60))
    throw new Error("Invalid sequential start or gap");
  if (
    config.allowOverlap !== undefined &&
    typeof config.allowOverlap !== "boolean"
  )
    throw new Error("allowOverlap must be boolean");
  const speechConfig = readSpeechConfig(
    workspace,
    id,
    config.speechConfig ?? SPEECH_CONFIG,
    !config.speechConfig,
  );
  const ids = new Set();
  const prepared = config.sentences.map((sentence) => {
    if (
      !validId(sentence.id) ||
      ids.has(sentence.id) ||
      typeof sentence.text !== "string" ||
      !sentence.text.trim() ||
      sentence.text.length > 4096
    )
      throw new Error(
        "Each sentence needs a unique id and 1..4096 characters of text",
      );
    ids.add(sentence.id);
    if (mode === "absolute" && !finite(sentence.start))
      throw new Error("Each sentence needs an absolute nonnegative start");
    if (mode === "sequential" && sentence.start !== undefined)
      throw new Error(
        "Sequential mode measures start times; remove sentence.start or use absolute mode",
      );
    if (
      sentence.budget !== undefined &&
      (!finite(sentence.budget) || !sentence.budget)
    )
      throw new Error("Invalid sentence time budget");
    if (sentence.gapAfter !== undefined && !finite(sentence.gapAfter, 60))
      throw new Error("Invalid sentence gapAfter");
    if (sentence.speaker !== undefined && !validId(sentence.speaker))
      throw new Error("Invalid speaker id");
    if (sentence.audio) {
      const source = workspace.file(id, sentence.audio);
      if (
        !fs.statSync(source).isFile() ||
        fs.statSync(source).size > 128 * 1024 * 1024
      )
        throw new Error("Source audio must be a file up to 128 MiB");
      return { sentence, source, sourceHash: hash(fs.readFileSync(source)) };
    }
    return {
      sentence,
      resolved: resolveSpeech(workspace, id, config, sentence, speechConfig),
    };
  });
  // Confirm local processing tools before submitting any possibly billable sentence.
  await checkedProcess(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], {
    signal,
  });
  await checkedProcess(process.env.FFPROBE_PATH || "ffprobe", ["-version"], {
    signal,
  });
  const cache = workspace.file(id, ".cache/narration", true);
  fs.mkdirSync(cache, { recursive: true });
  const timeline = [];
  let cursor = config.start ?? 0;
  // Cache-check every sentence first so missing credentials fail before partial billing.
  for (const item of prepared) {
    item.key = hash(
      JSON.stringify({
        schemaVersion: 2,
        text: item.sentence.text,
        source: item.sourceHash,
        provider: item.resolved?.fingerprint,
      }),
    );
    item.wav = workspace.file(
      id,
      ".cache/narration/" + item.key + ".wav",
      true,
    );
    item.receipt = workspace.file(
      id,
      ".cache/narration/" + item.key + ".json",
      true,
    );
    item.cached = false;
    if (fs.existsSync(item.wav) && fs.existsSync(item.receipt)) {
      try {
        item.cached =
          JSON.parse(fs.readFileSync(item.receipt, "utf8")).sha256 ===
          hash(fs.readFileSync(item.wav));
      } catch {
        /* Rebuild only this invalid receipt. */
      }
    }
    if (!item.cached && item.resolved?.missing.length)
      throw new Error(
        "Missing speech environment variables: " +
          item.resolved.missing.join(", "),
      );
  }
  for (const [index, item] of prepared.entries()) {
    signal?.throwIfAborted();
    const { sentence, source, resolved, key, wav, receipt, cached } = item;
    if (!cached) {
      const tag = randomUUID();
      const input = workspace.file(
        id,
        ".cache/narration/" + tag + ".source",
        true,
      );
      const temp = workspace.file(id, ".cache/narration/" + tag + ".wav", true);
      const tempReceipt = workspace.file(
        id,
        ".cache/narration/" + tag + ".json",
        true,
      );
      try {
        if (!source)
          fs.writeFileSync(
            input,
            await synthesizeSpeech(resolved, sentence.text, { signal }),
            { flag: "wx" },
          );
        if (source && hash(fs.readFileSync(source)) !== item.sourceHash)
          throw new Error(
            "Source audio changed during narration; retry with the current plan",
          );
        await checkedProcess(
          process.env.FFMPEG_PATH || "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            source ?? input,
            "-vn",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-c:a",
            "pcm_s16le",
            "-fs",
            String(128 * 1024 * 1024),
            "-n",
            temp,
          ],
          { signal },
        );
        const probe = await probeMedia(temp);
        if (
          !probe.streams.some((s) => s.codec_type === "audio") ||
          fs.statSync(temp).size >= 128 * 1024 * 1024
        )
          throw new Error("Speech audio is invalid or too long");
        fs.writeFileSync(
          tempReceipt,
          JSON.stringify({ key, sha256: hash(fs.readFileSync(temp)) }),
          { flag: "wx" },
        );
        fs.renameSync(temp, wav);
        fs.renameSync(tempReceipt, receipt);
      } finally {
        for (const file of [input, temp, tempReceipt])
          fs.rmSync(file, { force: true });
      }
    }
    const probe = await probeMedia(wav),
      duration = Number(probe.format.duration);
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("Invalid measured sentence duration");
    if (sentence.budget !== undefined && duration > sentence.budget + 0.001)
      throw new Error(
        `Sentence ${sentence.id} exceeds its time budget: ${duration}s > ${sentence.budget}s`,
      );
    const start = mode === "sequential" ? cursor : sentence.start;
    const end = start + duration;
    if (
      end > 3600 ||
      (config.duration !== undefined && end > config.duration + 1 / 48000)
    )
      throw new Error(
        "Narration exceeds its total duration; revise the text or schedule",
      );
    timeline.push({
      id: sentence.id,
      text: sentence.text,
      speaker: sentence.speaker ?? "narrator",
      provider: resolved?.provider ?? "file",
      voice: resolved?.voice ?? null,
      start,
      end,
      duration,
      key,
      cached,
      wav,
    });
    cursor = end + (sentence.gapAfter ?? config.gap ?? 0.2);
    onProgress({
      completed: index + 1,
      total: prepared.length,
      sentence: sentence.id,
      cached,
    });
  }
  timeline.sort((a, b) => a.start - b.start);
  let lastEnd = 0;
  for (const item of timeline) {
    if (!config.allowOverlap && item.start < lastEnd - 0.001)
      throw new Error("Narration sentences overlap: " + item.id);
    lastEnd = Math.max(lastEnd, item.end);
  }
  const duration = config.duration ?? lastEnd;
  const clean = timeline.map(({ wav, cached, ...item }) => item);
  const version = hash(
    JSON.stringify({ schemaVersion: 2, duration, timeline: clean }),
  );
  const relative = "public/narration/" + version;
  const directory = workspace.file(id, relative);
  const manifest = workspace.file(id, relative + "/timeline.json");
  const voicePath = workspace.file(id, relative + "/voice.wav");
  const captionPath = workspace.file(id, relative + "/captions.srt");
  if (!fs.existsSync(directory)) {
    const temp = workspace.file(
      id,
      ".cache/narration/bundle-" + randomUUID(),
      true,
    );
    fs.mkdirSync(temp);
    try {
      const args = ["-v", "error"];
      for (const item of timeline) args.push("-i", item.wav);
      const filters =
        timeline
          .map(
            (item, i) =>
              `[${i}:a]adelay=${Math.round(item.start * 48000)}S:all=1[s${i}]`,
          )
          .join(";") +
        ";" +
        timeline.map((_, i) => `[s${i}]`).join("") +
        `amix=inputs=${timeline.length}:normalize=0,apad=pad_dur=${duration},atrim=end_sample=${Math.round(duration * 48000)},asetpts=N/SR/TB[out]`;
      args.push(
        "-filter_complex",
        filters,
        "-map",
        "[out]",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        "-fs",
        String(Math.ceil(duration * 192000 + 1024 * 1024)),
        path.join(temp, "voice.wav"),
      );
      await checkedProcess(process.env.FFMPEG_PATH || "ffmpeg", args, {
        timeoutMs: 120000,
        signal,
      });
      const mixed = await probeMedia(path.join(temp, "voice.wav"));
      if (Math.abs(Number(mixed.format.duration) - duration) > 1 / 48000)
        throw new Error(
          "Narration mix length differs from the measured timeline",
        );
      const captions =
        timeline
          .map(
            (item, i) =>
              `${i + 1}\n${stamp(item.start)} --> ${stamp(item.end)}\n${item.text}`,
          )
          .join("\n\n") + "\n";
      fs.writeFileSync(path.join(temp, "captions.srt"), captions);
      fs.writeFileSync(
        path.join(temp, "timeline.json"),
        JSON.stringify(
          {
            schemaVersion: 2,
            version,
            duration,
            synthetic: timeline.some((t) => t.provider !== "file"),
            voiceSha256: hash(fs.readFileSync(path.join(temp, "voice.wav"))),
            captionsSha256: hash(captions),
            sentences: clean,
          },
          null,
          2,
        ),
      );
      fs.mkdirSync(path.dirname(directory), { recursive: true });
      fs.renameSync(temp, directory);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  } else {
    const saved = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (
      saved.voiceSha256 !== hash(fs.readFileSync(voicePath)) ||
      saved.captionsSha256 !== hash(fs.readFileSync(captionPath))
    )
      throw new Error(
        "Existing narration bundle is corrupt; preserve it and inspect before regenerating",
      );
  }
  return {
    status: "passed",
    directory,
    manifest,
    version,
    duration,
    cacheHits: timeline.filter((t) => t.cached).length,
    voicePath,
    captionPath,
    audioTrack: {
      id: "voice",
      name: "旁白与对白",
      kind: "file",
      src: `films/${id}/narration/${version}/voice.wav`,
    },
    subtitles: timeline.map(({ start, end, text }) => ({ start, end, text })),
    sentences: clean,
    nextAction:
      "Use audioTrack and subtitles in project.ts; frame_read_speech can return inline audio for audio-capable clients. Listening quality has not been reviewed.",
  };
}
