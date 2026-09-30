import { inspectAudio } from "./audio-inspect.mjs";
import { parseCommandArgs } from "./film-command-catalog.mjs";
import { errorRecovery } from "./tool-errors.mjs";
import { transcodeAudio } from "./audio-media.mjs";
import { probeMedia } from "./media-probe.mjs";
try {
  const { values, positionals } = parseCommandArgs("audio-media");
  const [id, action = "probe"] = positionals;
  if (
    !id ||
    !values.src ||
    !["probe", "inspect", "transcode"].includes(action) ||
    positionals.length > 2
  )
    throw Error(
      "film audio-media <id> probe|transcode --src films/<id>/source [--out public/compatible.wav]",
    );
  console.log(
    JSON.stringify(
      action === "inspect"
        ? await inspectAudio(process.cwd(), id, values.src)
        : action === "probe"
          ? await probeMedia(process.cwd(), id, values.src)
          : await transcodeAudio(process.cwd(), id, values),
      null,
      2,
    ),
  );
} catch (e) {
  console.log(JSON.stringify({ schemaVersion: 1, status: "failed", error: errorRecovery(e) }));
  process.exitCode = 1;
}
