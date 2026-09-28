import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { executeProject } from "./project-execution.mjs";
import { reviewSegment, verifyDelivery } from "./production-media.mjs";
import { projectPath } from "./project-paths.mjs";
import { exportProduction } from "./production-export.mjs";
import { produceNarration } from "./narration.mjs";
import { speechSamplePlan } from "./speech.mjs";
import { checkPlayback } from "./playback-check.mjs";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    kind: { type: "string" },
    options: { type: "string" },
    out: { type: "string" },
  },
});
const id = positionals[0],
  root = process.cwd();
const options = JSON.parse(values.options ?? "{}");
const output = projectPath(
  root,
  id,
  path.relative(projectPath(root, id), values.out),
);
try {
  let result;
  if (
    ["validate", "build", "typecheck", "test", "test-e2e"].includes(values.kind)
  )
    result = await executeProject(root, id, values.kind);
  else if (values.kind === "playback")
    result = await checkPlayback(root, id, options);
  else if (values.kind === "export")
    result = await exportProduction(root, id, {
      ...options,
      onLog: (value) => process.stderr.write(value),
    });
  else if (values.kind === "narrate")
    result = await produceNarration(root, id, options.input, {
      ...(options.text !== undefined
        ? { plan: speechSamplePlan(options) }
        : {}),
      onProgress: ({ completed, total, cached }) =>
        process.stderr.write(
          `Speech ${completed}/${total}${cached ? " cached" : " synthesized"}\n`,
        ),
    });
  else if (values.kind === "review")
    result = await reviewSegment(root, id, {
      ...options,
      onLog: (value) => process.stderr.write(value),
    });
  else if (values.kind === "verify")
    result = await verifyDelivery(root, id, options);
  else throw new Error("Unknown production job");
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  if (result.status === "failed") process.exitCode = 1;
} catch (error) {
  fs.writeFileSync(
    output,
    JSON.stringify({ status: "failed", error: error.message }),
  );
  console.error(error.stack);
  process.exitCode = 1;
}
