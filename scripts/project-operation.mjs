import { parseArgs } from "node:util";
import { ProjectService } from "./project-service.mjs";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      recover: { type: "string" },
    },
  });
  if (positionals.length !== 1)
    throw new Error(
      "Usage: pnpm film operation <id> [--recover <lock-id>] [--json]",
    );
  const workspace = new ProjectService(process.cwd());
  const result = values.recover
    ? workspace.recoverOperation(positionals[0], values.recover)
    : workspace.operation(positionals[0]);
  console.log(JSON.stringify(result, null, values.json ? 0 : 2));
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      code: error.code,
      error: error.message,
      details: error.details,
    }),
  );
  process.exitCode = 1;
}
