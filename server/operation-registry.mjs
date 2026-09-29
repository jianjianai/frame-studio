import { z } from "zod";

/** Every transport uses this registry; duplicate names are a startup error. */
export function createOperationRegistry() {
  const registry = Object.create(null);
  const add = (name, description, shape, fn) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("Invalid operation name: " + name);
    if (Object.hasOwn(registry, name)) throw new Error("Duplicate operation: " + name);
    const schema = shape instanceof z.ZodType ? shape : z.strictObject(shape);
    registry[name] = Object.freeze({ description, schema, fn });
  };
  const call = async (name, args) => {
    if (typeof name !== "string" || !Object.hasOwn(registry, name))
      throw Object.assign(new Error("Unknown operation"), { statusCode: 404 });
    const op = registry[name];
    return op.fn(op.schema.parse(args ?? {}));
  };
  return { registry, add, call };
}
