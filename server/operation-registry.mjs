import { z } from "zod";
import { operationContract, parseOperationResult } from "../src/contracts/platform.mjs";

/** Every transport uses this registry; duplicate names are a startup error. */
export function createOperationRegistry() {
  /** @type {Record<string, {description: string, schema: import("zod").ZodType, fn: (args: unknown) => unknown}>} */
  const registry = Object.create(null);
  /** @param {string} name @param {string} description @param {import("zod").ZodRawShape | import("zod").ZodType} shape @param {(args: unknown) => unknown} fn */
  const add = (name, description, shape, fn) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("Invalid operation name: " + name);
    if (Object.hasOwn(registry, name)) throw new Error("Duplicate operation: " + name);
    const schema = shape instanceof z.ZodType ? shape : z.strictObject(shape);
    const contract = operationContract(name);
    if (contract && schema !== contract.request) throw new Error("Use the shared operation contract: " + name);
    registry[name] = Object.freeze({ description, schema, fn });
  };
  /** @param {string} name @param {unknown} [args] */
  const call = async (name, args) => {
    if (typeof name !== "string" || !Object.hasOwn(registry, name))
      throw Object.assign(new Error("Unknown operation"), { statusCode: 404 });
    const op = registry[name];
    return parseOperationResult(name, await op.fn(op.schema.parse(args ?? {})));
  };
  return { registry, add, call };
}
