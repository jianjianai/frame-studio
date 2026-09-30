import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectPath } from "./project-paths.mjs";
import { createRenderSession } from "./render-session.mjs";
import { readProject } from "./project-metadata.mjs";
import {
  writeAudio,
  analyzeAudio,
  checkedProcess,
} from "./production-media.mjs";
/** Frozen source mix; stems include their route, sends and master processing. */
export async function exportAudio(
  root,
  id,
  { format = "wav", stems = false, start = 0, end, signal } = {},
) {
  const codecs = {
    wav: ["pcm_s24le"],
    flac: ["flac"],
    mp3: ["libmp3lame", "-b:a", "192k"],
    ogg: ["libopus", "-b:a", "160k"],
    m4a: ["aac", "-b:a", "192k"],
  };
  if (!codecs[format]) throw Error("Unsupported audio export format");
  const { meta } = readProject(projectPath(root, id, "project.ts"));
  end ??= meta.duration;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > meta.duration
  )
    throw Error("Invalid audio export range");
  const key = randomUUID(),
    temporary = projectPath(root, id, ".cache/audio-export/" + key),
    output = projectPath(root, id, "exports/audio-" + key);
  fs.mkdirSync(temporary, { recursive: true });
  const session = await createRenderSession({ root, width: 320, signal });
  let page;
  const abort = () => { void page?.close().catch(() => {}); void page?.remotion?.close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    page = await session.page(id, { purpose: "media" });
    signal?.throwIfAborted();
    const channels =
      meta.audioDocument?.tracks ??
      meta.audioTracks ??
      (meta.audio ? [{ id: "main", name: "main" }] : []);
    const files = [];
    for (const track of [
      { id: undefined, name: "Mix" },
      ...(stems ? channels : []),
      ...(stems && meta.renderer === 'remotion' ? [{id:undefined,name:'Remotion components',native:true}] : []),
    ]) {
      signal?.throwIfAborted();
      const name = track.native ? "remotion-components" : track.id
        ? "stem-" + track.id.replace(/[^a-zA-Z0-9_-]/g, "_")
        : "mix";
      const raw = path.join(temporary, name + "-input.wav"),
        target = path.join(temporary, name + "." + format);
      if(track.native)await page.remotionAudio(raw,start,end-start,"float32",true);
      else await writeAudio(page, raw, start, end - start, track.id, "float32");
      await checkedProcess(
        process.env.FFMPEG_PATH || "ffmpeg",
        ["-v", "error", "-i", raw, "-c:a", ...codecs[format], "-n", target],
        { signal },
      );
      fs.unlinkSync(raw);
      const analysis = await analyzeAudio(target);
      files.push({
        track: track.id ?? null,
        ...(track.native ? {engine:'remotion'} : {}),
        name: track.name,
        file: path.basename(target),
        analysis,
      });
    }
    const report = {
      schemaVersion: 1,
      project: id,
      input: session.input(id),
      start,
      end,
      sampleRate: 48000,
      channels: 2,
      format,
      stems:
        "Soloed through their bus/send/master chain; nonlinear processing means stems may not sum to mix",
      files,
    };
    fs.writeFileSync(
      path.join(temporary, "audio-export.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.renameSync(temporary, output);
    return { directory: output, ...report };
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      await session.close();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
