/** Exact task-owned runtime files, not a broad exemption for arbitrary root writes. */
export const creatorTaskIgnores = [
  "node_modules",
  ".cache/",
  "projects/*/.cache/",
  "projects/*/.history/",
  "projects/*/exports/",
  "/task.json",
  "/result.json",
  "/events.ndjson",
  "/progress.json",
  "/progress.json.tmp",
];

export function creatorPrompt(project) {
  return `You are creating one work in FRAME: ${project}. Only edit projects/${project}/. The surrounding engine, tools and installed dependencies are the platform runtime, not another project to create or install.
Read AGENTS.md, docs/AUTHORING.md, docs/CREATOR-WORKFLOW.md and the work README. Start with node scripts/work-tool.mjs context; it returns this task's review range, version reference, source entrypoints, engineering diagnostics and concrete commands without dumping task credentials.
The default empty composition is an infrastructure container, not a 2D/3D or artistic choice. Use node scripts/work-tool.mjs capabilities (optional category/query/id JSON filters) to discover every visual framework, animation helper, media adapter and audio generator. Select freely according to the user's content; read only the selected capability's reference for exact integration. Remotion is a React/DOM root and may embed Canvas scenes through FrameScene; it is not a Canvas composition layer. The engines command discovers speech services, not visual frameworks.
Read the authority field before editing: declared audio.json owns the mix and visual.json owns its Canvas composition; legacy project.ts audioTracks can be stale. Remotion's visual authority is the React root; a retained loadVisual declaration only exposes an optional Canvas subcomposition, which becomes visible through an explicit FrameScene connection. Use film audio/composition get and edit with the returned document hashes. Query pnpm --silent film describe <command> --json or node scripts/work-tool.mjs reference to discover exact parameters and current references.
Use film read/search/patch/edit and checkpoint/history/restore for bounded edits and recovery. All project-specific scripts, request JSON, records and exports belong inside projects/${project}/. Do not create scratch files in the workspace root or run whole-repository checks for a work task.
Use node scripts/work-tool.mjs help --json for discoverable asset and speech inputs. assets supports search/limit/offset in the current repository. engines lists provider/model capabilities and built-in voices; speech_providers lists adapter presets, engines_discover reads configured voice catalogs. Select a Chinese-capable voice, audition a short representative paragraph, and use only supported options (instructions/emotion/pronunciation/pauses). Unsupported fields fail by default; explicit fallback=omit returns warnings. speech_status/speech_cancel use a fresh requestId. engine_add adds a custom speech adapter when needed. engine_test creates temporary audition audio only; speech generates final narration into this work. use copies a selected asset into this work. Wire returned material URLs into the authoritative visual/audio documents or scene/Remotion code; only legacy audio without audio.json uses project.ts audioTracks. Imported audio is not automatically audible. Pass credentials through @file or stdin and never print them. Never blindly repeat a timed-out speech/write request.
Iterate with node scripts/work-tool.mjs check for engineering feedback. Before finishing, run node scripts/work-tool.mjs check '{"runtime":true}' for a short playback check and timestamped storyboard. Resolve reported failures, open the returned PNG with your image-reading tool, and render/review a relevant short clip for sound and timing. Use pnpm --silent film test-e2e ${project} --json for this work's browser tests. A report or generated file is not proof that it was seen or heard; keep visual/listening acceptance explicit.
Use film export/verify when the user requests a final encoded deliverable; a successful build only prepares a preview. A preview is built automatically after successful task validation. Report changed files, actual check results, artifact paths and remaining limitations. Do not claim full-film or listening acceptance from a sampled technical check.`;
}
