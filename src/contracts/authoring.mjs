import { z } from "zod";
import { rendererIds } from "../engine/adapters.mjs";
import { compositionSchema } from "../engine/dimensions.mjs";

export const AUTHORING_PROTOCOL_VERSION = 1;
export const projectDefaults = Object.freeze({
  renderer: "composition", duration: 24, fps: 30, audio: "silent",
});
export const projectCreationShape = {
  title: z.string().trim().min(1).max(150),
  renderer: z.enum(rendererIds).default(projectDefaults.renderer),
  duration: z.number().finite().positive().max(3600).default(projectDefaults.duration),
  fps: z.number().int().min(12).max(60).default(projectDefaults.fps),
  audio: z.enum(["silent", "generated"]).default(projectDefaults.audio),
  composition: compositionSchema.optional(),
  width: compositionSchema.shape.width.optional().describe("Requires height; alternative to composition."),
  height: compositionSchema.shape.height.optional().describe("Requires width; alternative to composition."),
};
/** @param {Record<string, unknown>} input */
export function projectCreationOptions(input) {
  const value = z.strictObject(projectCreationShape).parse(
    Object.fromEntries(Object.keys(projectCreationShape).filter(k => input[k] !== undefined).map(k => [k, input[k]])),
  );
  if ((value.width === undefined) !== (value.height === undefined))
    throw Object.assign(new Error("Specify both width and height."), { code: "INVALID_ARGUMENTS" });
  if (value.composition && value.width !== undefined)
    throw Object.assign(new Error("Choose composition or width/height, not both."), { code: "INVALID_ARGUMENTS" });
  const { width, height, ...options } = value;
  return { ...options, ...(width === undefined ? {} : { composition: { width, height } }) };
}
/** @param {Record<string, unknown>} input */
export function creationArguments(input) {
  const value = projectCreationOptions(input);
  return ["--renderer", value.renderer, "--duration", String(value.duration),
    "--fps", String(value.fps), "--audio", value.audio,
    ...(value.composition ? ["--width", String(value.composition.width), "--height", String(value.composition.height)] : [])];
}
export const authoringReferences = Object.freeze({
  rules: { path: "AGENTS.md", description: "Workspace and project write boundaries" },
  standard: { path: "docs/NEW-PROJECT-STANDARD.md", description: "Project layout and creation" },
  authoring: { path: "docs/AUTHORING.md", description: "Scene, audio and export interfaces" },
  toolchain: { path: "docs/AI-TOOLCHAIN.md", description: "Shared AI tool contracts, discovery and recovery" },
  workflow: { path: "docs/AI-WORKFLOW.md", description: "AI handoff and editing workflow" },
  "creator-workflow": { path: "docs/CREATOR-WORKFLOW.md", description: "Codex and Claude task workflow" },
  production: { path: "docs/AI-PRODUCTION.md", description: "Review, jobs and delivery" },
  remotion: { path: "docs/REMOTION.md", description: "React compositions, native rendering, media, FrameScene and audio integration" },
  composition: { path: "docs/COMPOSITION.md", description: "Authoritative visual.json and clip operations" },
  "live-preview": { path: "docs/V8-LIVE-PREVIEW.md", description: "V8 incremental live preview and weak-network media" },
  "audio-v7": { path: "docs/AUDIO-V7.md", description: "Authoritative audio.json, sources, tracks, clips and processors" },
  audio: { path: "docs/AUDIO.md", description: "Legacy and generated audio contracts" },
  "scene-types": { path: "src/engine/types.ts", description: "TypeScript scene and audio interfaces" },
  mcp: { path: "docs/MCP.md", description: "Local MCP tools and resources" },
  "mcp-remote": { path: "docs/MCP-REMOTE.md", description: "Authenticated remote MCP" },
  assets: { path: "docs/ASSET-TRANSFER.md", description: "Bounded asset transfer" },
  speech: { path: "docs/SPEECH.md", description: "Speech configuration and synthesis" },
});
export const authoringModes = Object.freeze({
  local: { identity: "project slug", entry: "pnpm --silent film context <project> --json", discovery: "pnpm --silent film describe <command> --json", edits: "film edit/patch --input request.json" },
  mcp: { identity: "project slug", entry: "frame_project_context", discovery: "frame_tool_describe", edits: "frame_edit_files / frame_patch_files" },
  remote: { identity: "work UUID (id)", entry: "frame_works_context", discovery: "frame_tool_describe", edits: "frame_works_edit / frame_works_patch_batch", tasks: "frame_works_task -> frame_task_status" },
  agent: { identity: "project bound to the active task", entry: "node scripts/work-tool.mjs context", discovery: "node scripts/work-tool.mjs help --json", edits: "local film edit/patch in this task checkout" },
});
