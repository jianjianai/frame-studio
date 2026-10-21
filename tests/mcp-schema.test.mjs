import { describe, expect, it } from "vitest";
import { z } from "zod";
import { portableJsonSchema, withPortableJsonSchema } from "../server/mcp-schema.mjs";

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
