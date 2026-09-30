import { parseCommandArgs } from "./film-command-catalog.mjs";
import { errorRecovery } from "./tool-errors.mjs";
import { probeMedia, transcodeMedia } from "./media-probe.mjs";
try {
  const { values, positionals } = parseCommandArgs("media");
  const [id, action = "probe"] = positionals;
  if (
    !id ||
    !values.src ||
    positionals.length > 2 ||
    !["probe", "transcode"].includes(action)
  )
    throw new Error(
      "film media <id> probe|transcode --src films/<id>/file [--out public/compatible.webm]",
    );
  const value =
    action === "probe"
      ? await probeMedia(process.cwd(), id, values.src)
      : await transcodeMedia(process.cwd(), id, values);
  console.log(JSON.stringify(value, null, 2));
} catch (e) {
  console.log(JSON.stringify({ schemaVersion: 1, status: "failed", error: errorRecovery(e) }));
  process.exitCode = 1;
}
