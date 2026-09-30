import { exportAudio } from "./audio-export.mjs";
import { readJsonInput } from "./cli-input.mjs";
import { audioEditRequestSchema } from "../src/engine/document-edit.mjs";
import { parseCommandArgs } from "./film-command-catalog.mjs";
import { errorRecovery } from "./tool-errors.mjs";
import { ProjectService } from "./project-service.mjs";
import { audioContext, audioEdit } from "./audio-service.mjs";
import {
  audioEngines,
  audioProcessors,
} from "../src/engine/audio-document.mjs";
try {
  const { values, positionals } = parseCommandArgs("audio");
  const [id, action = "get"] = positionals;
  if (id === "engines")
    console.log(
      JSON.stringify(
        { engines: audioEngines, processors: audioProcessors },
        null,
        2,
      ),
    );
  else {
    if (
      !id ||
      positionals.length > 2 ||
      !["get", "edit", "export"].includes(action)
    )
      throw Error(
        "film audio <id> [edit --input request.json] [--dry-run] --json",
      );
    const service = new ProjectService(process.cwd());
    if (action === "export") {
      const release = service.lock(id, "audio-export");
      try {
        console.log(
          JSON.stringify(
            await exportAudio(process.cwd(), id, {
              format: values.format,
              stems: values.stems,
              start: values.start === undefined ? 0 : Number(values.start),
              end: values.end === undefined ? undefined : Number(values.end),
            }),
            null,
            2,
          ),
        );
      } finally {
        release();
      }
      process.exit(0);
    }
    const request =
      action === "edit"
        ? await readJsonInput(values.input)
        : null;
    console.log(
      JSON.stringify(
        action === "get"
          ? audioContext(service, id)
          : audioEdit(service, id, audioEditRequestSchema.parse({ ...request, ...(values["dry-run"] === undefined ? {} : { dryRun: values["dry-run"] }) })),
        null,
        values.json ? 0 : 2,
      ),
    );
  }
} catch (e) {
  console.log(JSON.stringify({ schemaVersion: 1, status: "failed", error: errorRecovery(e) }));
  process.exitCode = 1;
}
