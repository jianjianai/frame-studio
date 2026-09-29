import { z } from "zod";

export const isMcpOperation = (name) =>
  /^(help$|works_|upload_|repositories_(page|get|check|sync|refresh)$|connections_list$|assets_(list|update|trash|purge)$|task_(get|cancel|retry_publish)$|artifact_read$|engines_(list|save|delete|local)$|speech_test$|models_list$)/.test(
    name,
  );
const readOnly = new Set([
  "help",
  "works_list",
  "works_page",
  "works_context",
  "works_files",
  "works_files_page",
  "works_read",
  "works_read_lines",
  "works_search",
  "works_tasks",
  "works_chats",
  "works_chat_turns",
  "works_versions",
  "works_version_compare",
  "works_background",
  "works_exports",
  "works_queue_status",
  "works_results",
  "repositories_page",
  "repositories_get",
  "connections_list",
  "assets_list",
  "task_get",
  "artifact_read",
  "engines_list",
  "models_list",
  "upload_status",
]);
export function toolAnnotations(name) {
  const read = readOnly.has(name);
  return {
    readOnlyHint: read,
    destructiveHint: !read,
    idempotentHint: read,
    openWorldHint:
      /(?:sync|refresh|speech|engines_(save|local)|chat_send)/.test(name),
  };
}
const schemas = new WeakMap();
export function operationDescription(name, op, { schema = false } = {}) {
  const value = {
    description: op.description,
    mcp: isMcpOperation(name),
    annotations: toolAnnotations(name),
  };
  if (schema) {
    let input = schemas.get(op.schema);
    if (!input) {
      input = z.toJSONSchema(op.schema, {
        io: "input",
        unrepresentable: "any",
      });
      schemas.set(op.schema, input);
    }
    value.inputSchema = input;
  }
  return value;
}
export function registerToolHelp(add, registry) {
  add(
    "help",
    "Discover Frame workflows and tools. Search descriptions or request one operation's exact input schema. Work APIs use work UUIDs, not project folder names.",
    {
      query: z.string().max(200).default(""),
      name: z
        .string()
        .regex(/^(frame_)?[a-z][a-z0-9_]*$/)
        .optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30),
    },
    ({ query, name, offset, limit }) => {
      const exact = name?.replace(/^frame_/, ""),
        needle = query.toLowerCase();
      const tools = Object.entries(registry).filter(
        ([key, op]) =>
          isMcpOperation(key) &&
          (!exact || key === exact) &&
          (!needle ||
            `${key} ${op.description}`.toLowerCase().includes(needle)),
      );
      return {
        schemaVersion: 1,
        identifiers: {
          id: "work UUID from frame_works_page/create; project is an internal folder slug",
          task: "task UUID; poll frame_task_get; do not resubmit a task after a client timeout",
        },
        workflows: {
          start: [
            "frame_repositories_page",
            "frame_works_create",
            "frame_works_context (sections: ['metadata','readme'])",
          ],
          edit: [
            "frame_works_files_page",
            "frame_works_search",
            "frame_works_read_lines",
            "frame_works_patch / frame_works_edit",
            "frame_works_task (kind: validate)",
          ],
          review: [
            "frame_works_browser",
            "frame_task_get until terminal",
            "frame_works_browser again",
            "FRAME_AI.ready() / FRAME_AI.help()",
          ],
          export: [
            "frame_works_task (kind: render)",
            "frame_task_get until succeeded",
            "pnpm platform download <task> <artifact-path> --out <file>",
          ],
        },
        tools: tools.slice(offset, offset + limit).map(([key, op]) => ({
          name: "frame_" + key,
          operation: key,
          ...operationDescription(key, op, { schema: Boolean(exact) }),
        })),
        total: tools.length,
        nextOffset: offset + limit < tools.length ? offset + limit : null,
        next:
          exact && !tools.length
            ? "No matching tool. Call frame_help without name or search by query."
            : "Use name to retrieve an exact schema; follow nextOffset for more tools.",
      };
    },
  );
}
