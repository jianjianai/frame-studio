import { z } from "zod";
import { fileURLToPath } from "node:url";
import { authoringReferences, authoringModes, projectDefaults } from "../src/contracts/authoring.mjs";
import { referenceCatalog, readAuthoringReference } from "../scripts/authoring-reference.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import { PLATFORM_VERSION } from "../src/contracts/version.mjs";
import { isActiveTask } from "../src/contracts/platform.mjs";
import { problem } from "./security.mjs";

// This allowlist is shared by discovery and MCP registration, never by authorization.
export const isMcpOperation = (name) =>
  /^(help$|works_|upload_|repositories_(page|get|check|sync|refresh)$|connections_list$|assets_(list|update|trash|purge)$|task_(get|status|cancel|retry_publish)$|artifact_read$|engines_(list|save|delete|local)$|speech_test$|models_list$|workspace_context$|tool_describe$|authoring_reference$)/.test(
    name,
  );
const readOnly = new Set([
  "help",
  "works_read_lines",
  "workspace_context",
  "tool_describe",
  "authoring_reference",
  "upload_status",
  "works_list",
  "works_context",
  "works_audio",
  "works_composition",
  "works_media_probe",
  "works_audio_inspect",
  "works_audio_media_probe",
  "works_files",
  "works_files_page",
  "works_read",
  "works_search",
  "works_tasks",
  "works_tasks_page",
  "works_chats",
  "works_chat_turns",
  "works_versions",
  "works_exports",
  "task_get",
  "task_status",
  "artifact_read",
  "connections_list",
  "engines_list",
  "models_list",
  "assets_list",
  "repositories_page",
  "repositories_get",
]);
export function toolAnnotations(name) {
  const read = readOnly.has(name);
  return {
    readOnlyHint: read,
    destructiveHint: !read,
    idempotentHint: read,
    openWorldHint:
      /sync|refresh|check|speech|engines|chat_send|use_asset|task$/.test(name),
  };
}
export function describeTool(name, op) {
  return {
    name,
    mcpName: isMcpOperation(name) ? "frame_" + name : null,
    description: op.description,
    inputSchema: z.toJSONSchema(op.schema, {
      io: "input",
      unrepresentable: "any",
    }),
    annotations: toolAnnotations(name),
  };
}
export const structuredValue = (value) =>
  Array.isArray(value)
    ? { items: value }
    : value !== null && typeof value === "object"
      ? value
      : { value };
export const textToolResult = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: structuredValue(value),
});

export const TASK_SUMMARY_COLUMNS =
  "id,repo,project,kind,state,error,created,started,finished,expires,cleaned,source_commit,progress,result - 'input' AS result";
const choose = (object, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => object?.[key] !== undefined)
      .map((key) => [key, object[key]]),
  );
const shortText = (value, max = 2000) =>
  typeof value === "string" ? value.slice(0, max) : (value ?? null);
export function artifactDescriptor(task, artifact) {
  const root = `projects/${task.project}/exports/`;
  if (
    typeof artifact?.path !== "string" ||
    !artifact.path.startsWith(root) ||
    artifact.path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || /[\\\x00-\x1f]/.test(p))
  )
    return null;
  return {
    ...choose(artifact, ["name", "path", "bytes", "sha256"]),
    downloadPath:
      `/api/tasks/${task.id}/file/` +
      artifact.path.split("/").map(encodeURIComponent).join("/"),
    ...(/\.(png|json|srt)$/i.test(artifact.path)
      ? {
          inspect: {
            tool: "frame_artifact_read",
            arguments: { id: task.id, path: artifact.path },
          },
        }
      : {}),
  };
}
export function compactTask(task, { artifactLimit = 12 } = {}) {
  const files = Array.isArray(task.result?.artifacts)
    ? task.result.artifacts
    : [];
  const artifacts = files
    .slice(0, artifactLimit)
    .map((a) => artifactDescriptor(task, a))
    .filter(Boolean);
  return {
    ...choose(task, [
      "id",
      "repo",
      "project",
      "kind",
      "state",
      "created",
      "started",
      "finished",
      "expires",
      "cleaned",
      "source_commit",
    ]),
    error: shortText(task.error),
    progress: task.progress
      ? choose(task.progress, ["stage", "completed", "total", "percent"])
      : null,
    result: task.result
      ? {
          ...choose(task.result, [
            "status",
            "command",
            "previewVersion",
            "runtimeFingerprint",
            "commit",
            "exitCode",
          ]),
          artifacts,
          artifactCount: files.length,
          artifactsTruncated: files.length > artifacts.length,
        }
      : null,
  };
}
function compactEvent(event, task) {
  const result = { ...choose(event, ["id", "kind", "created"]) };
  if (event.kind === "result")
    result.data = compactTask({ ...task, result: event.data }).result;
  else if (typeof event.data?.text === "string")
    result.data = {
      text: event.data.text.slice(-8000),
      truncated: event.data.text.length > 8000,
    };
  else {
    const value = event.data;
    result.data =
      JSON.stringify(value ?? null).length <= 8000
        ? value
        : {
            truncated: true,
            message: "Read the full event with frame_task_get.",
          };
  }
  return result;
}
const nextTaskActions = (task, after) =>
  task.cleaned
    ? []
    : task.state === "publish_failed"
      ? [
          {
            tool: "frame_task_retry_publish",
            arguments: { id: task.id },
            reason:
              "Retry publication only; do not rerun the completed AI task.",
          },
        ]
      : isActiveTask(task)
        ? [
            {
              tool: "frame_task_status",
              arguments: { id: task.id, after, waitMs: 10000 },
              reason: "Wait for events or a terminal state.",
            },
          ]
        : (task.result?.artifacts ?? [])
            .slice(0, 3)
            .map((a) => artifactDescriptor(task, a))
            .filter(Boolean)
            .map((a) => a.inspect ?? { downloadPath: a.downloadPath });

export function agentToolkitOperations({ add, registry, db, works, tasks }) {
  const uuid = z.string().uuid();
  add("authoring_reference", "Read a fixed authoring reference or list the current catalog.", { name: z.enum(Object.keys(authoringReferences)).optional() }, ({ name }) =>
    name ? readAuthoringReference(fileURLToPath(new URL("..", import.meta.url)), name) : { schemaVersion: 1, references: referenceCatalog() });
  add(
    "workspace_context",
    "Start here: compact workspace overview, work UUIDs, tool recipes and safe editing boundaries. No project mutation.",
    {},
    async () => {
      const invoke = (name, args) =>
        registry[name].fn(registry[name].schema.parse(args));
      const repositories = await invoke("repositories_page", {
        limit: 10,
        offset: 0,
      });
      const latestWorks = await works.list({
        deleted: false,
        search: "",
        category: "",
        status: "",
        recent: false,
        limit: 10,
        offset: 0,
      });
      return {
        schemaVersion: 1,
        platformVersion: PLATFORM_VERSION,
        defaults: projectDefaults, interfaces: authoringModes, references: referenceCatalog(),
        repositories,
        works: latestWorks.map((w) =>
          choose(w, [
            "id",
            "repo",
            "project",
            "title",
            "duration",
            "renderer",
            "status",
          ]),
        ),
        boundaries:
          "Remote tools use the work UUID (id), not the project slug. Paths such as scene.ts are relative to that work. Do not write outside it. Local pnpm film commands use the project slug in a local checkout.",
        workflow: [
          {
            tool: "frame_works_context",
            purpose:
              "Read compact work context, source paths and recent task summaries.",
          },
          {
            tool: "frame_works_files_page",
            purpose: "List files; continue with nextOffset.",
          },
          {
            tool: "frame_works_search",
            purpose: "Find literal text; continue with nextCursor.",
          },
          {
            tool: "frame_works_read",
            purpose:
              "Read line ranges and the whole-file SHA-256; nextLine means partial content.",
          },
          {
            tool: "frame_works_patch_batch",
            purpose:
              "Patch exact text using that SHA-256; dryRun previews without changing files.",
          },
          {
            tool: "frame_works_task",
            purpose:
              "Create validate/frame/storyboard/render/build tasks. Reuse a requestKey UUID only for an identical retried request.",
          },
          {
            tool: "frame_task_status",
            purpose:
              "Bounded polling with waitMs, nextAfter and hasMore. A terminal state can still have unread events.",
          },
          {
            tool: "frame_artifact_read",
            purpose:
              "Inspect PNG/JSON/SRT. Download other outputs with the authenticated downloadPath or CLI download.",
          },
        ],
        discovery:
          "frame_tool_describe gives exact parameter schemas. CLI: pnpm --silent platform describe works_patch. For all repositories/works, use their paginated listing tools.",
        lifecycle:
          "Files/patches do not publish a preview. Validate, inspect a frame/storyboard, then build for browser preview. Tasks persist after disconnection; timeout does not cancel a task. Preserve publish_failed results and retry publication instead of regenerating.",
      };
    },
  );
  add(
    "tool_describe",
    "Get exact parameters and side-effect annotations for one public MCP operation; accepts its name with or without frame_.",
    { name: z.string().min(1).max(100) },
    (a) => {
      const name = a.name.replace(/^frame_/, "");
      if (!isMcpOperation(name) || !Object.hasOwn(registry, name))
        throw problem(
          404,
          "Unknown public tool; start with frame_workspace_context.",
        );
      return describeTool(name, registry[name]);
    },
  );
  add(
    "works_tasks_page",
    "Page compact work task summaries without build manifests. Use task_get only when full diagnostics are needed.",
    {
      id: uuid,
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().nonnegative().default(0),
    },
    async (a) => {
      const work = await works.get(a.id);
      const rows = await db.all(
        `SELECT ${TASK_SUMMARY_COLUMNS} FROM tasks WHERE repo=$1 AND project=$2 ORDER BY created DESC,id DESC LIMIT $3 OFFSET $4`,
        [work.repo, work.project, a.limit + 1, a.offset],
      );
      return {
        tasks: rows.slice(0, a.limit).map((task) => compactTask(task)),
        nextOffset: rows.length > a.limit ? a.offset + a.limit : null,
      };
    },
  );
  const cursor = z.union([
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z
      .string()
      .regex(/^\d{1,19}$/)
      .refine(
        (s) => BigInt(s) <= 9223372036854775807n,
        "Cursor exceeds bigint range",
      ),
  ]);
  add(
    "task_status",
    "Read compact task state, artifact download/inspection actions and incremental events. waitMs is bounded; nextAfter is a lossless string cursor. Full diagnostics remain in task_get.",
    {
      id: uuid,
      after: cursor.default(0),
      limit: z.number().int().min(1).max(100).default(30),
      waitMs: z.number().int().min(0).max(10000).default(0),
    },
    async (a) => {
      const deadline = Date.now() + a.waitMs;
      let task, rows;
      for (;;) {
        task = await tasks.get(a.id);
        rows = await db.all(
          "SELECT id,kind,data,created FROM events WHERE task=$1 AND id>$2 ORDER BY id LIMIT $3",
          [a.id, String(a.after), a.limit + 1],
        );
        if (!isActiveTask(task) || rows.length || Date.now() >= deadline) break;
        await sleep(Math.min(500, deadline - Date.now()));
      }
      const events = rows
        .slice(0, a.limit)
        .map((event) => compactEvent(event, task));
      return {
        task: compactTask(task),
        events,
        nextAfter: events.length ? String(events.at(-1).id) : String(a.after),
        hasMore: rows.length > a.limit,
        done: !isActiveTask(task),
        pollAfterMs: isActiveTask(task) ? 1000 : 0,
        nextActions: nextTaskActions(
          task,
          events.length ? String(events.at(-1).id) : String(a.after),
        ),
      };
    },
  );
}
