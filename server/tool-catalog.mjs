import { z } from "zod";

import { isMcpOperation, toolAnnotations } from "./agent-toolkit.mjs";
export { isMcpOperation, toolAnnotations };
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
            `${key} frame_${key} ${op.description}`
              .toLowerCase()
              .includes(needle)),
      );
      return {
        schemaVersion: 1,
        identifiers: {
          id: "work UUID from frame_works_page/create; project is an internal folder slug",
          task: "task UUID; poll frame_task_status; do not resubmit a task after a client timeout",
        },
        workflows: {
          start: [
            "frame_capabilities",
            "frame_repositories_page",
            "frame_works_create",
            "frame_works_context",
          ],
          edit: [
            "frame_works_files_page",
            "frame_works_search",
            "frame_works_read_lines",
            "frame_works_patch / frame_works_patch_batch / frame_works_edit",
            "frame_works_task (kind: validate)",
          ],
          review: [
            "frame_works_live_preview (editable work or active task draft)",
            "frame_works_browser (private live AI console)",
            "FRAME_AI.ready() / FRAME_AI.help()",
            "frame_works_task kind:build only for an explicit immutable snapshot",
          ],
          export: [
            "frame_works_task (kind: render)",
            "frame_task_status until succeeded",
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
