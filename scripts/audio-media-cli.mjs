import { inspectAudio } from "./audio-inspect.mjs";
import { parseArgs } from "node:util";
import { transcodeAudio } from "./audio-media.mjs";
import { probeMedia } from "./media-probe.mjs";
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
  console.error(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
