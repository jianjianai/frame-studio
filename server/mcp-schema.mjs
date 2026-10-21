/**
 * Tool input schemas as external MCP clients receive them: the common subset of JSON Schema
 * (type, properties, required, items, enum, anyOf, min/max…) that function-calling APIs with
 * their own schema dialect (Gemini) accept. Gemini's client lists the tools and gives up when it
 * meets tuples (`prefixItems` with `items: false`), `$ref`, `const`, `oneOf` or `type: "null"`.
 * Arguments are still validated against the full zod schema.
 */
const DROPPED = new Set(["$schema", "$id", "$defs", "definitions", "additionalProperties", "propertyNames", "patternProperties", "unevaluatedProperties", "multipleOf", "prefixItems", "contentEncoding", "contentMediaType"]);

export function portableJsonSchema(root) {
  const defs = root.$defs ?? root.definitions ?? {};
  const convert = (schema, seen) => {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
    if (schema.$ref) {
      const name = schema.$ref.replace(/^#\/(\$defs|definitions)\//, "");
      const { $ref, ...rest } = schema;
      // A recursive definition (a JSON value) stays open: any value.
      if (seen.has(name) || !defs[name]) return convert(rest, seen);
      return convert({ ...defs[name], ...rest }, new Set(seen).add(name));
    }
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
      if (DROPPED.has(key)) continue;
      if (key === "properties") out.properties = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, convert(item, seen)]));
      else if (key === "items") {
        if (value && typeof value === "object") out.items = convert(value, seen);
      } else if (key === "anyOf" || key === "oneOf") {
        const options = value.map((item) => convert(item, seen));
        const nonNull = options.filter((item) => item.type !== "null");
        if (nonNull.length < options.length) out.nullable = true;
        if (nonNull.length === 1) Object.assign(out, nonNull[0]);
        else if (nonNull.length) out.anyOf = nonNull;
      } else if (key === "const") out.enum = [value];
      else if (key === "exclusiveMinimum") out.minimum ??= value;
      else if (key === "exclusiveMaximum") out.maximum ??= value;
      else if (key === "format") {
        if (["date-time", "date", "time"].includes(value)) out.format = value;
      } else if (key === "type" && Array.isArray(value)) {
        const types = value.filter((type) => type !== "null");
        if (types.length < value.length) out.nullable = true;
        if (types.length === 1) out.type = types[0];
        else out.anyOf = types.map((type) => ({ type }));
      } else out[key] = value;
    }
    // A tuple becomes an array of its item types, with its length.
    if (Array.isArray(schema.prefixItems) && !out.items) {
      const items = schema.prefixItems.map((item) => convert(item, seen));
      const types = [...new Set(items.map((item) => item.type))];
      out.items = types.length === 1 && types[0] ? { type: types[0] } : { anyOf: items };
      out.minItems ??= items.length;
      if (schema.items === false) out.maxItems ??= items.length;
    }
    if (out.type === "array" && !out.items) out.items = {};
    if (out.type === "null") delete out.type;
    return out;
  };
  return convert(root, new Set());
}

/** The same standard schema (validation unchanged) with a portable JSON Schema. */
export function withPortableJsonSchema(schema) {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      validate: (value) => standard.validate(value),
      jsonSchema: {
        input: (options) => portableJsonSchema(standard.jsonSchema.input(options)),
        output: (options) => portableJsonSchema(standard.jsonSchema.output(options)),
      },
    },
  };
}
