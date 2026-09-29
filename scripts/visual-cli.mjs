import fs from "node:fs";
import { parseArgs } from "node:util";
import { ProjectService } from "./project-service.mjs";
import { visualContext, visualEdit } from "./visual-service.mjs";
import { adapters } from "../src/engine/adapters.mjs";
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      input: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const [id, action = "get"] = positionals;
  if (id === "engines") {
    console.log(JSON.stringify({ adapters }, null, 2));
  } else {
    if (!id || positionals.length > 2 || !["get", "edit"].includes(action))
      throw new Error(
        "film composition <id> [get|edit --input file.json] [--json]",
      );
    const service = new ProjectService(process.cwd());
    const request =
      action === "edit"
        ? JSON.parse(
            fs.readFileSync(values.input === "-" ? 0 : values.input, "utf8"),
          )
        : null;
    const result =
      action === "get"
        ? visualContext(service, id)
        : visualEdit(service, id, { ...request, dryRun: !!values["dry-run"] });
    console.log(JSON.stringify(result, null, values.json ? 0 : 2));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      code: error.code,
      error: error.message,
    }),
  );
  process.exitCode = 1;
}
