import { readJsonInput } from "./cli-input.mjs";
import { visualEditRequestSchema } from "../src/engine/document-edit.mjs";
import { parseCommandArgs } from "./film-command-catalog.mjs";
import { errorRecovery } from "./tool-errors.mjs";
import { ProjectService } from "./project-service.mjs";
import { visualContext, visualEdit } from "./visual-service.mjs";
import { adapters } from "../src/engine/adapters.mjs";
try {
  const { values, positionals } = parseCommandArgs("composition");
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
        ? await readJsonInput(values.input)
        : null;
    const result =
      action === "get"
        ? visualContext(service, id)
        : visualEdit(service, id, visualEditRequestSchema.parse({ ...request, ...(values["dry-run"] === undefined ? {} : { dryRun: values["dry-run"] }) }));
    console.log(JSON.stringify(result, null, values.json ? 0 : 2));
  }
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: 1, status: "failed", error: errorRecovery(error) }));
  process.exitCode = 1;
}
