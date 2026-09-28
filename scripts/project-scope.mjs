import { parseArgs } from "node:util";
import { inspectProjectScope } from "./project-scope-report.mjs";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      json: { type: "boolean" },
      limit: { type: "string" },
    },
  });
  if (positionals.length !== 1)
    throw new Error(
      "Usage: pnpm film scope <id> [--base <commit>] [--json] [--limit 40]",
    );
  const result = inspectProjectScope(process.cwd(), positionals[0], {
    base: values.base,
    limit: values.limit ? Number(values.limit) : 40,
  });
  if (values.json) console.log(JSON.stringify(result));
  else if (result.passed) console.log(result.nextAction);
  else {
    console.error(
      `Changes outside projects/${result.project}/: ${result.outsideCount}`,
    );
    for (const group of result.externalWorkspaceChanges.projects)
      console.error(
        `Other project ${group.project}: ${group.count}\n${group.paths.join("\n")}${group.truncated ? "\n… additional paths omitted" : ""}`,
      );
    const shared = result.externalWorkspaceChanges.shared;
    if (shared.count)
      console.error(
        `Shared workspace: ${shared.count}\n${shared.paths.join("\n")}`,
      );
    console.error(result.nextAction);
  }
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(JSON.stringify({ status: "failed", error: error.message }));
  process.exitCode = 2;
}
