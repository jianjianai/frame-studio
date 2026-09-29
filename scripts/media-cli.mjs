import { parseArgs } from "node:util";
import { probeMedia, transcodeMedia } from "./media-probe.mjs";
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      src: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean" },
    },
  });
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
  console.error(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
