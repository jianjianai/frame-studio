import { parseArgs } from "node:util";
import { rendererIds } from "../src/engine/adapters.mjs";
import { z } from "zod";
import { sourceEditRequestSchema, sourcePatchRequestSchema } from "../src/contracts/source-edit.mjs";
import { projectCreationShape, projectDefaults, authoringModes } from "../src/contracts/authoring.mjs";

import { audioEditRequestSchema, visualEditRequestSchema } from "../src/engine/document-edit.mjs";

const text = (description, more = {}) => ({ type: "string", description, ...more });
const flag = (description) => ({ type: "boolean", description });
const seconds = (description, more = {}) => text(description, { number: true, minimum: 0, ...more });
const integer = (description, min, max) => text(description, { number: true, integer: true, minimum: min, ...(max === undefined ? {} : { maximum: max }) });
const json = flag("Emit standalone JSON; use pnpm --silent.");
const input = text("JSON object file; - reads stdin, at most 1 MiB.");
const dry = flag("Validate and preview without writing.");
const width = integer("Actual even pixel width; preserves project aspect ratio.", 2, 3840);
width.multipleOf = 2;
const fps = integer("Output frame rate.", 12, 60);
const range = { start: seconds("Start in absolute project seconds."), end: seconds("Exclusive end in absolute project seconds.") };
const production = (description, options = {}) => ({ description, usage: "<project>", options: { ...options, json, detail: flag("Include complete input manifests; default prints fingerprints and a report path.") }, validate: true });
const commands = {
  list: { description: "List local projects without executing scene code.", usage: "", options: { json } },
  context: { description: "Read authoritative documents, revisions, instructions and write boundaries.", usage: "<project>", options: { json, detail: flag("Include the complete declared visual/audio documents; default is a compact handoff.") } },
  inspect: { description: "Read static project facts.", usage: "<project>", options: { json } },
  new: { description: "Create a complete neutral project atomically; refuses overwrite.", usage: '<project> "title"', options: { renderer: text("Optional engine example.", { enum: rendererIds, default: projectDefaults.renderer }), duration: seconds("Project duration.", { exclusiveMinimum: 0, maximum: 3600, default: projectDefaults.duration }), fps: { ...fps, default: projectDefaults.fps }, audio: text("Audio scaffold.", { enum: ["silent", "generated"], default: projectDefaults.audio }), width: integer("Composition width; requires height.", 2, 8192), height: integer("Composition height; requires width.", 2, 8192), json }, requestSchema: () => z.toJSONSchema(z.strictObject(projectCreationShape)) },
  composition: { description: "Read or atomically edit authoritative visual.json.", usage: "<project> [get|edit]; engines", options: { input, "dry-run": dry, json }, validate: true, actions: { get: [], edit: ["input", "dry-run"], engines: [] }, defaultAction: "get" },
  audio: { description: "Read, migrate, edit or export the authoritative mix.", usage: "<project> [get|edit|export]; engines", options: { input, "dry-run": dry, format: text("Audio output codec.", { enum: ["wav", "flac", "mp3", "ogg", "m4a"] }), stems: flag("Export channel stems in addition to the mix."), ...range, json }, validate: true, actions: { get: [], edit: ["input", "dry-run"], export: ["format", "stems", "start", "end"], engines: [] }, defaultAction: "get" },
  media: { description: "Probe media or create a separate compatible video copy.", usage: "<project> [probe|transcode]", options: { src: text("Project media URL films/<project>/file."), out: text("New project-relative output path."), json }, validate: true, actions: { probe: ["src"], transcode: ["src", "out"] }, defaultAction: "probe" },
  "audio-media": { description: "Probe/inspect audio or create a separate compatible copy.", usage: "<project> [probe|inspect|transcode]", options: { src: text("Project media URL films/<project>/file."), out: text("New project-relative output path."), json }, validate: true, actions: { probe: ["src"], inspect: ["src"], transcode: ["src", "out"] }, defaultAction: "probe" },
  speech: { description: "Configure speech, list voices or produce an audition.", usage: "<project> init|status|voices|say", options: { provider: text("Configured provider."), voice: text("Voice id."), speaker: text("Speaker role."), text: text("Audition text."), locale: text("Locale filter."), limit: integer("Page size.", 1, 500), offset: integer("Page offset.", 0), json }, validate: true, actions: { init: ["provider", "voice"], status: [], voices: ["provider", "locale", "limit", "offset"], say: ["provider", "voice", "speaker", "text"] } },
  job: { description: "Durable local background jobs; wait timeout does not cancel.", usage: "<project> start|status|wait|cancel", options: { kind: text("Job command.", { enum: ["frame", "storyboard", "render", "review", "export", "validate", "typecheck", "test", "test-e2e", "build", "verify", "narrate", "playback"] }), input, id: text("Job UUID."), timeout: seconds("Worker timeout in seconds.", { minimum: 1, maximum: 86400 }), "wait-ms": integer("Bounded status long poll.", 0, 20000), "deadline-seconds": seconds("Wait deadline; returns running without cancelling on timeout.", { minimum: 1, maximum: 3600, default: 20 }), launch: text("Internal worker launch UUID."), json }, validate: true, actions: { start: ["kind", "input", "timeout"], status: ["id", "wait-ms"], wait: ["id", "deadline-seconds"], cancel: ["id"], worker: ["launch", "timeout"] } },
  search: production("Find literal text and full-file hashes.", { query: text("Literal query."), directory: text("Project-relative directory."), limit: integer("Maximum matches.", 1, 500) }),
  read: production("Read UTF-8 lines and the complete file hash.", { path: text("Project-relative path."), line: integer("First line.", 1), lines: integer("Line count.", 1, 1000) }),
  edit: production("Atomic batch create/replace/delete with full-file revisions.", { input, "dry-run": dry }),
  patch: production("Exact text replacements with revisions and match counts.", { input, "dry-run": dry }),
  checkpoint: production("Create a recoverable project checkpoint.", { label: text("Checkpoint label.") }),
  history: production("List project checkpoints."),
  restore: production("Preview checkpoint restoration; --apply writes.", { checkpoint: text("Checkpoint UUID."), expected: text("Current project fingerprint."), apply: flag("Apply the restoration; default previews.") }),
  review: production("Produce a short clip, timestamped images and a technical report.", { ...range, width, fps }),
  verify: production("Verify encoded delivery.", { file: text("Project-owned encoded video path.") }),
  compare: production("Compare two review reports.", { a: text("First review UUID."), b: text("Second review UUID.") }),
  "review-note": production("Record explicit visual/listening review feedback.", { review: text("Review UUID."), input }),
  narrate: production("Generate final narration from a project-owned plan.", { input }),
  workspace: production("Create an independent editable project workspace."),
  playback: production("Browser cold seek, playback/pause, reverse seek and rate checks.", { start: range.start, duration: seconds("Seconds to play.", { exclusiveMinimum: 0, maximum: 3600 }) }),
  export: production("Freeze inputs, render resumable segments and verify delivery.", { ...range, width, fps, resume: text("Render UUID to resume."), "segment-seconds": seconds("Segment duration.", { minimum: 0.25, maximum: 60 }) }),
  check: { description: "Read-only structural checks.", usage: "<project>", options: { strict: flag("Treat engineering warnings as failures."), json } },
  scope: { description: "Classify current Git changes against the project boundary.", usage: "<project>", options: { base: text("Baseline commit."), limit: integer("Bounded paths per category.", 1, 1000), json } },
  operation: { description: "Inspect operation ownership or recover an identified stale lock.", usage: "<project>", options: { recover: text("Verified stale lock UUID."), json } },
  frame: { description: "Export one timestamped PNG.", usage: "<project>", options: { frame: integer("Frame index; mutually exclusive with time.", 0), time: seconds("Absolute time; mutually exclusive with frame."), width, fps, out: text("Project-owned output path."), force: flag("Replace this output explicitly."), "no-subtitles": flag("Omit subtitles."), json } },
  render: { description: "Render and verify an MP4.", usage: "<project>", options: { ...range, width, fps, out: text("Project-owned output path."), preset: text("FFmpeg encoder preset."), frame: integer("Export a single frame.", 0), time: seconds("Export a single time."), force: flag("Replace this output explicitly."), "no-subtitles": flag("Omit subtitles."), json } },
  storyboard: { description: "Export timestamped PNG grid and JSON manifest.", usage: "<project>", options: { times: text("1..48 comma-separated seconds."), width, out: text("Project-owned PNG output path."), force: flag("Replace this output explicitly."), "no-subtitles": flag("Omit subtitles."), json } },
  poster: { description: "Update this project's cover.", usage: "<project>", options: { json } },
  import: { description: "Import one material with its source/license.", usage: "<project> <file>", options: { license: text("Source and license."), json } },
  asset: { description: "Bounded local/remote resumable asset transfer.", usage: "<project> upload|fetch|status|complete|abort|prune|capabilities [source]", options: { license: text("Source and license."), source: text("Source attribution."), filename: text("Output filename."), sha256: text("Expected content hash."), resume: text("Upload UUID."), id: text("Upload UUID."), "max-bytes": integer("Transfer byte limit.", 1), remote: flag("Use configured remote MCP."), endpoint: text("HTTPS MCP endpoint."), "token-env": text("Token environment variable; never a literal token.", { default: "FRAME_MCP_BEARER_TOKEN" }), json } },
  doctor: { description: "Read-only environment diagnostics.", usage: "", options: { json } },
  reference: { description: "Read one fixed authoring reference; omit name to list.", usage: "[name]", options: { json } },
  mcp: { description: "Serve local stdio MCP; stdout is reserved for protocol messages.", usage: "", options: { project: text("Allowed project; repeatable.", { repeatable: true }), "read-only": flag("Omit write tools."), "job-timeout-seconds": integer("Owned job timeout.", 1, 3600) } },
  "mcp-remote": { description: "Configure or serve authenticated remote MCP.", usage: "init|check|serve|revoke", options: { "env-file": text("Configuration file."), json } },
  platform: { description: "Remote platform CLI; query its live operation schemas.", usage: "help|describe|call|wait|upload|download", options: {}, discovery: "pnpm --silent film platform help --json" },
};
for (const name of ["dev", "typecheck", "test", "test-e2e", "build", "validate"])
  commands[name] = production("Run " + name + " for one project.");

export function commandOptions(name) {
  return Object.fromEntries(Object.entries(commands[name].options).map(([key, option]) => [key, { type: option.type }]));
}
export function commandCatalog() {
  return Object.entries(commands).map(([name, value]) => ({ name, description: value.description, usage: "pnpm --silent film " + name + (value.usage ? " " + value.usage : "") }));
}
export function describeFilmCommand(name, action) {
  const command = commands[name];
  if (!command) throw Object.assign(new Error("Unknown film command: " + name), { code: "UNKNOWN_COMMAND" });
  if (action && (!command.actions || !Object.hasOwn(command.actions, action) || action === "worker"))
    throw Object.assign(new Error("Unknown action for " + name + ": " + action), { code: "INVALID_ARGUMENTS" });
  const allowed = action ? new Set(["json", "detail", ...command.actions[action]]) : null;
  const options = Object.fromEntries(Object.entries(command.options).filter(([key]) => !allowed || allowed.has(key)));
  let requestSchema = command.requestSchema?.();
  if (["edit", "patch"].includes(name)) requestSchema = z.toJSONSchema(name === "edit" ? sourceEditRequestSchema : sourcePatchRequestSchema);
  if (action === "edit" && ["audio", "composition"].includes(name)) {
    requestSchema = z.toJSONSchema(name === "audio" ? audioEditRequestSchema : visualEditRequestSchema, { unrepresentable: "any" });
  }
  return { schemaVersion: 1, name, ...(action ? { action } : {}), description: command.description,
    usage: "pnpm --silent film " + name + " " + command.usage, options,
    ...(command.actions ? { actions: Object.keys(command.actions).filter(x => x !== "worker"), defaultAction: command.defaultAction } : {}),
    ...(requestSchema ? { requestSchema } : {}), ...(command.discovery ? { discovery: command.discovery } : {}),
    defaults: name === "new" ? projectDefaults : undefined, interfaces: authoringModes };
}
/** Called by the routed parser as well as film, so unknown/irrelevant options fail before a write. */
export function validateCommandOptions(name, values, positionals) {
  const command = commands[name];
  if (!command?.validate) return;
  if (positionals.length > 2) throw Object.assign(new Error("Unexpected positional arguments."), { code: "INVALID_ARGUMENTS" });
  if (positionals[0] === "engines" && positionals.length !== 1)
    throw Object.assign(new Error("engines does not accept extra arguments."), { code: "INVALID_ARGUMENTS" });
  const action = positionals[0] === "engines" ? "engines" : (positionals[1] ?? command.defaultAction);
  const allowed = command.actions ? new Set(["json", ...(command.actions[action] ?? [])]) : new Set(Object.keys(command.options));
  if (command.actions && !Object.hasOwn(command.actions, action))
    throw Object.assign(new Error("Unknown " + name + " action."), { code: "INVALID_ARGUMENTS" });
  for (const [key, value] of Object.entries(values)) {
    const rule = command.options[key];
    if (!rule || !allowed.has(key)) throw Object.assign(new Error("--" + key + " is not accepted for this action."), { code: "INVALID_ARGUMENTS" });
    if (rule.enum && !rule.enum.includes(value)) throw Object.assign(new Error("Invalid --" + key + " value."), { code: "INVALID_ARGUMENTS" });
    if (rule.number) {
      const number = Number(value);
      if (!String(value).trim() || !Number.isFinite(number) || (rule.integer && !Number.isInteger(number)) ||
          (rule.minimum !== undefined && number < rule.minimum) || (rule.maximum !== undefined && number > rule.maximum) ||
          (rule.exclusiveMinimum !== undefined && number <= rule.exclusiveMinimum) || (rule.multipleOf && number % rule.multipleOf))
        throw Object.assign(new Error("Invalid numeric --" + key + " value."), { code: "INVALID_ARGUMENTS" });
    }
  }
}
export function parseCommandArgs(name, args = process.argv.slice(2)) {
  const parsed = parseArgs({ args, allowPositionals: true, options: commandOptions(name) });
  validateCommandOptions(name, parsed.values, parsed.positionals);
  return parsed;
}
