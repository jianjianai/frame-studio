import { exportAudio } from "./audio-export.mjs";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { ProjectService } from "./project-service.mjs";
import { audioContext, audioEdit } from "./audio-service.mjs";
import {
  audioEngines,
  audioProcessors,
} from "../src/engine/audio-document.mjs";
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      input: { type: "string" },
      "dry-run": { type: "boolean" },
      format: { type: "string" },
      stems: { type: "boolean" },
      start: { type: "string" },
      end: { type: "string" },
    },
  });
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
        ? JSON.parse(
            fs.readFileSync(values.input === "-" ? 0 : values.input, "utf8"),
          )
        : null;
    console.log(
      JSON.stringify(
        action === "get"
          ? audioContext(service, id)
          : audioEdit(service, id, { ...request, dryRun: !!values["dry-run"] }),
        null,
        values.json ? 0 : 2,
      ),
    );
  }
} catch (e) {
  console.error(
    JSON.stringify({ status: "failed", code: e.code, error: e.message }),
  );
  process.exitCode = 1;
}
