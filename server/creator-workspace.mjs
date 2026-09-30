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
Read the authority field before editing: declared audio.json and visual.json own the mix and composition; legacy project.ts audioTracks can be stale. Use film audio/composition get and edit with the returned document hashes. Query pnpm --silent film describe <command> --json or node scripts/work-tool.mjs reference to discover exact parameters and current references.
Use film read/search/patch/edit and checkpoint/history/restore for bounded edits and recovery. All project-specific scripts, request JSON, records and exports belong inside projects/${project}/. Do not create scratch files in the workspace root or run whole-repository checks for a work task.
Use node scripts/work-tool.mjs help --json for discoverable asset and speech inputs. assets supports search/limit/offset in the current repository. engines lists provider/model capabilities and built-in voices; speech_providers lists adapter presets, engines_discover reads configured voice catalogs. Select a Chinese-capable voice, audition a short representative paragraph, and use only supported options (instructions/emotion/pronunciation/pauses). Unsupported fields fail by default; explicit fallback=omit returns warnings. speech_status/speech_cancel use a fresh requestId. engine_add adds a custom speech adapter when needed. engine_test creates temporary audition audio only; speech generates final narration into this work. use copies a selected asset into this work. Wire returned material URLs into scenes/audioTracks as needed; imported audio is not automatically audible. Pass credentials through @file or stdin and never print them. Never blindly repeat a timed-out speech/write request.
Iterate with node scripts/work-tool.mjs check for engineering feedback. Before finishing, run node scripts/work-tool.mjs check '{"runtime":true}' for a short playback check and timestamped storyboard. Resolve reported failures, open the returned PNG with your image-reading tool, and render/review a relevant short clip for sound and timing. Use pnpm --silent film test-e2e ${project} --json for this work's browser tests. A report or generated file is not proof that it was seen or heard; keep visual/listening acceptance explicit.
Use film export/verify when the user requests a final encoded deliverable; editing previews update automatically from saved source in this isolated task and follow the published work after successful validation. Use node scripts/work-tool.mjs preview to open this task-scoped live player when needed. Do not run film build after every edit; use build only when an immutable preview is explicitly needed. Report changed files, actual check results, artifact paths and remaining limitations. Do not claim full-film or listening acceptance from a sampled technical check.`;
}
