import { randomUUID } from "node:crypto";
import { waitForAgentAnswer } from "./agent-question-client.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  workToolHelp,
  readToolInput,
  callWorkTool,
  redactToolText,
  toolError,
} from "./work-tool-client.mjs";

export async function runWorkTool(
  argv,
  { root = process.cwd(), env = process.env } = {},
) {
  const [name = "help", input = "{}", ...extra] = argv;
  if (["help", "--help", "-h"].includes(name)) {
    if (extra.length || !["{}", "--json"].includes(input))
      throw toolError(
        "INVALID_ARGUMENTS",
        "Use help or help --json.",
        "node scripts/work-tool.mjs help --json",
      );
    return workToolHelp;
  }
  if (extra.length)
    throw toolError(
      "INVALID_ARGUMENTS",
      "Expected one JSON argument, @file or stdin (-).",
      "Use @file to avoid shell quoting problems.",
    );
  const args = await readToolInput(input);
  if (name === "reference") {
    if (Object.keys(args).some(key => key !== "name") || (args.name !== undefined && typeof args.name !== "string"))
      throw toolError("INVALID_ARGUMENTS", "Expected an optional reference name.", "node scripts/work-tool.mjs reference");
    const { referenceCatalog, readAuthoringReference } = await import("./authoring-reference.mjs");
    return args.name ? readAuthoringReference(root, args.name) : { schemaVersion: 1, references: referenceCatalog() };
  }
  if (name === "ask") {
    const answer = await waitForAgentAnswer({ ...args, requestKey: args.requestKey || randomUUID() }, { env });
    return { questions: answer.payload.questions, answers: answer.answers };
  }
  if (["context", "check"].includes(name)) {
    const allowed =
      name === "context" ? ["project"] : ["project", "runtime", "start", "end"];
    if (
      Object.keys(args).some((key) => !allowed.includes(key)) ||
      (args.runtime !== undefined && typeof args.runtime !== "boolean")
    )
      throw toolError(
        "INVALID_ARGUMENTS",
        "Unknown or invalid local tool option.",
        "node scripts/work-tool.mjs help --json",
      );
    if (
      (args.start !== undefined || args.end !== undefined) &&
      args.runtime !== true
    )
      throw toolError(
        "INVALID_ARGUMENTS",
        "start/end require runtime:true.",
        "Enable the runtime check or omit the range.",
      );
    const { readCreatorContext, checkCreatorWork } =
      await import("./creator-context.mjs");
    return name === "context"
      ? readCreatorContext(root, args, env)
      : checkCreatorWork(root, args, env);
  }
  return callWorkTool(name, args, { env });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await runWorkTool(process.argv.slice(2));
    console.log(redactToolText(JSON.stringify(result)));
    if (result?.status === "failed") process.exitCode = 1;
  } catch (error) {
    console.log(
      redactToolText(
        JSON.stringify({
          schemaVersion: 1,
          status: "failed",
          error: {
            code: error.code || "WORK_TOOL_FAILED",
            message: error.message,
            nextAction:
              error.nextAction ||
              "Check the request path and run node scripts/work-tool.mjs help --json.",
            httpStatus: error.httpStatus,
            retryAfter: error.retryAfter,
            outcome: error.outcome,
          },
        }),
      ),
    );
    process.exitCode = 1;
  }
}
