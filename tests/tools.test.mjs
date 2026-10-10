import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../server/tools/registry.mjs";
import { createMcpServer, toMcpResult } from "../server/mcp.mjs";

const registry = new ToolRegistry({ openWork: async (id, repo) => ({ id, repo: repo ?? "local" }) });
registry.add({
  name: "read",
  title: "",
  description: "",
  readOnly: true,
  input: { work: z.string().optional(), n: z.number().int().min(1) },
  run: async ({ n }, ctx) => ({ data: { n, work: await ctx.work() } }),
});
registry.add({ name: "write", title: "", description: "", input: {}, run: async () => ({ data: { ok: true } }) });
const doc = z.strictObject({ id: z.string(), size: z.number().int() });
registry.add({
  name: "edit",
  title: "",
  description: "",
  guide: "layers",
  input: { ops: z.array(z.discriminatedUnion("op", [z.strictObject({ op: z.literal("put"), value: doc }), z.strictObject({ op: z.literal("drop"), id: z.string() })])) },
  publicInput: { ops: z.array(z.looseObject({ op: z.enum(["put", "drop"]) })) },
  run: async () => {
    doc.parse({ id: 1 });
  },
});

describe("tool registry", () => {
  it("validates arguments with readable errors", async () => {
    await expect(registry.call("read", { n: 0, work: "a1" })).rejects.toThrow(/参数无效：n/);
    await expect(registry.call("read", { n: 1, extra: true, work: "a1" })).rejects.toThrow(/参数无效/);
  });
  it("binds agent sessions to their own work", async () => {
    const result = await registry.call("read", { n: 1 }, { work: "w1", repo: "local" });
    expect(result.data.work).toEqual({ id: "w1", repo: "local" });
    await expect(registry.call("read", { n: 1, work: "other" }, { work: "w1", repo: "local" })).rejects.toThrow(/当前作品/);
    await expect(registry.call("read", { n: 1 })).rejects.toThrow(/需要指定作品/);
  });
  it("hides write tools in read-only scope", async () => {
    await expect(registry.call("write", {}, { readOnly: true })).rejects.toThrow(/只读/);
    expect((await registry.call("write", {})).data.ok).toBe(true);
  });
  it("describes tools as JSON schema", () => {
    const read = registry.describe().find((tool) => tool.name === "read");
    expect(read.inputSchema.properties.n.type).toBe("integer");
  });
  it("advertises the compact schema but validates the strict one", async () => {
    const edit = registry.describe().find((tool) => tool.name === "edit");
    expect(JSON.stringify(edit.inputSchema)).not.toContain("size");
    await expect(registry.call("edit", { ops: [{ op: "put", value: { id: "a" } }] })).rejects.toThrow(/ops\.0\.value\.size.*frame_guide layers/);
  });
  it("turns validation errors thrown inside a tool into readable 400s", async () => {
    const error = await registry.call("edit", { ops: [{ op: "drop", id: "a" }] }).catch((error) => error);
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/^内容无效：id: .*；size: /);
  });
  it("marks destructive tools for other clients, not for the studio's own agents (FRAME asks them itself)", () => {
    const tools = new ToolRegistry({});
    tools.add({ name: "cut", title: "", description: "", destructive: true, input: { work: z.string().optional() }, run: async () => ({ data: 1 }) });
    expect(createMcpServer(tools, {})._registeredTools.cut.annotations.destructiveHint).toBe(true);
    // Codex would otherwise ask about every layers_edit / audio_edit, even in auto-edit mode.
    expect(createMcpServer(tools, { work: "ab12", agent: true })._registeredTools.cut.annotations.destructiveHint).toBe(false);
  });
  it("sends meta to MCP clients next to a custom text", () => {
    const result = toMcpResult({ text: "body", data: { sha256: "x", big: 1 }, meta: { sha256: "x" } });
    expect(result.content.map((item) => item.text)).toEqual(["body", '{"sha256":"x"}']);
    expect(result.structuredContent).toBeUndefined();
  });
});
