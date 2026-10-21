import { describe, expect, it } from "vitest";
import { z } from "zod";
import { leanJsonSchema, portableJsonSchema, withLeanJsonSchema, withPortableJsonSchema } from "../server/mcp-schema.mjs";

describe("portable tool schemas", () => {
  it("keeps the common subset and rewrites the rest", () => {
    const value = z.lazy(() => z.union([z.string(), z.number(), z.null(), z.array(value), z.record(z.string(), value)]));
    const schema = z.strictObject({
      region: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
      gain: z.number().positive().multipleOf(0.5),
      note: z.string().nullable(),
      params: z.record(z.string(), value).optional(),
      url: z.url(),
      operations: z.array(z.discriminatedUnion("op", [z.strictObject({ op: z.literal("write"), path: z.string() }), z.strictObject({ op: z.literal("delete"), path: z.string() })])),
    });
    const portable = portableJsonSchema(z.toJSONSchema(schema));
    expect(JSON.stringify(portable)).not.toMatch(/"(additionalProperties|prefixItems|propertyNames|oneOf|const|multipleOf|exclusiveMinimum|\$ref|\$defs|\$schema)"|"type":"null"/);
    expect(portable.properties.region).toEqual({ type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 });
    expect(portable.properties.gain).toEqual({ type: "number", minimum: 0 });
    expect(portable.properties.note).toEqual({ type: "string", nullable: true });
    expect(portable.properties.params).toEqual({ type: "object" });
    expect(portable.properties.url).toEqual({ type: "string" });
    expect(portable.properties.operations.items.anyOf[0].properties.op).toEqual({ type: "string", enum: ["write"] });
    expect(portable.required).toEqual(["gain", "note", "url", "operations"]);
  });

  it("validates with the original schema", async () => {
    const wrapped = withPortableJsonSchema(z.strictObject({ count: z.int().min(1) }));
    expect((await wrapped["~standard"].validate({ count: 2 })).value).toEqual({ count: 2 });
    expect((await wrapped["~standard"].validate({ count: 2, extra: 1 })).issues).toBeTruthy();
    expect(wrapped["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toEqual({ type: "object", properties: { count: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, required: ["count"] });
  });
});

describe("lean tool schemas for the studio's own agents", () => {
  it("drops what only validation needs and keeps the rest of the schema", () => {
    const schema = z.strictObject({
      pattern: z.string().min(1).max(500).regex(/^\w+$/).describe("搜索的文字"),
      region: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
      format: z.enum(["jpeg", "png"]).default("jpeg"),
      params: z.record(z.string(), z.number()).optional(),
      operations: z.array(z.discriminatedUnion("op", [z.strictObject({ op: z.literal("write"), path: z.string().max(300) }), z.strictObject({ op: z.literal("delete"), path: z.string() })])),
    });
    const lean = leanJsonSchema(z.toJSONSchema(schema, { io: "input" }));
    expect(JSON.stringify(lean)).not.toMatch(/"(\$schema|minLength|maxLength)"|"pattern":"|"additionalProperties":false/);
    // A property named like a keyword is kept, with its description.
    expect(lean.properties.pattern).toEqual({ type: "string", description: "搜索的文字" });
    expect(lean.properties.region.prefixItems).toHaveLength(2);
    expect(lean.properties.format).toEqual({ type: "string", enum: ["jpeg", "png"], default: "jpeg" });
    expect(lean.properties.params.additionalProperties).toEqual({ type: "number" });
    expect(lean.properties.operations.items.oneOf[0].properties.op).toEqual({ type: "string", const: "write" });
    expect(lean.required).toEqual(["pattern", "operations"]);
  });

  it("validates with the original schema", async () => {
    const wrapped = withLeanJsonSchema(z.strictObject({ name: z.string().max(3) }));
    expect((await wrapped["~standard"].validate({ name: "abcd" })).issues).toBeTruthy();
    expect((await wrapped["~standard"].validate({ name: "ab", extra: 1 })).issues).toBeTruthy();
    expect(wrapped["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toEqual({ type: "object", properties: { name: { type: "string" } }, required: ["name"] });
  });
});
