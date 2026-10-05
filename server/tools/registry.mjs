import { z } from "zod";
import { problem } from "../util.mjs";

/**
 * One registry of FRAME tools shared by MCP (HTTP + stdio), the CLI, the
 * built-in AI agents and the studio. A tool is:
 *   { name, title, description, input: zod shape, readOnly?, destructive?, run(args, ctx) }
 * `run` returns { text?, data?, images?: [{ data: Buffer|base64, mimeType }] }.
 */
export class ToolRegistry {
  constructor(services) {
    this.services = services;
    this.tools = new Map();
  }
  add(tool) {
    if (this.tools.has(tool.name)) throw new Error("Duplicate tool " + tool.name);
    this.tools.set(tool.name, { ...tool, schema: z.strictObject(tool.input || {}) });
  }
  list() {
    return [...this.tools.values()];
  }
  describe() {
    return this.list().map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      readOnly: Boolean(tool.readOnly),
      inputSchema: z.toJSONSchema(tool.schema, { unrepresentable: "any" }),
    }));
  }
  /**
   * Call a tool. `scope.work`/`scope.repo` bind a default work (agent sessions);
   * `scope.readOnly` hides write tools.
   */
  async call(name, args = {}, scope = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw problem(404, `未知工具：${name}`, "UNKNOWN_TOOL");
    if (scope.readOnly && !tool.readOnly) throw problem(403, `只读模式不能调用 ${name}`, "FORBIDDEN");
    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success)
      throw problem(
        400,
        "参数无效：" + parsed.error.issues.map((issue) => `${issue.path.join(".") || "(参数)"}: ${issue.message}`).join("；"),
        "INVALID_ARGUMENTS",
      );
    const ctx = {
      services: this.services,
      scope,
      /** Resolve the target work: explicit `work` argument, else the session's work. */
      work: async (value = parsed.data.work) => {
        let ref = value || (scope.work ? `${scope.repo}/${scope.work}` : "");
        if (!ref) throw problem(400, "需要指定作品：先调用 works_list，再在 work 参数中传入作品 id", "WORK_REQUIRED");
        const [repo, id] = ref.includes("/") ? ref.split("/") : [undefined, ref];
        if (scope.work && (id !== scope.work || (repo && repo !== scope.repo))) throw problem(403, "这个会话只能操作当前作品", "FORBIDDEN");
        return this.services.openWork(id, repo);
      },
    };
    return tool.run(parsed.data, ctx);
  }
}

/** Optional `work` argument: "<id>" or "<repo>/<id>"; defaults to the agent's current work. */
export const workArg = z
  .string()
  .regex(/^([a-z0-9-]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .optional()
  .describe('作品 id（或 "作品库/id"）。在作品内的 AI 会话中可以省略。');

/**
 * JSON result. Without a custom text the data is also sent as MCP structuredContent;
 * with one, only the text is sent, because some clients show structuredContent instead of text.
 */
export const asJson = (data, text) => (text === undefined ? { data, text: JSON.stringify(data, null, 2), structured: true } : { data, text });
