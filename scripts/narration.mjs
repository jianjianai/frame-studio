import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ProjectService } from "./project-service.mjs";
import { checkedProcess, probeMedia } from "./production-media.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
/** Provider-neutral sentence pipeline; no cloud provider or credentials are implicit. */
export async function produceNarration(root, id, configPath) {
  const workspace = new ProjectService(root, { projects: [id] });
  const config = JSON.parse(
    fs.readFileSync(workspace.file(id, configPath), "utf8"),
  );
  if (
    !Array.isArray(config.sentences) ||
    !config.sentences.length ||
    config.sentences.length > 200
  )
    throw new Error("Use 1..200 narration sentences");
  let provider;
  const providerHashes = [];
  if (config.provider) {
    const source = workspace.file(id, config.provider);
    if (!/\.mjs$/.test(source))
      throw new Error("Narration provider must be a project-local .mjs module");
    for (const file of [
      config.provider,
      ...(config.providerDependencies ?? []),
    ])
      providerHashes.push([
        file,
        hash(fs.readFileSync(workspace.file(id, file))),
      ]);
    provider = await import(
      pathToFileURL(source).href + "?v=" + hash(JSON.stringify(providerHashes))
    );
    if (typeof provider.synthesize !== "function")
      throw new Error(
        "Provider must export synthesize({text,voice,settings,signal}) returning WAV bytes",
      );
  }
  const cache = workspace.file(id, ".cache/narration", true);
  fs.mkdirSync(cache, { recursive: true });
  const ids = new Set(),
    timeline = [];
  for (const sentence of config.sentences) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(sentence.id) ||
      ids.has(sentence.id) ||
      typeof sentence.text !== "string" ||
      !sentence.text.trim()
    )
      throw new Error("Each sentence needs a unique id and nonempty text");
    ids.add(sentence.id);
    if (!Number.isFinite(sentence.start) || sentence.start < 0)
      throw new Error("Each sentence needs an absolute nonnegative start");
    const source = sentence.audio ? workspace.file(id, sentence.audio) : null;
    const key = hash(
      JSON.stringify({
        text: sentence.text,
        voice: sentence.voice ?? config.voice,
        settings: sentence.settings ?? config.settings,
        providerHashes,
        source: source ? hash(fs.readFileSync(source)) : null,
      }),
    );
    const wav = workspace.file(id, ".cache/narration/" + key + ".wav", true);
    const receipt = wav + ".json";
    let cached = false;
    if (fs.existsSync(wav) && fs.existsSync(receipt))
      cached =
        JSON.parse(fs.readFileSync(receipt, "utf8")).sha256 ===
        hash(fs.readFileSync(wav));
    if (!cached) {
      const temp = wav + "." + randomUUID() + ".tmp.wav";
      try {
        if (source)
          await checkedProcess(process.env.FFMPEG_PATH || "ffmpeg", [
            "-v",
            "error",
            "-i",
            source,
            "-vn",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-c:a",
            "pcm_s16le",
            "-y",
            temp,
          ]);
        else {
          if (!provider)
            throw new Error(
              "Sentence needs audio or an explicitly configured project provider: " +
                sentence.id,
            );
          const bytes = await provider.synthesize({
            text: sentence.text,
            voice: sentence.voice ?? config.voice,
            settings: sentence.settings ?? config.settings,
            signal: AbortSignal.timeout(120000),
          });
          if (
            !(bytes instanceof Uint8Array) ||
            bytes.length > 128 * 1024 * 1024
          )
            throw new Error("Provider must return bounded WAV bytes");
          fs.writeFileSync(temp, bytes);
        }
        const probe = await probeMedia(temp);
        if (!probe.streams.some((stream) => stream.codec_type === "audio"))
          throw new Error("Narration provider returned no audio");
        fs.renameSync(temp, wav);
        fs.writeFileSync(
          receipt,
          JSON.stringify({ key, sha256: hash(fs.readFileSync(wav)) }),
        );
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
    const probe = await probeMedia(wav),
      duration = Number(probe.format.duration);
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("Invalid measured sentence duration");
    timeline.push({
      id: sentence.id,
      text: sentence.text,
      start: sentence.start,
      end: sentence.start + duration,
      duration,
      key,
      cached,
      wav,
    });
    if (sentence.budget !== undefined && duration > sentence.budget + 0.001)
      throw new Error(
        `Sentence ${sentence.id} exceeds its time budget: ${duration}s > ${sentence.budget}s`,
      );
  }
  timeline.sort((a, b) => a.start - b.start);
  for (let i = 1; i < timeline.length; i++)
    if (timeline[i].start < timeline[i - 1].end - 0.001)
      throw new Error("Narration sentences overlap: " + timeline[i].id);
  const duration = config.duration ?? timeline.at(-1).end;
  if (
    !Number.isFinite(duration) ||
    duration < timeline.at(-1).end ||
    duration > 3600
  )
    throw new Error("Invalid narration duration");
  const version = hash(
    JSON.stringify({
      duration,
      timeline: timeline.map(({ wav, cached, ...item }) => item),
    }),
  );
  const directory = workspace.file(id, "public/narration/" + version);
  const manifest = path.join(directory, "timeline.json");
  if (!fs.existsSync(manifest)) {
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
              `[${i}:a]aresample=48000,adelay=${Math.round(item.start * 1000)}:all=1[s${i}]`,
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
        "-t",
        String(duration),
        "-fs",
        String(Math.ceil(duration * 192000 + 1024 * 1024)),
        path.join(temp, "voice.wav"),
      );
      await checkedProcess(process.env.FFMPEG_PATH || "ffmpeg", args, {
        timeoutMs: 120000,
      });
      const mixed = await probeMedia(path.join(temp, "voice.wav"));
      if (Math.abs(Number(mixed.format.duration) - duration) > 1 / 48000)
        throw new Error(
          "Narration mix length differs from the measured timeline",
        );
      const stamp = (time) => {
        const ms = Math.round(time * 1000);
        return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
      };
      fs.writeFileSync(
        path.join(temp, "captions.srt"),
        timeline
          .map(
            (item, i) =>
              `${i + 1}\n${stamp(item.start)} --> ${stamp(item.end)}\n${item.text}`,
          )
          .join("\n\n"),
      );
      fs.writeFileSync(
        path.join(temp, "timeline.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            version,
            duration,
            voiceSha256: hash(fs.readFileSync(path.join(temp, "voice.wav"))),
            sentences: timeline.map(({ wav, ...item }) => item),
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
      saved.voiceSha256 !==
      hash(fs.readFileSync(path.join(directory, "voice.wav")))
    )
      throw new Error("Existing narration bundle is corrupt");
  }
  return {
    status: "passed",
    directory,
    manifest,
    version,
    cacheHits: timeline.filter((item) => item.cached).length,
    audioTrack: {
      id: "voice",
      name: "旁白",
      kind: "file",
      src: `films/${id}/narration/${version}/voice.wav`,
    },
    subtitles: timeline.map(({ start, end, text }) => ({ start, end, text })),
  };
}
