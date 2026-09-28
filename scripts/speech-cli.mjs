import { parseArgs } from "node:util";
import { ProjectService } from "./project-service.mjs";
import {
  initSpeech,
  speechStatus,
  listSpeechVoices,
  speechSamplePlan,
} from "./speech.mjs";
import { produceNarration } from "./narration.mjs";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      voice: { type: "string" },
      speaker: { type: "string" },
      text: { type: "string" },
      locale: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const [id, action] = positionals;
  if (positionals.length !== 2)
    throw new Error(
      "Use pnpm film speech <id> init|status|voices|say; see docs/SPEECH.md",
    );
  const root = process.cwd(),
    workspace = new ProjectService(root, { projects: [id] });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    let result;
    if (action === "init") result = initSpeech(workspace, id, values);
    else if (action === "status") result = speechStatus(workspace, id);
    else if (action === "voices")
      result = await listSpeechVoices(workspace, id, {
        ...values,
        limit: Number(values.limit ?? 100),
        offset: Number(values.offset ?? 0),
        signal: controller.signal,
      });
    else if (action === "say")
      result = await produceNarration(root, id, undefined, {
        plan: speechSamplePlan(values),
        signal: controller.signal,
      });
    else throw new Error("Unknown speech action; use init|status|voices|say");
    console.log(JSON.stringify(result, null, values.json ? 0 : 2));
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
