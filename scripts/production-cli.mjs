import { parseCommandArgs } from "./film-command-catalog.mjs";
import { readJsonInput } from "./cli-input.mjs";
import { sourceEditRequestSchema, sourcePatchRequestSchema } from "../src/contracts/source-edit.mjs";
import { commandReport } from "./command-report.mjs";
import { errorRecovery } from "./tool-errors.mjs";
import { ProjectService } from "./project-service.mjs";
import { executeProject } from "./project-execution.mjs";
import {
  reviewSegment,
  verifyDelivery,
  compareReviews,
  recordReview,
} from "./production-media.mjs";
import { exportProduction } from "./production-export.mjs";
import { produceNarration } from "./narration.mjs";
import { createProjectWorkspace } from "./project-workspace.mjs";
import { checkPlayback } from "./playback-check.mjs";

try {
  const [command, ...args] = process.argv.slice(2);
  const { values, positionals } = parseCommandArgs(command, args);
  const [id] = positionals;
  const root = process.cwd();
  const workspace = new ProjectService(root, { projects: [id] });
  const number = (key) =>
    values[key] === undefined ? undefined : Number(values[key]);
  const payload = () => readJsonInput(values.input);
  if (positionals.length !== 1)
    throw new Error("Expected one project id; run pnpm film help");
  let result;
  if (command === "search")
    result = workspace.search(id, {
      query: values.query,
      directory: values.directory,
      limit: number("limit"),
    });
  else if (command === "read")
    result = workspace.readFile(id, values.path, {
      startLine: number("line") ?? 1,
      lineCount: number("lines") ?? 400,
    });
  else if (["edit", "patch"].includes(command)) {
    const schema = command === "edit" ? sourceEditRequestSchema : sourcePatchRequestSchema;
    const request = schema.parse({ ...await payload(), ...(values["dry-run"] === undefined ? {} : { dryRun: values["dry-run"] }) });
    result = workspace[command](id, request.changes, { dryRun: request.dryRun });
  }
  else if (command === "checkpoint")
    result = workspace.checkpoint(id, values.label);
  else if (command === "history") result = workspace.history(id);
  else if (command === "restore")
    result = workspace.restore(
      id,
      values.checkpoint,
      values.expected,
      !values.apply,
    );
  else if (
    ["dev", "typecheck", "test", "test-e2e", "build", "validate"].includes(
      command,
    )
  )
    result = await executeProject(root, id, command);
  else if (command === "review")
    result = await reviewSegment(root, id, {
      start: number("start"),
      end: number("end"),
      width: number("width"),
      fps: number("fps"),
      onLog: (text) => process.stderr.write(text),
    });
  else if (command === "verify")
    result = await verifyDelivery(root, id, { file: values.file });
  else if (command === "compare")
    result = compareReviews(root, id, values.a, values.b);
  else if (command === "review-note")
    result = recordReview(root, id, values.review, await payload());
  else if (command === "narrate") {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      result = await produceNarration(root, id, values.input, {
        signal: controller.signal,
        onProgress: ({ completed, total, cached }) =>
          process.stderr.write(
            `Speech ${completed}/${total}${cached ? " cached" : " synthesized"}\n`,
          ),
      });
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  } else if (command === "workspace") result = createProjectWorkspace(root, id);
  else if (command === "playback")
    result = await checkPlayback(root, id, {
      start: number("start"),
      duration: number("duration"),
    });
  else if (command === "export")
    result = await exportProduction(root, id, {
      start: number("start"),
      end: number("end"),
      width: number("width"),
      fps: number("fps"),
      resume: values.resume,
      segmentSeconds: number("segment-seconds"),
      onLog: (text) => process.stderr.write(text),
    });
  else throw new Error("Unknown production command");
  console.log(
    JSON.stringify({ schemaVersion: 1, ...commandReport(root, id, command, result, { detail: values.detail }) }, null, values.json ? 0 : 2),
  );
  if (result.status === "failed") process.exitCode = 1;
  if (result.close) {
    const close = async () => {
      await result.close();
      process.exit();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  }
} catch (error) {
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      status: "failed",
      error: errorRecovery(error),
    }),
  );
  process.exitCode = 1;
}
