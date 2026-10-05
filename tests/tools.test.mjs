import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../server/tools/registry.mjs";

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
});
