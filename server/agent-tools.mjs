import fs from "node:fs";
import path from "node:path";
import { confined, problem } from "./security.mjs";
import { fileSha256 } from "./project-files.mjs";
import { command } from "./process.mjs";
function materialNextAction(project, mime, speech, url, filename) {
  const context = "node scripts/work-tool.mjs context",
    cli = "pnpm --silent film",
    request = `projects/${project}/production/material-import.json`,
    type = String(mime ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase(),
    extension = path.extname(filename ?? "").toLowerCase(),
    midi =
      [".mid", ".midi"].includes(extension) ||
      [
        "audio/midi",
        "audio/x-midi",
        "audio/sp-midi",
        "application/x-midi",
      ].includes(type),
    soundfont =
      extension === ".sf2" ||
      ["audio/sf2", "audio/x-sf2", "application/x-sf2"].includes(type);
  if (!speech && (midi || soundfont))
    return `Run ${context}, ${cli} capabilities --id soundfont --json and ${cli} reference audio --json. The filename or MIME indicates a ${midi ? "MIDI score" : "SoundFont SF2 bank"} resource; validate its actual format. ${midi ? `Parse the MIDI at ${url} into the required event score and choose a separately imported compatible SF2 bank.` : `Use ${url} as a validated SF2 bank and prepare the required MIDI event score.`} Provide the bank's SHA-256 from production/materials.json, foley and levels to createSampledScoreAudio({score,foley,bank,sha256,levels}) in src/engine/soundfont-audio.ts. Export generators from the project module loaded by loadAudio and connect a generated source with engine:"soundfont" through the authoritative audio.json (or legacy generated audioTracks); read ${cli} reference audio-v7 --json for registration. MIDI/SF2 are generator inputs, not decoded file audio or visual clip sources. Importing does not enable playback.`;
  if (
    !speech &&
    ([".glb", ".gltf"].includes(extension) ||
      ["model/gltf-binary", "model/gltf+json"].includes(type))
  )
    return `Run ${context}, ${cli} capabilities --id three --json and ${cli} reference composition --json before using ${url}. Validate this GLB/glTF resource and import any referenced buffers/textures into the same work; a single-file import does not collect companion files or repair relative references. Use a project-local scene module with createThreeScene from src/engine/scene-adapters.ts and loadGltf(url,renderer) from src/engine/three-assets.ts. First inspect context.projectInfo.renderer: for a Remotion root, use the actual context.entrypoints.remotion and connect the scene through FrameScene; edit a Canvas child visual.json only if that FrameScene actually consumes it. For other renderers with an authoritative visual.json composition, register that module and a scene clip. A loadVisual declaration alone does not make a model visible in the React root. GLB/glTF is a scene resource, not a visual source.kind. Importing does not add a model to the picture.`;
  if (
    !speech &&
    ([".woff", ".woff2", ".ttf", ".otf"].includes(extension) ||
      type.startsWith("font/") ||
      /^application\/(?:x-font-|font-)/.test(type))
  )
    return `Run ${context} and ${cli} capabilities --category visual --json, then validate the font resource at ${url}. Load it through FontFace for project-local Canvas/scene text or @font-face in project-local CSS for Remotion/DOM text. Await font readiness before rendering the frame. Fonts configure scene/component text; they are not standalone visual clip or file audio sources. Importing does not change the active font.`;
  if (
    speech ||
    type.startsWith("audio/") ||
    [
      ".wav",
      ".flac",
      ".mp3",
      ".ogg",
      ".opus",
      ".m4a",
      ".aac",
      ".aiff",
      ".aif",
      ".caf",
      ".wma",
    ].includes(extension)
  )
    return `Run ${context} and ${cli} audio ${project} get --json before wiring ${url}. If authority.audio.mode is document, edit the authoritative audio.json with ${cli} audio ${project} edit --input ${request} --json, using its returned sha256 as expectedSha256. If authority.audio.mode is legacy, the same command migrates the returned current mix atomically: use expectedSha256:null and the returned projectSha256. Preserve existing sources/tracks/clips and use put operations to add a file source, its track and a timed clip. Do not change stale project.ts audioTracks when audio.json owns the mix. Probe the returned URL with ${cli} audio-media ${project} probe --src ${url} --json to confirm codec support and measure duration before timing the clip and subtitles. Importing does not enable playback.`;
  const kind =
    type.startsWith("image/") ||
    [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".svg",
      ".avif",
      ".bmp",
    ].includes(extension)
      ? "image"
      : type.startsWith("video/") ||
          [".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi"].includes(extension)
        ? "video"
        : null;
  if (kind)
    return `Run ${context} and first inspect context.projectInfo.renderer before wiring ${url}. If the renderer is remotion, start with the actual context.entrypoints.remotion (normally composition.tsx), read ${cli} reference remotion --json, and integrate the ${kind} in that React root. Edit visual.json only after verifying that a specific FrameScene used by this root consumes that Canvas child document. A declared loadVisual alone does not prove visual.json is visible. For other renderers, inspect authority.visual: in document mode, read ${cli} composition ${project} get --json, then use ${cli} composition ${project} edit --input ${request} --json with the returned sha256 as expectedSha256 to add a ${kind} source clip using src ${url} and explicit start/duration; in code mode, edit the returned project-local scene entrypoint. Video sound is enabled explicitly through the visual clip audio settings or the component; an image or video is not a file audioTrack. Importing does not modify the picture or start playback.`;
  if (
    extension === ".json" ||
    type === "application/json" ||
    type.endsWith("+json")
  )
    return `Run ${context} and inspect the contents of ${url}; a JSON extension or MIME does not identify an animation. Query ${cli} capabilities --id lottie --json and read ${cli} reference composition --json only if this is intended as Lottie. Validate the parsed data with validateLottie from src/engine/lottie-document.mjs; only a valid self-contained Lottie animation may use a lottie visual source or createLottieScene. First inspect context.projectInfo.renderer: for a Remotion root, use its actual context.entrypoints.remotion and connect the Lottie Canvas scene through FrameScene; edit a child visual.json only after confirming this FrameScene consumes it. A loadVisual declaration alone does not prove the JSON affects the React root. Other JSON belongs in the appropriate project-local code/configuration after checking the relevant capability. Do not invent a JSON visual source.kind. Importing does not enable animation playback.`;
  return `Imported ${url} as a project resource. Run ${context} and ${cli} capabilities --json, inspect the actual file format, and confirm a documented adapter or project-local implementation before connecting it. Filename/MIME and successful import do not prove runtime support. Do not invent a visual source.kind or treat an unclassified resource as decoded file audio. Importing does not change the picture or enable playback.`;
}
export function agentTools({
  app,
  db,
  data,
  assets,
  actions,
  localMode = false,
}) {
  app.post("/api/agent/action", async (req) => {
    const task = req.agentTask;
    const runRoot = task?.runRoot || path.join(data, "runs", task?.id || "");
    if (!task) throw problem(403, "Task credential required");
    const { name, args = {} } = req.body || {};
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw problem(400, "Tool args must be a JSON object");
    if (task.kind === "paseo" && ["question_create", "question_poll"].includes(name)) throw problem(400, "Use the native Paseo question and permission tools");
    if (name === "question_create")
      return actions.interactions.create(task.id, args);
    if (name === "question_poll") {
      if (typeof args.id !== "string" || !/^[0-9a-f-]{36}$/i.test(args.id))
        throw problem(400, "Invalid question id");
      return actions.interactions.poll(task.id, args.id);
    }
    if (name === "preview") {
      if (Object.keys(args).length)
        throw problem(
          400,
          "preview takes no arguments; work and draft are scoped to this task",
        );
      const work = await db.one(
        "SELECT id FROM works WHERE repo=$1 AND project=$2 AND NOT deleted",
        [task.repo, task.project],
      );
      if (!work) throw problem(404, "Current work not found");
      return actions.call("works_live_preview", {
        id: work.id,
        ...(task.kind === "paseo" ? { source: "paseo", paseoAgent: task.paseoAgent } : { task: task.id }),
        ai: true,
      });
    }
    if (name === "assets") {
      const limit = args.limit ?? 60,
        offset = args.offset ?? 0;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200 ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        throw problem(
          400,
          "assets requires limit 1..200 and a nonnegative integer offset",
        );
      return actions.call("assets_list", {
        search: args.search || "",
        limit,
        offset,
        repo: task.repo,
      });
    }
    if (name === "engines") return actions.call("engines_list", {});
    if (
      [
        "speech_providers",
        "engines_discover",
        "speech_status",
        "speech_cancel",
      ].includes(name)
    )
      return actions.call(name, args);
    if (name === "engine_add") {
      if (args.id)
        throw problem(
          403,
          "Task AI can add a custom engine, not replace existing configurations",
        );
      return actions.call("engines_save", args);
    }
    if (name === "engine_test") {
      const preview = await actions.call("speech_test", args);
      const relative = `projects/${task.project}/.cache/speech/${preview.task}.${preview.mime === "audio/wav" ? "wav" : "mp3"}`;
      const target = confined(runRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(
        confined(path.join(data, "runs", preview.task), preview.path),
        target,
      );
      if (process.platform !== "win32" && !localMode)
        await command("chown", ["1000:1000", path.dirname(target), target]);
      return {
        path: relative,
        temporary: true,
        elapsedMs: preview.elapsedMs,
        requestId: preview.requestId,
        applied: preview.applied,
        warnings: preview.warnings,
        expiresAt: preview.expiresAt,
      };
    }
    if (name === "use" || name === "speech") {
      const speechResult =
        name === "speech"
          ? await actions.call("speech_generate", {
              ...args,
              repo: task.repo,
              project: undefined,
            })
          : null;
      const asset = speechResult?.asset || (await assets.get(args.asset));
      if (
        !(await db.one(
          "SELECT asset FROM asset_repos WHERE asset=$1 AND repo=$2",
          [asset.id, task.repo],
        ))
      )
        throw problem(403, "Material does not belong to this repository");
      if (asset.deleted) throw problem(409, "Material is in recycle bin");
      const root = path.join(runRoot, "projects", task.project),
        ext = path
          .extname(asset.name)
          .replace(/[^.a-zA-Z0-9]/g, "")
          .slice(0, 12);
      const relative = `public/imports/${asset.sha.slice(0, 20)}${ext}`,
        dest = confined(root, relative),
        url = `films/${task.project}/${relative.slice(7)}`;
      return db.lock("agent-material:" + task.id, async () => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest) && (await fileSha256(dest)) !== asset.sha)
          throw problem(409, "Material file was modified");
        await fs.promises.copyFile(path.join(data, "blobs", asset.sha), dest);
        const manifest = confined(root, "production/materials.json");
        fs.mkdirSync(path.dirname(manifest), { recursive: true });
        const refs = fs.existsSync(manifest)
          ? JSON.parse(fs.readFileSync(manifest, "utf8"))
          : [];
        if (!Array.isArray(refs))
          throw problem(409, "Invalid material manifest");
        fs.writeFileSync(
          manifest,
          JSON.stringify(
            [
              ...refs.filter((r) => r.asset !== asset.id),
              {
                asset: asset.id,
                path: relative,
                sha256: asset.sha,
                source: asset.license,
                name: asset.name,
              },
            ],
            null,
            2,
          ),
        );
        if (process.platform !== "win32" && !localMode)
          await command("chown", [
            "1000:1000",
            path.dirname(dest),
            dest,
            path.dirname(manifest),
            manifest,
          ]);
        return {
          asset: asset.id,
          path: `projects/${task.project}/${relative}`,
          url,
          name: asset.name,
          mime: asset.mime,
          bytes: Number(asset.bytes),
          source: asset.license,
          ...(speechResult
            ? {
                requestId: speechResult.requestId,
                applied: speechResult.applied,
                warnings: speechResult.warnings,
              }
            : {}),
          nextAction: materialNextAction(
            task.project,
            asset.mime,
            name === "speech",
            url,
            asset.name,
          ),
        };
      });
    }
    throw problem(
      403,
      "Allowed: preview, assets, engines, speech_providers, engines_discover, speech_status, speech_cancel, engine_add, engine_test, use and speech",
    );
  });
}
