import { z } from "zod";
import { problem } from "../util.mjs";

/**
 * One registry of FRAME tools shared by MCP (HTTP + stdio), the CLI, the
 * built-in AI agents and the studio. A tool is:
 *   { name, title, description, input: zod shape, publicInput?, guide?, readOnly?, destructive?, run(args, ctx) }
 * `publicInput` is a looser shape advertised to clients when the strict one would be a
 * huge JSON schema (document operations); arguments are still validated against `input`.
 * `guide` names the frame_guide topic that documents the arguments.
 * `run` returns { text?, data?, meta?, images?: [{ data: Buffer|base64, mimeType }] };
 * `meta` is a small object every client receives next to a custom text (e.g. sha256).
 */
export class ToolRegistry {
  constructor(services) {
    this.services = services;
    this.tools = new Map();
  }
  add(tool) {
    if (this.tools.has(tool.name)) throw new Error("Duplicate tool " + tool.name);
    const schema = z.strictObject(tool.input || {});
    this.tools.set(tool.name, { ...tool, schema, publicSchema: tool.publicInput ? z.looseObject(tool.publicInput) : schema });
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
      destructive: Boolean(tool.destructive),
      inputSchema: z.toJSONSchema(tool.publicSchema, { unrepresentable: "any" }),
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
    const hint = tool.guide ? `。格式见 frame_guide ${tool.guide}` : "";
    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) throw problem(400, "参数无效：" + describeIssues(parsed.error.issues) + hint, "INVALID_ARGUMENTS");
    const ctx = {
      services: this.services,
      scope,
      /** Resolve the target work: explicit `work` argument, else the session's work. */
      work: async (value = parsed.data.work) => {
        let ref = value || (scope.work ? (scope.repo ? `${scope.repo}/${scope.work}` : scope.work) : "");
        if (!ref) throw problem(400, "需要指定作品：先调用 works_list，再在 work 参数中传入作品 id", "WORK_REQUIRED");
        const [repo, id] = ref.includes("/") ? ref.split("/") : [undefined, ref];
        if (scope.work && (id !== scope.work || (repo && scope.repo && repo !== scope.repo))) throw problem(403, "这个会话只能操作当前作品", "FORBIDDEN");
        return this.services.openWork(id, repo);
      },
    };
    try {
      return await tool.run(parsed.data, ctx);
    } catch (error) {
      // Documents validated deep inside a tool (visual.json, audio.json) throw ZodErrors.
      if (error instanceof z.ZodError) throw problem(400, "内容无效：" + describeIssues(error.issues) + hint, "INVALID_CONTENT");
      throw error;
    }
  }
}

/** Zod issues as one readable line: "operations.0.clip.start: 应为数字；…" (unions report their closest branch). */
export function describeIssues(issues) {
  const lines = [];
  const walk = (list, prefix) => {
    for (const issue of list) {
      const at = [...prefix, ...issue.path];
      if (issue.code === "invalid_union" && issue.errors?.length) {
        // The branch with the fewest problems is almost always the one that was meant.
        const best = issue.errors.reduce((a, b) => (b.length < a.length ? b : a));
        walk(best, at);
      } else lines.push(`${at.join(".") || "(参数)"}: ${issue.message}`);
    }
  };
  walk(issues, []);
  return [...new Set(lines)].slice(0, 12).join("；");
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
